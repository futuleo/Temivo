import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import { AiInfrastructureError } from './ai-errors';
import type { AiKeyCodec } from './ai-key-protection';
import { assertAiKey, isRecord, parseAiProviderConfig, sameAiDestination } from './ai-provider-config';
import type { AiProviderConfig } from './ai-provider-config';

export interface AiSettingsSummary {
  config: AiProviderConfig | null;
  /** Indicates an encrypted credential exists, not that it can currently be unlocked. */
  hasKey: boolean;
}

interface StoredSettings {
  version: 1;
  config: AiProviderConfig;
  encryptedKey: string | null;
}

/** Injected filesystem operations allow isolated failure tests; use one store per path in main. */
export interface AiSettingsFiles {
  open: typeof open;
  rename: typeof rename;
  unlink: typeof unlink;
}

const maximumFileBytes = 64 * 1024;
const maximumCiphertextBytes = 24 * 1024;

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function parseStoredSettings(value: unknown): StoredSettings {
  try {
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      Object.keys(value).some((key) => !['version', 'config', 'encryptedKey'].includes(key)) ||
      (value.encryptedKey !== null && (
        typeof value.encryptedKey !== 'string' ||
        value.encryptedKey.length === 0 ||
        value.encryptedKey.length > maximumCiphertextBytes * 4 / 3 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.encryptedKey)
      ))
    ) {
      throw new AiInfrastructureError('SETTINGS_CORRUPT');
    }
    return { version: 1, config: parseAiProviderConfig(value.config), encryptedKey: value.encryptedKey };
  } catch {
    throw new AiInfrastructureError('SETTINGS_CORRUPT');
  }
}

export class AiSettingsStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly codec: AiKeyCodec,
    private readonly files: AiSettingsFiles = { open, rename, unlink },
  ) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    // A failed operation must not poison later reads or updates.
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read(): Promise<StoredSettings | null> {
    let file: FileHandle;
    let result: StoredSettings;
    let closeFailed = false;
    try {
      file = await this.files.open(this.filePath, 'r');
    } catch (error) {
      if (isMissing(error)) return null;
      throw new AiInfrastructureError('SETTINGS_READ');
    }
    try {
      const buffer = Buffer.alloc(maximumFileBytes + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > maximumFileBytes) throw new AiInfrastructureError('SETTINGS_CORRUPT');
      try {
        result = parseStoredSettings(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total))));
      } catch {
        throw new AiInfrastructureError('SETTINGS_CORRUPT');
      }
    } catch (error) {
      if (error instanceof AiInfrastructureError) throw error;
      throw new AiInfrastructureError('SETTINGS_READ');
    } finally {
      try {
        await file.close();
      } catch {
        closeFailed = true;
      }
    }
    if (closeFailed) throw new AiInfrastructureError('SETTINGS_READ');
    return result;
  }

  private async write(settings: StoredSettings): Promise<void> {
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    let file: FileHandle | undefined;
    let created = false;
    try {
      file = await this.files.open(temporaryPath, 'wx', 0o600);
      created = true;
      await file.writeFile(JSON.stringify(settings), 'utf8');
      await file.sync();
      await file.close();
      file = undefined;
      await this.files.rename(temporaryPath, this.filePath);
    } catch {
      // Only remove the temporary file this operation created, never the existing settings.
      try {
        await file?.close();
        if (created) await this.files.unlink(temporaryPath);
      } catch {
        // The primary write failure remains explicit even if temporary-file cleanup also fails.
      }
      throw new AiInfrastructureError('SETTINGS_WRITE');
    }
  }

  summary(): Promise<AiSettingsSummary> {
    return this.exclusive(async () => {
      const stored = await this.read();
      return { config: stored?.config ?? null, hasKey: stored?.encryptedKey != null };
    });
  }

  /** undefined keeps a same-destination key; null removes it; a string replaces it, write-only. */
  update(configInput: unknown, keyUpdate?: unknown): Promise<AiSettingsSummary> {
    return this.exclusive(async () => {
      const config = parseAiProviderConfig(configInput);
      if (keyUpdate !== undefined && keyUpdate !== null) assertAiKey(keyUpdate);
      const previous = await this.read();
      let encryptedKey = previous && sameAiDestination(previous.config, config) ? previous.encryptedKey : null;
      if (keyUpdate === null) encryptedKey = null;
      if (typeof keyUpdate === 'string') {
        let ciphertext: Buffer;
        try {
          ciphertext = await this.codec.encrypt(JSON.stringify({
            provider: config.provider, endpoint: config.endpoint, key: keyUpdate,
          }));
        } catch (error) {
          if (error instanceof AiInfrastructureError && error.code === 'PROTECTION_UNAVAILABLE') throw error;
          throw new AiInfrastructureError('ENCRYPTION_FAILED');
        }
        if (ciphertext.length === 0 || ciphertext.length > maximumCiphertextBytes) {
          throw new AiInfrastructureError('ENCRYPTION_FAILED');
        }
        encryptedKey = ciphertext.toString('base64');
      }
      await this.write({ version: 1, config, encryptedKey });
      return { config, hasKey: encryptedKey !== null };
    });
  }

  /** Main-private only: never expose this method or its return value through IPC/preload. */
  readForRequest(): Promise<{ config: AiProviderConfig; key: string }> {
    return this.exclusive(async () => {
      const stored = await this.read();
      if (!stored?.encryptedKey) throw new AiInfrastructureError('KEY_MISSING');
      let plaintext: string;
      try {
        plaintext = await this.codec.decrypt(Buffer.from(stored.encryptedKey, 'base64'));
      } catch (error) {
        if (error instanceof AiInfrastructureError && error.code === 'PROTECTION_UNAVAILABLE') throw error;
        throw new AiInfrastructureError('DECRYPTION_FAILED');
      }
      try {
        const secret: unknown = JSON.parse(plaintext);
        if (
          !isRecord(secret) ||
          secret.provider !== stored.config.provider ||
          secret.endpoint !== stored.config.endpoint
        ) {
          throw new AiInfrastructureError('DECRYPTION_FAILED');
        }
        assertAiKey(secret.key);
        return { config: stored.config, key: secret.key };
      } catch {
        throw new AiInfrastructureError('DECRYPTION_FAILED');
      }
    });
  }
}
