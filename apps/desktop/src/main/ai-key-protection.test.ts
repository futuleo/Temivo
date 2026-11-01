import { describe, expect, it, vi } from 'vitest';

import { createAiKeyCodec } from './ai-key-protection';

function fakeStorage() {
  return {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptStringAsync: vi.fn(async () => Buffer.from('fake-opaque-ciphertext')),
    decryptStringAsync: vi.fn(async () => ({ result: 'synthetic-nonworking-key', shouldReEncrypt: false })),
  };
}

describe('async protected key codec (injected, no Electron runtime)', () => {
  it.each(['darwin', 'win32'] as const)('uses only async safeStorage on %s and stays lazy', async (platform) => {
    const storage = fakeStorage();
    const codec = createAiKeyCodec(storage, platform);
    expect(storage.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
    expect(await codec.encrypt('synthetic-nonworking-key')).toEqual(Buffer.from('fake-opaque-ciphertext'));
    expect(storage.encryptStringAsync).toHaveBeenCalledWith('synthetic-nonworking-key');
    expect(await codec.decrypt(Buffer.from('fake-opaque-ciphertext'))).toBe('synthetic-nonworking-key');
    expect(storage.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(2);
  });

  it('fails closed on Linux without inferring the async backend or enabling plaintext', async () => {
    const storage = fakeStorage();
    const codec = createAiKeyCodec(storage, 'linux');
    await expect(codec.encrypt('synthetic-nonworking-key')).rejects.toMatchObject({ code: 'PROTECTION_UNAVAILABLE' });
    await expect(codec.decrypt(Buffer.from('fake-opaque-ciphertext'))).rejects.toMatchObject({ code: 'PROTECTION_UNAVAILABLE' });
    expect(storage.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
    expect(storage.encryptStringAsync).not.toHaveBeenCalled();
    expect(storage.decryptStringAsync).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'failed'])('reports %s protection explicitly', async (failure) => {
    const storage = fakeStorage();
    if (failure === 'unavailable') storage.isAsyncEncryptionAvailable.mockResolvedValue(false);
    else storage.isAsyncEncryptionAvailable.mockRejectedValue(new Error('private Keychain detail'));
    const codec = createAiKeyCodec(storage, 'darwin');
    await expect(codec.encrypt('synthetic-nonworking-key')).rejects.toMatchObject({ code: 'PROTECTION_UNAVAILABLE' });
    await expect(codec.decrypt(Buffer.from('fixture'))).rejects.toMatchObject({ code: 'PROTECTION_UNAVAILABLE' });
    expect(storage.encryptStringAsync).not.toHaveBeenCalled();
    expect(storage.decryptStringAsync).not.toHaveBeenCalled();
  });

  it('sanitizes encryption/decryption errors and rejects empty ciphertext', async () => {
    const storage = fakeStorage();
    const codec = createAiKeyCodec(storage, 'darwin');
    storage.encryptStringAsync.mockRejectedValue(new Error('private synthetic-nonworking-key'));
    await expect(codec.encrypt('synthetic-nonworking-key')).rejects.toMatchObject({
      code: 'ENCRYPTION_FAILED', message: 'Unable to protect the AI credential.',
    });
    storage.encryptStringAsync.mockResolvedValue(Buffer.alloc(0));
    await expect(codec.encrypt('synthetic-nonworking-key')).rejects.toMatchObject({ code: 'ENCRYPTION_FAILED' });
    storage.decryptStringAsync.mockRejectedValue(new Error('private Keychain error'));
    await expect(codec.decrypt(Buffer.from('fixture'))).rejects.toMatchObject({
      code: 'DECRYPTION_FAILED', message: 'Unable to unlock the AI credential.',
    });
  });

  it('honors Electron rotation guidance once and rejects persistent rotation uncertainty', async () => {
    const storage = fakeStorage();
    const codec = createAiKeyCodec(storage, 'darwin');
    storage.decryptStringAsync.mockResolvedValueOnce({ result: 'old-fixture', shouldReEncrypt: true });
    expect(await codec.decrypt(Buffer.from('fixture'))).toBe('synthetic-nonworking-key');
    expect(storage.decryptStringAsync).toHaveBeenCalledTimes(2);
    storage.decryptStringAsync.mockClear().mockResolvedValue({ result: 'old-fixture', shouldReEncrypt: true });
    await expect(codec.decrypt(Buffer.from('fixture'))).rejects.toMatchObject({ code: 'DECRYPTION_FAILED' });
    expect(storage.decryptStringAsync).toHaveBeenCalledTimes(2);
  });
});
