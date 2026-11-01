import type { SafeStorage } from 'electron';

import { AiInfrastructureError } from './ai-errors';

export interface AiKeyCodec {
  encrypt(plaintext: string): Promise<Buffer>;
  decrypt(ciphertext: Buffer): Promise<string>;
}

type AsyncSafeStorage = Pick<SafeStorage,
  'isAsyncEncryptionAvailable' | 'encryptStringAsync' | 'decryptStringAsync'>;

/** Inject Electron safeStorage only from main, after app readiness; construction performs no key operations. */
export function createAiKeyCodec(storage: AsyncSafeStorage, platform: NodeJS.Platform): AiKeyCodec {
  const requireProtection = async (): Promise<void> => {
    // Electron's Linux backend getter does not identify the async encryptor's backend.
    // Fail closed rather than treating an unknown/basic-text fallback as protected.
    if (platform !== 'darwin' && platform !== 'win32') {
      throw new AiInfrastructureError('PROTECTION_UNAVAILABLE');
    }
    try {
      if (await storage.isAsyncEncryptionAvailable()) return;
    } catch {
      throw new AiInfrastructureError('PROTECTION_UNAVAILABLE');
    }
    throw new AiInfrastructureError('PROTECTION_UNAVAILABLE');
  };
  return {
    async encrypt(plaintext) {
      await requireProtection();
      try {
        const encrypted = await storage.encryptStringAsync(plaintext);
        if (encrypted.length === 0) throw new AiInfrastructureError('ENCRYPTION_FAILED');
        return encrypted;
      } catch {
        throw new AiInfrastructureError('ENCRYPTION_FAILED');
      }
    },
    async decrypt(ciphertext) {
      await requireProtection();
      try {
        const decrypted = await storage.decryptStringAsync(ciphertext);
        // Electron requests another decrypt after rotation; do not loop indefinitely.
        if (decrypted.shouldReEncrypt) {
          const refreshed = await storage.decryptStringAsync(ciphertext);
          if (refreshed.shouldReEncrypt) throw new AiInfrastructureError('DECRYPTION_FAILED');
          return refreshed.result;
        }
        return decrypted.result;
      } catch {
        throw new AiInfrastructureError('DECRYPTION_FAILED');
      }
    },
  };
}
