import { mkdtemp, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiInfrastructureError } from './ai-errors';
import { createAiKeyCodec } from './ai-key-protection';
import { AiSettingsStore } from './ai-settings-store';
import type { AiSettingsFiles } from './ai-settings-store';

const config = {
  provider: 'openai-compatible', endpoint: 'https://provider.invalid/v1', model: 'user-selected-model',
};
const key = 'synthetic-nonworking-test-key';
let directory: string;
let path: string;

function fakeCodec() {
  const plaintexts = new Map<string, string>();
  return {
    encrypt: vi.fn(async (plaintext: string) => {
      const ciphertext = `fake-opaque-ciphertext-${plaintexts.size}`;
      plaintexts.set(ciphertext, plaintext);
      return Buffer.from(ciphertext);
    }),
    decrypt: vi.fn(async (ciphertext: Buffer) => {
      const plaintext = plaintexts.get(ciphertext.toString());
      if (plaintext === undefined) throw new Error('Unknown fixture ciphertext.');
      return plaintext;
    }),
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'temivo-ai-test-'));
  path = join(directory, 'settings.json');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('main-only AI settings (fresh temporary paths and fake protection)', () => {
  it('lists unconfigured settings without creating files or touching key protection', async () => {
    const codec = fakeCodec();
    const store = new AiSettingsStore(path, codec);
    expect(await store.summary()).toEqual({ config: null, hasKey: false });
    expect(await readdir(directory)).toEqual([]);
    expect(codec.encrypt).not.toHaveBeenCalled();
    expect(codec.decrypt).not.toHaveBeenCalled();
    await expect(store.readForRequest()).rejects.toMatchObject({ code: 'KEY_MISSING' });
  });

  it('writes and reloads metadata without invoking key protection', async () => {
    const codec = fakeCodec();
    const store = new AiSettingsStore(path, codec);
    expect(await store.update(config)).toEqual({ config, hasKey: false });
    expect(await new AiSettingsStore(path, codec).summary()).toEqual({ config, hasKey: false });
    expect(codec.encrypt).not.toHaveBeenCalled();
    expect(codec.decrypt).not.toHaveBeenCalled();
  });

  it('writes only ciphertext, restricts permissions, and exposes only a serializable summary', async () => {
    const codec = fakeCodec();
    const store = new AiSettingsStore(path, codec);
    const summary = await store.update(config, key);
    expect(summary).toEqual({ config, hasKey: true });
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    const disk = await readFile(path, 'utf8');
    expect(disk).not.toContain(key);
    expect(disk).not.toContain(Buffer.from(key).toString('base64'));
    expect(JSON.stringify(summary)).not.toContain('encryptedKey');
    expect(JSON.stringify(summary)).not.toContain('ciphertext');
    expect(codec.decrypt).not.toHaveBeenCalled();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await new AiSettingsStore(path, codec).readForRequest()).toEqual({ config, key });
    expect(await readdir(directory)).toEqual(['settings.json']);
  });

  it('preserves same-destination credentials on model edits and normalized base URLs', async () => {
    const codec = fakeCodec();
    const store = new AiSettingsStore(path, codec);
    await store.update(config, key);
    const updated = { ...config, model: 'another-user-selected-model' };
    expect(await store.update({ ...updated, endpoint: 'https://PROVIDER.invalid:443/v1/' }))
      .toEqual({ config: updated, hasKey: true });
    expect(await store.readForRequest()).toEqual({ config: updated, key });
    expect(codec.encrypt).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, 'replacement-synthetic-nonworking-key'])(
    'rejects oversized normalized endpoints without changing saved settings or key binding %#', async (keyUpdate) => {
      const codec = fakeCodec();
      const store = new AiSettingsStore(path, codec);
      const summary = await store.update(config, key);
      const saved = await readFile(path);
      const endpoint = 'https://provider.invalid/' + '\u00e9'.repeat(400);
      await expect(store.update({ ...config, endpoint }, keyUpdate)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      expect(await readFile(path)).toEqual(saved);
      const reloaded = new AiSettingsStore(path, codec);
      expect(await reloaded.summary()).toEqual(summary);
      expect(await reloaded.readForRequest()).toEqual({ config, key });
      expect(codec.encrypt).toHaveBeenCalledOnce();
    },
  );

  it('persists and reloads an accepted Unicode endpoint at the normalized length bound', async () => {
    const unicodeEndpoint = 'https://provider.invalid/' + '\u00e9'.repeat(300);
    const endpoint = unicodeEndpoint + 'x'.repeat(2048 - new URL(unicodeEndpoint).href.length);
    const expectedConfig = { ...config, endpoint: new URL(endpoint).href };
    const codec = fakeCodec();
    expect(expectedConfig.endpoint).toHaveLength(2048);
    const summary = await new AiSettingsStore(path, codec).update({ ...config, endpoint }, key);
    expect(summary).toEqual({ config: expectedConfig, hasKey: true });
    const reloaded = new AiSettingsStore(path, codec);
    expect(await reloaded.summary()).toEqual(summary);
    expect(await reloaded.readForRequest()).toEqual({ config: expectedConfig, key });
  });

  it.each([
    { ...config, provider: 'anthropic' },
    { ...config, endpoint: 'https://another-provider.invalid/v1' },
    { ...config, endpoint: 'https://provider.invalid/other-prefix' },
    { ...config, endpoint: 'https://provider.invalid:8443/v1' },
  ])('drops old credentials when the provider or endpoint changes %#', async (updated) => {
    const codec = fakeCodec();
    const store = new AiSettingsStore(path, codec);
    await store.update(config, key);
    expect(await store.update(updated)).toEqual({ config: updated, hasKey: false });
    await expect(store.readForRequest()).rejects.toMatchObject({ code: 'KEY_MISSING' });
    expect(codec.decrypt).not.toHaveBeenCalled();
  });

  it('can atomically change destination with a new explicit key, or remove the key', async () => {
    const codec = fakeCodec();
    const store = new AiSettingsStore(path, codec);
    await store.update(config, key);
    const updated = { ...config, provider: 'anthropic' };
    await store.update(updated, 'different-synthetic-nonworking-key');
    expect(await store.readForRequest()).toEqual({ config: updated, key: 'different-synthetic-nonworking-key' });
    expect(await store.update(updated, null)).toEqual({ config: updated, hasKey: false });
    await expect(store.readForRequest()).rejects.toMatchObject({ code: 'KEY_MISSING' });
  });

  it('detects a ciphertext transplanted to a different configured destination', async () => {
    const codec = fakeCodec();
    const store = new AiSettingsStore(path, codec);
    await store.update(config, key);
    const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof saved !== 'object' || saved === null) throw new Error('Expected fixture object.');
    await writeFile(path, JSON.stringify({ ...saved, config: { ...config, endpoint: 'https://other.invalid' } }));
    await expect(store.readForRequest()).rejects.toMatchObject({ code: 'DECRYPTION_FAILED' });
  });

  it.each([
    'malformed', 'null', '{"version":2}', JSON.stringify({ version: 1, config, encryptedKey: 'not-base64' }),
    JSON.stringify({ version: 1, config, encryptedKey: '' }),
    JSON.stringify({ version: 1, config, encryptedKey: null, unexpected: true }),
    JSON.stringify({ version: 1, config: { ...config, endpoint: 'http://remote.invalid' }, encryptedKey: null }),
    'x'.repeat(64 * 1024 + 1),
  ])('reports corrupt/unsupported settings and never overwrites them %#', async (corrupt) => {
    await writeFile(path, corrupt);
    const store = new AiSettingsStore(path, fakeCodec());
    await expect(store.summary()).rejects.toMatchObject({ code: 'SETTINGS_CORRUPT' });
    await expect(store.update(config, key)).rejects.toMatchObject({ code: 'SETTINGS_CORRUPT' });
    expect(await readFile(path, 'utf8')).toBe(corrupt);
  });

  it.each(['', 'fixture\nheader', 42, {}])('rejects invalid key updates without changing the existing file %#', async (invalid) => {
    const store = new AiSettingsStore(path, fakeCodec());
    await store.update(config, key);
    const before = await readFile(path, 'utf8');
    await expect(store.update(config, invalid)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('preserves settings after invalid config and encryption failures, then permits a later update', async () => {
    const codec = fakeCodec();
    const store = new AiSettingsStore(path, codec);
    await store.update(config, key);
    const before = await readFile(path, 'utf8');
    await expect(store.update({ ...config, model: '' }, key)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    codec.encrypt.mockRejectedValueOnce(new Error(`private detail ${key}`));
    await expect(store.update(config, 'new-synthetic-key')).rejects.toMatchObject({
      code: 'ENCRYPTION_FAILED', message: 'Unable to protect the AI credential.',
    });
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await store.readForRequest()).toEqual({ config, key });
    await store.update(config, 'new-synthetic-key');
    expect(await store.readForRequest()).toEqual({ config, key: 'new-synthetic-key' });
  });

  it('preserves the original destination and key when a destination/key replacement fails', async () => {
    const codec = fakeCodec();
    const store = new AiSettingsStore(path, codec);
    await store.update(config, key);
    codec.encrypt.mockRejectedValueOnce(new AiInfrastructureError('PROTECTION_UNAVAILABLE'));
    await expect(store.update({ ...config, provider: 'anthropic' }, 'new-synthetic-key'))
      .rejects.toMatchObject({ code: 'PROTECTION_UNAVAILABLE' });
    expect(await store.summary()).toEqual({ config, hasKey: true });
    expect(await store.readForRequest()).toEqual({ config, key });
  });

  it.each([Buffer.alloc(0), Buffer.alloc(24 * 1024 + 1)])('rejects unusable codec ciphertext %#', async (ciphertext) => {
    const codec = fakeCodec();
    const store = new AiSettingsStore(path, codec);
    await store.update(config, key);
    const before = await readFile(path, 'utf8');
    codec.encrypt.mockResolvedValue(ciphertext);
    await expect(store.update(config, 'new-synthetic-key')).rejects.toMatchObject({ code: 'ENCRYPTION_FAILED' });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('returns an unavailable error, never falls back to plaintext, and can still save/list metadata', async () => {
    const storage = {
      isAsyncEncryptionAvailable: vi.fn(async () => false),
      encryptStringAsync: vi.fn(async () => Buffer.from('unused-fixture')),
      decryptStringAsync: vi.fn(async () => ({ result: key, shouldReEncrypt: false })),
    };
    const store = new AiSettingsStore(path, createAiKeyCodec(storage, 'darwin'));
    await store.update(config);
    expect(await store.summary()).toEqual({ config, hasKey: false });
    expect(storage.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
    const before = await readFile(path, 'utf8');
    await expect(store.update(config, key)).rejects.toMatchObject({ code: 'PROTECTION_UNAVAILABLE' });
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(storage.encryptStringAsync).not.toHaveBeenCalled();
  });

  it('sanitizes decryption failures without deleting existing ciphertext', async () => {
    const codec = fakeCodec();
    const store = new AiSettingsStore(path, codec);
    await store.update(config, key);
    const before = await readFile(path, 'utf8');
    codec.decrypt.mockRejectedValueOnce(new Error(`private detail ${key}`));
    await expect(store.readForRequest()).rejects.toMatchObject({
      code: 'DECRYPTION_FAILED', message: 'Unable to unlock the AI credential.',
    });
    codec.decrypt.mockRejectedValueOnce(new AiInfrastructureError('PROTECTION_UNAVAILABLE'));
    await expect(store.readForRequest()).rejects.toMatchObject({ code: 'PROTECTION_UNAVAILABLE' });
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await store.summary()).toEqual({ config, hasKey: true });
  });

  it.each(['not JSON', '{}', JSON.stringify({ provider: config.provider, endpoint: config.endpoint, key: '' })])(
    'rejects corrupted decrypted envelopes %#', async (plaintext) => {
      const codec = fakeCodec();
      const store = new AiSettingsStore(path, codec);
      await store.update(config, key);
      codec.decrypt.mockResolvedValue(plaintext);
      await expect(store.readForRequest()).rejects.toMatchObject({ code: 'DECRYPTION_FAILED' });
    },
  );

  it('sanitizes read failures rather than treating inaccessible data as absent', async () => {
    const files: AiSettingsFiles = {
      open: vi.fn<typeof open>().mockRejectedValue(new Error(`private path ${key}`)), rename, unlink,
    };
    const store = new AiSettingsStore(path, fakeCodec(), files);
    await expect(store.summary()).rejects.toMatchObject({ code: 'SETTINGS_READ', message: 'Unable to read AI settings.' });
    await expect(store.update(config)).rejects.toMatchObject({ code: 'SETTINGS_READ' });
  });

  it.each(['read', 'close'] as const)('reports a file %s failure without accepting partial settings', async (method) => {
    const codec = fakeCodec();
    await new AiSettingsStore(path, codec).update(config, key);
    const before = await readFile(path, 'utf8');
    const files: AiSettingsFiles = {
      open: async (filePath, flags, mode) => {
        const handle = await open(filePath, flags, mode);
        if (flags === 'r') {
          if (method === 'close') {
            const close = handle.close.bind(handle);
            vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
              await close();
              throw new Error('synthetic close failure');
            });
          } else {
            vi.spyOn(handle, 'read').mockRejectedValueOnce(new Error('synthetic read failure'));
          }
        }
        return handle;
      },
      rename, unlink,
    };
    const store = new AiSettingsStore(path, codec, files);
    await expect(store.summary()).rejects.toMatchObject({ code: 'SETTINGS_READ' });
    await expect(store.update(config, null)).rejects.toMatchObject({ code: 'SETTINGS_READ' });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('preserves old settings on atomic rename failure and removes its temporary file', async () => {
    const codec = fakeCodec();
    await new AiSettingsStore(path, codec).update(config, key);
    const before = await readFile(path, 'utf8');
    const files: AiSettingsFiles = {
      open, rename: vi.fn<typeof rename>().mockRejectedValue(new Error(`private write detail ${key}`)), unlink,
    };
    await expect(new AiSettingsStore(path, codec, files).update(config, 'new-synthetic-key')).rejects.toMatchObject({
      code: 'SETTINGS_WRITE', message: 'Unable to save AI settings.',
    });
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await readdir(directory)).toEqual(['settings.json']);
    expect(await new AiSettingsStore(path, codec).readForRequest()).toEqual({ config, key });
  });

  it.each(['writeFile', 'sync', 'close'] as const)('preserves old settings if temporary %s fails', async (method) => {
    const codec = fakeCodec();
    await new AiSettingsStore(path, codec).update(config, key);
    const before = await readFile(path, 'utf8');
    const files: AiSettingsFiles = {
      open: async (filePath, flags, mode) => {
        const handle = await open(filePath, flags, mode);
        if (flags === 'wx') vi.spyOn(handle, method).mockRejectedValueOnce(new Error('synthetic filesystem failure'));
        return handle;
      },
      rename, unlink,
    };
    await expect(new AiSettingsStore(path, codec, files).update(config, null)).rejects.toMatchObject({ code: 'SETTINGS_WRITE' });
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await readdir(directory)).toEqual(['settings.json']);
  });

  it('serializes overlapping updates so a later model edit preserves the newly written key', async () => {
    const codec = fakeCodec();
    const store = new AiSettingsStore(path, codec);
    const updated = { ...config, model: 'later-user-selected-model' };
    await Promise.all([store.update(config, key), store.update(updated)]);
    expect(await store.readForRequest()).toEqual({ config: updated, key });
    expect(await readdir(directory)).toEqual(['settings.json']);
  });
});
