import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { beginGeneration, createMapLibrary, createTopicMap, editNode } from '@temivo/core';
import type { GenerationRequest } from '@temivo/core';

import { AI_CHANNELS } from '../shared/ai-api';
import type { DesktopResult, LibrarySnapshot } from '../shared/desktop-api';
import { AiInfrastructureError } from './ai-errors';
import { registerAiIpc } from './ai-ipc';
import { AiProviderTransport } from './ai-provider-transport';
import { AiSettingsStore } from './ai-settings-store';

const handlers = vi.hoisted(() =>
  new Map<string, (event: unknown, ...args: unknown[]) => Promise<DesktopResult<unknown>>>(),
);
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<DesktopResult<unknown>>) => {
      handlers.set(channel, handler);
    },
  },
}));

class Owner extends EventEmitter {
  mainFrame = {};
  destroyed = false;
  isDestroyed() { return this.destroyed; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const config = { provider: 'openai-compatible', endpoint: 'https://provider.invalid/v1', model: 'chosen-model' } as const;
const key = 'synthetic-nonworking-ipc-fixture';
const reply = { changes: [{
  kind: 'upsert', target: { new: 'proposal' }, parent: { existing: 'root' }, text: 'Child', description: 'Details',
}] };

function setup() {
  const started = beginGeneration(createMapLibrary([
    createTopicMap('map', 'root', 'Topic'),
    createTopicMap('world', 'world-root', 'Private world'),
  ]), 'map', 'root');
  let snapshot: LibrarySnapshot = { revision: 1, library: started.library };
  const owner = new Owner();
  const other = new Owner();
  const trusted = new Set<object>([owner, other]);
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const repository = {
    loadLibrary: vi.fn(async () => snapshot),
    saveLibrary: vi.fn(),
  };
  const settings = {
    summary: vi.fn(async () => ({ config: null, hasKey: false })),
    update: vi.fn<AiSettingsStore['update']>().mockResolvedValue({ config, hasKey: true }),
    readForRequest: vi.fn(async () => ({ config, key })),
  };
  const transport = {
    request: vi.fn<(_config: unknown, _key: unknown, _prompt: unknown, signal?: AbortSignal) => Promise<unknown>>()
      .mockResolvedValue(reply),
  };
  const createId = vi.fn(() => 'main-generated-id');
  const service = registerAiIpc({ repository, settings, transport, createId }, (candidate) =>
    trusted.has(candidate.sender) && !candidate.sender.isDestroyed() &&
    candidate.senderFrame === candidate.sender.mainFrame,
  );
  services.push(service);
  const invoke = (channel: string, ...args: unknown[]) => invokeAs(event, channel, ...args);
  return {
    request: started.request, owner, other, event, trusted, repository, settings, transport, createId, service, invoke,
    current: () => snapshot,
    persist: (library: LibrarySnapshot['library']) => { snapshot = { revision: snapshot.revision + 1, library }; },
  };
}

function invokeAs(event: unknown, channel: string, ...args: unknown[]): Promise<DesktopResult<unknown>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error('Missing fixture channel.');
  return handler(event, ...args);
}

const services: ReturnType<typeof registerAiIpc>[] = [];
beforeEach(() => {
  handlers.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.restoreAllMocks();
});

describe('fixed AI channels and settings boundary (mocked Electron)', () => {
  it('registers only four channels and authorizes every channel before any dependency access', async () => {
    const f = setup();
    expect([...handlers.keys()].sort()).toEqual(Object.values(AI_CHANNELS).sort());
    const foreign = new Owner();
    for (const channel of Object.values(AI_CHANNELS)) {
      for (const event of [
        { sender: f.owner, senderFrame: {} },
        { sender: f.owner, senderFrame: null },
        { sender: foreign, senderFrame: foreign.mainFrame },
      ]) {
        expect(await invokeAs(event, channel, f.request)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
      }
    }
    expect(f.repository.loadLibrary).not.toHaveBeenCalled();
    expect(f.repository.saveLibrary).not.toHaveBeenCalled();
    expect(f.settings.summary).not.toHaveBeenCalled();
    expect(f.settings.update).not.toHaveBeenCalled();
    expect(f.settings.readForRequest).not.toHaveBeenCalled();
    expect(f.transport.request).not.toHaveBeenCalled();
    expect(f.createId).not.toHaveBeenCalled();
  });

  it('gets nonsecret metadata and maps explicit keep/remove/replace without exposing key actions', async () => {
    const f = setup();
    expect(await f.invoke(AI_CHANNELS.getSettings)).toEqual({ ok: true, value: { config: null, hasKey: false } });
    for (const [keyAction, update] of [
      [{ kind: 'keep' }, undefined],
      [{ kind: 'remove' }, null],
      [{ kind: 'replace', key }, key],
    ]) {
      const result = await f.invoke(AI_CHANNELS.updateSettings, { config, keyAction });
      expect(f.settings.update).toHaveBeenLastCalledWith(config, update);
      expect(result).toEqual({ ok: true, value: { config, hasKey: true } });
      expect(JSON.stringify(result)).not.toContain(key);
    }
    expect(f.settings.readForRequest).not.toHaveBeenCalled();
    expect(f.repository.loadLibrary).not.toHaveBeenCalled();
    expect(f.transport.request).not.toHaveBeenCalled();
  });

  it.each([
    undefined, null, {}, { config }, { config, keyAction: null },
    { config, keyAction: { kind: 'keep', key } },
    { config, keyAction: { kind: 'replace' } },
    { config, keyAction: { kind: 'replace', key: '' } },
    { config, keyAction: { kind: 'replace', key: 'bad\nkey' } },
    { config, keyAction: { kind: 'replace', key: 'x'.repeat(4097) } },
    { config: { ...config, provider: 'invented' }, keyAction: { kind: 'keep' } },
    { config, keyAction: { kind: 'remove' }, extra: true },
  ])('rejects malformed settings actions before settings access %#', async (input) => {
    const f = setup();
    expect(await f.invoke(AI_CHANNELS.updateSettings, input))
      .toMatchObject({ ok: false, error: { code: 'INVALID_CONFIG' } });
    expect(f.settings.update).not.toHaveBeenCalled();
  });

  it('enforces exact argument counts and rejects malformed cancellation before access', async () => {
    const f = setup();
    for (const [channel, ...args] of [
      [AI_CHANNELS.getSettings, 'extra'],
      [AI_CHANNELS.updateSettings, { config, keyAction: { kind: 'keep' } }, 'extra'],
      [AI_CHANNELS.generate, f.request, 'extra'],
      [AI_CHANNELS.cancelGeneration, 'map', 0],
      [AI_CHANNELS.cancelGeneration, 'map'],
      [AI_CHANNELS.cancelGeneration, 'map', 1, 'extra'],
    ]) {
      expect(await f.invoke(String(channel), ...args)).toMatchObject({ ok: false });
    }
    expect(f.settings.summary).not.toHaveBeenCalled();
    expect(f.settings.update).not.toHaveBeenCalled();
    expect(f.settings.readForRequest).not.toHaveBeenCalled();
    expect(f.repository.loadLibrary).not.toHaveBeenCalled();
  });

  it('uses the real settings store with only a fresh directory and fake codec for destination-bound actions', async () => {
    const f = setup();
    const directory = await mkdtemp(join(tmpdir(), 'temivo-ai-ipc-fixture-'));
    const plaintexts = new Map<string, string>();
    const codec = {
      encrypt: vi.fn(async (plaintext: string) => {
        const ciphertext = `fake-ciphertext-${plaintexts.size}`;
        plaintexts.set(ciphertext, plaintext);
        return Buffer.from(ciphertext);
      }),
      decrypt: vi.fn(async (ciphertext: Buffer) => {
        const plaintext = plaintexts.get(ciphertext.toString());
        if (plaintext === undefined) throw new Error('Unknown fixture ciphertext');
        return plaintext;
      }),
    };
    const store = new AiSettingsStore(join(directory, 'fixture-settings.json'), codec);
    const service = registerAiIpc({
      repository: f.repository, settings: store, transport: f.transport, createId: f.createId,
    }, () => true);
    services.push(service);
    try {
      expect(await f.invoke(AI_CHANNELS.getSettings)).toEqual({ ok: true, value: { config: null, hasKey: false } });
      expect(codec.encrypt).not.toHaveBeenCalled();
      expect(codec.decrypt).not.toHaveBeenCalled();
      expect(await f.invoke(AI_CHANNELS.updateSettings, { config, keyAction: { kind: 'replace', key } }))
        .toEqual({ ok: true, value: { config, hasKey: true } });
      const modelChange = { ...config, model: 'another-chosen-model' };
      expect(await f.invoke(AI_CHANNELS.updateSettings, { config: modelChange, keyAction: { kind: 'keep' } }))
        .toEqual({ ok: true, value: { config: modelChange, hasKey: true } });
      expect(codec.encrypt).toHaveBeenCalledOnce();
      expect(codec.decrypt).not.toHaveBeenCalled();
      expect(await f.invoke(AI_CHANNELS.updateSettings, { config, keyAction: { kind: 'remove' } }))
        .toEqual({ ok: true, value: { config, hasKey: false } });
      await f.invoke(AI_CHANNELS.updateSettings, { config, keyAction: { kind: 'replace', key } });
      const destination = { ...config, provider: 'anthropic', endpoint: 'https://different.invalid/v1' };
      expect(await f.invoke(AI_CHANNELS.updateSettings, { config: destination, keyAction: { kind: 'keep' } }))
        .toEqual({ ok: true, value: { config: destination, hasKey: false } });
      expect(codec.decrypt).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    'INVALID_CONFIG', 'KEY_MISSING', 'PROTECTION_UNAVAILABLE', 'ENCRYPTION_FAILED', 'DECRYPTION_FAILED',
    'SETTINGS_CORRUPT', 'SETTINGS_READ', 'SETTINGS_WRITE', 'AUTHENTICATION', 'RATE_LIMIT', 'NETWORK',
    'TIMEOUT', 'HTTP_ERROR', 'PROTOCOL', 'TRUNCATED', 'RESPONSE_TOO_LARGE', 'CANCELLED',
  ] as const)('returns fixed %s errors with no raw exception message or secret', async (code) => {
    const f = setup();
    const error = new AiInfrastructureError(code);
    error.message = `Private provider body and ${key} and /private/database.sqlite`;
    f.settings.readForRequest.mockRejectedValue(error);
    const result = await f.invoke(AI_CHANNELS.generate, f.request);
    expect(result).toEqual({ ok: false, error: { code, message: new AiInfrastructureError(code).message } });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(key);
  });

  it('sanitizes unexpected settings/provider and storage errors without logging raw values', async () => {
    const f = setup();
    const secretError = new Error(`Private details ${key} /private/database.sqlite`);
    f.settings.summary.mockRejectedValue(secretError);
    expect(await f.invoke(AI_CHANNELS.getSettings)).toEqual({
      ok: false, error: { code: 'AI_ERROR', message: 'Unable to complete the AI operation.' },
    });
    f.repository.loadLibrary.mockRejectedValue(secretError);
    expect(await f.invoke(AI_CHANNELS.generate, f.request)).toEqual({
      ok: false, error: { code: 'STORAGE_ERROR', message: 'Unable to access local maps.' },
    });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(key);
    expect(f.settings.readForRequest).not.toHaveBeenCalled();
  });
});

describe('authoritative generation and read-only proposals', () => {
  it.each(['openai-compatible', 'anthropic'] as const)(
    'integrates the actual %s transport with an injected fetch, never a socket or live provider', async (provider) => {
      const f = setup();
      const providerConfig = { ...config, provider };
      const output = JSON.stringify(reply);
      const envelope = provider === 'anthropic'
        ? { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: output }] }
        : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: output } }] };
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(envelope), {
        headers: { 'content-type': 'application/json' },
      }));
      const service = registerAiIpc({
        repository: f.repository,
        settings: { ...f.settings, readForRequest: vi.fn(async () => ({ config: providerConfig, key })) },
        transport: new AiProviderTransport({ fetch }),
        createId: f.createId,
      }, () => true);
      services.push(service);
      expect(await f.invoke(AI_CHANNELS.generate, f.request)).toEqual({ ok: true, value: [{
        kind: 'upsert', nodeId: 'main-generated-id', parentId: 'root', text: 'Child', description: 'Details',
      }] });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[0]).toBe(`${config.endpoint}/${provider === 'anthropic' ? 'messages' : 'chat/completions'}`);
      expect(f.repository.saveLibrary).not.toHaveBeenCalled();
      expect(f.transport.request).not.toHaveBeenCalled();
    },
  );

  it('validates storage before key/provider, returns typed changes only and never writes maps', async () => {
    const f = setup();
    const before = JSON.stringify(f.current());
    const result = await f.invoke(AI_CHANNELS.generate, f.request);
    expect(result).toEqual({ ok: true, value: [{
      kind: 'upsert', nodeId: 'main-generated-id', parentId: 'root', text: 'Child', description: 'Details',
    }] });
    expect(f.repository.loadLibrary).toHaveBeenCalledTimes(2);
    expect(f.repository.loadLibrary.mock.invocationCallOrder[0])
      .toBeLessThan(f.settings.readForRequest.mock.invocationCallOrder[0] ?? 0);
    expect(f.settings.readForRequest.mock.invocationCallOrder[0])
      .toBeLessThan(f.transport.request.mock.invocationCallOrder[0] ?? 0);
    const call = f.transport.request.mock.calls[0];
    expect(call?.[0]).toEqual(config);
    expect(call?.[1]).toBe(key);
    expect(JSON.stringify(call?.[2])).not.toContain('Private world');
    expect(JSON.stringify(call?.[2])).not.toContain('expectedSnapshot');
    expect(JSON.stringify(call?.[2])).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(f.repository.saveLibrary).not.toHaveBeenCalled();
    expect(JSON.stringify(f.current())).toBe(before);
    expect(f.owner.listenerCount('destroyed')).toBe(0);
    expect(f.owner.listenerCount('render-process-gone')).toBe(0);
    expect(await f.invoke(AI_CHANNELS.generate, f.request)).toMatchObject({
      ok: false, error: { code: 'STALE_GENERATION' },
    });
    expect(f.transport.request).toHaveBeenCalledOnce();
  });

  it.each([null, {}, [], { sequence: 0 }, { existingNodes: [null] }])(
    'rejects malformed generation before storage, key or provider %#', async (patch) => {
      const f = setup();
      const input = patch && !Array.isArray(patch) && Object.keys(patch).length > 0 ? { ...f.request, ...patch } : patch;
      expect(await f.invoke(AI_CHANNELS.generate, input)).toMatchObject({
        ok: false, error: { code: 'INVALID_REQUEST' },
      });
      expect(f.repository.loadLibrary).not.toHaveBeenCalled();
      expect(f.settings.readForRequest).not.toHaveBeenCalled();
      expect(f.transport.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    { topic: 'forged' }, { expectedSnapshot: 'forged' }, { existingNodes: [] }, { sequence: 2 },
    { context: { instructions: 'forged', detail: 'brief', depth: 1 } },
  ])('rejects exact snapshot tampering before unlocking or requesting %#', async (patch) => {
    const f = setup();
    expect(await f.invoke(AI_CHANNELS.generate, { ...f.request, ...patch })).toMatchObject({
      ok: false, error: { code: 'STALE_GENERATION' },
    });
    expect(f.settings.readForRequest).not.toHaveBeenCalled();
    expect(f.transport.request).not.toHaveBeenCalled();
  });

  it('rejects a begun request that renderer has not CAS-saved', async () => {
    const f = setup();
    const unsaved = beginGeneration(f.current().library, 'map', 'root');
    expect(await f.invoke(AI_CHANNELS.generate, unsaved.request)).toMatchObject({
      ok: false, error: { code: 'STALE_GENERATION' },
    });
    expect(f.settings.readForRequest).not.toHaveBeenCalled();
    expect(f.transport.request).not.toHaveBeenCalled();
  });

  it('rejects concurrent same-map edits against the latest persisted snapshot', async () => {
    const f = setup();
    const response = deferred<unknown>();
    f.transport.request.mockReturnValue(response.promise);
    const result = f.invoke(AI_CHANNELS.generate, f.request);
    await vi.waitFor(() => expect(f.transport.request).toHaveBeenCalledOnce());
    f.persist(editNode(f.current().library, 'map', 'root', { text: 'Concurrent user edit' }));
    response.resolve(reply);
    expect(await result).toMatchObject({ ok: false, error: { code: 'STALE_GENERATION' } });
    expect(f.createId).not.toHaveBeenCalled();
    expect(f.repository.saveLibrary).not.toHaveBeenCalled();
    expect(f.current().library.documents[0]?.map.nodes[0]?.text).toBe('Concurrent user edit');
  });

  it('permits unrelated world edits while generating, without overwriting them', async () => {
    const f = setup();
    const response = deferred<unknown>();
    f.transport.request.mockReturnValue(response.promise);
    const result = f.invoke(AI_CHANNELS.generate, f.request);
    await vi.waitFor(() => expect(f.transport.request).toHaveBeenCalledOnce());
    f.persist(editNode(f.current().library, 'world', 'world-root', { text: 'My independent edit' }));
    response.resolve({ changes: [] });
    expect(await result).toEqual({ ok: true, value: [] });
    expect(f.current().library.documents[1]?.map.nodes[0]?.text).toBe('My independent edit');
    expect(f.repository.saveLibrary).not.toHaveBeenCalled();
  });
});

describe('owner-bound cancellation, supersession and cleanup', () => {
  it('handles cancellation arriving before generate without storage/key/provider access', async () => {
    const f = setup();
    expect(await f.invoke(AI_CHANNELS.cancelGeneration, 'map', f.request.sequence)).toEqual({ ok: true, value: null });
    expect(await f.invoke(AI_CHANNELS.generate, f.request)).toMatchObject({
      ok: false, error: { code: 'CANCELLED' },
    });
    expect(f.repository.loadLibrary).not.toHaveBeenCalled();
    expect(f.settings.readForRequest).not.toHaveBeenCalled();
    expect(f.transport.request).not.toHaveBeenCalled();
  });

  it('handles cancellation during initial storage validation before decrypting', async () => {
    const f = setup();
    const read = deferred<LibrarySnapshot>();
    f.repository.loadLibrary.mockReturnValueOnce(read.promise);
    const result = f.invoke(AI_CHANNELS.generate, f.request);
    await f.invoke(AI_CHANNELS.cancelGeneration, 'map', f.request.sequence);
    read.resolve(f.current());
    expect(await result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(f.settings.readForRequest).not.toHaveBeenCalled();
  });

  it('reports shutdown as cancellation even if the outstanding initial storage read fails', async () => {
    const f = setup();
    const read = deferred<LibrarySnapshot>();
    f.repository.loadLibrary.mockReturnValueOnce(read.promise);
    const result = f.invoke(AI_CHANNELS.generate, f.request);
    f.service.dispose();
    read.reject(new Error('Private closed database fixture'));
    expect(await result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(f.settings.readForRequest).not.toHaveBeenCalled();
  });

  it('cancels while unlocking without waiting for a stuck codec or starting the provider', async () => {
    const f = setup();
    const unlocked = deferred<{ config: typeof config; key: string }>();
    f.settings.readForRequest.mockReturnValue(unlocked.promise);
    const result = f.invoke(AI_CHANNELS.generate, f.request);
    await vi.waitFor(() => expect(f.settings.readForRequest).toHaveBeenCalledOnce());
    await f.invoke(AI_CHANNELS.cancelGeneration, 'map', f.request.sequence);
    expect(await result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    unlocked.resolve({ config, key });
    await Promise.resolve();
    expect(f.transport.request).not.toHaveBeenCalled();
    expect(f.owner.listenerCount('destroyed')).toBe(0);
  });

  it('aborts only the matching owner/map/sequence and discards late provider replies', async () => {
    const f = setup();
    const response = deferred<unknown>();
    f.transport.request.mockReturnValue(response.promise);
    const result = f.invoke(AI_CHANNELS.generate, f.request);
    await vi.waitFor(() => expect(f.transport.request).toHaveBeenCalledOnce());
    const signal = f.transport.request.mock.calls[0]?.[3];
    expect(signal?.aborted).toBe(false);
    await invokeAs({ sender: f.other, senderFrame: f.other.mainFrame }, AI_CHANNELS.cancelGeneration, 'map', f.request.sequence);
    await f.invoke(AI_CHANNELS.cancelGeneration, 'map', f.request.sequence + 1);
    expect(signal?.aborted).toBe(false);
    await f.invoke(AI_CHANNELS.cancelGeneration, 'map', f.request.sequence);
    expect(signal?.aborted).toBe(true);
    expect(await result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    response.resolve(reply);
    await Promise.resolve();
    expect(f.repository.loadLibrary).toHaveBeenCalledOnce();
    expect(f.createId).not.toHaveBeenCalled();
    expect(f.owner.listenerCount('destroyed')).toBe(0);
    expect(f.owner.listenerCount('render-process-gone')).toBe(0);
  });

  it('discards results cancelled while awaiting the final fresh storage read', async () => {
    const f = setup();
    const read = deferred<LibrarySnapshot>();
    f.repository.loadLibrary.mockResolvedValueOnce(f.current()).mockReturnValueOnce(read.promise);
    const result = f.invoke(AI_CHANNELS.generate, f.request);
    await vi.waitFor(() => expect(f.repository.loadLibrary).toHaveBeenCalledTimes(2));
    await f.invoke(AI_CHANNELS.cancelGeneration, 'map', f.request.sequence);
    expect(await result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    read.resolve(f.current());
    expect(f.createId).not.toHaveBeenCalled();
  });

  it('does not return success when cancellation arrives in the final IPC completion microtask', async () => {
    const f = setup();
    const read = deferred<LibrarySnapshot>();
    f.repository.loadLibrary.mockResolvedValueOnce(f.current()).mockReturnValueOnce(read.promise);
    let cancellation: Promise<DesktopResult<unknown>> | undefined;
    f.createId.mockImplementation(() => {
      queueMicrotask(() => { cancellation = f.invoke(AI_CHANNELS.cancelGeneration, 'map', f.request.sequence); });
      return 'main-generated-id';
    });

    const result = f.invoke(AI_CHANNELS.generate, f.request);
    await vi.waitFor(() => expect(f.repository.loadLibrary).toHaveBeenCalledTimes(2));
    read.resolve(f.current());
    expect(await result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(await cancellation).toEqual({ ok: true, value: null });
  });

  it('retains a newer pre-cancellation guard when an older owner request is destroyed', async () => {
    const f = setup();
    const response = deferred<unknown>();
    f.transport.request.mockReturnValue(response.promise);
    const result = f.invoke(AI_CHANNELS.generate, f.request);
    await vi.waitFor(() => expect(f.transport.request).toHaveBeenCalledOnce());
    const newer = beginGeneration(f.current().library, 'map', 'root');
    f.persist(newer.library);
    await f.invoke(AI_CHANNELS.cancelGeneration, 'map', newer.request.sequence);
    f.owner.emit('render-process-gone');
    expect(await result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(await f.invoke(AI_CHANNELS.generate, newer.request)).toMatchObject({
      ok: false, error: { code: 'CANCELLED' },
    });
    expect(f.transport.request).toHaveBeenCalledOnce();
    response.resolve(reply);
  });

  it('supersedes older requests, permits the new one and ignores a late old cancel/reply', async () => {
    const f = setup();
    const response = deferred<unknown>();
    f.transport.request.mockReturnValueOnce(response.promise).mockResolvedValueOnce({ changes: [] });
    const old = f.invoke(AI_CHANNELS.generate, f.request);
    await vi.waitFor(() => expect(f.transport.request).toHaveBeenCalledOnce());
    const signal = f.transport.request.mock.calls[0]?.[3];
    const newer = beginGeneration(f.current().library, 'map', 'root');
    f.persist(newer.library);
    const next = f.invoke(AI_CHANNELS.generate, newer.request);
    expect(await old).toMatchObject({ ok: false, error: { code: 'STALE_GENERATION' } });
    expect(signal?.aborted).toBe(true);
    await f.invoke(AI_CHANNELS.cancelGeneration, 'map', f.request.sequence);
    expect(await next).toEqual({ ok: true, value: [] });
    response.resolve(reply);
    expect(f.repository.saveLibrary).not.toHaveBeenCalled();
    expect(f.owner.listenerCount('destroyed')).toBe(0);
  });

  it.each(['destroyed', 'render-process-gone', 'quit'] as const)(
    'aborts on %s and removes active listeners even if provider ignores abort', async (reason) => {
      const f = setup();
      const response = deferred<unknown>();
      f.transport.request.mockReturnValue(response.promise);
      const result = f.invoke(AI_CHANNELS.generate, f.request);
      await vi.waitFor(() => expect(f.transport.request).toHaveBeenCalledOnce());
      const signal = f.transport.request.mock.calls[0]?.[3];
      if (reason === 'quit') f.service.dispose();
      else f.owner.emit(reason);
      expect(await result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
      expect(signal?.aborted).toBe(true);
      expect(f.owner.listenerCount('destroyed')).toBe(0);
      expect(f.owner.listenerCount('render-process-gone')).toBe(0);
      response.resolve(reply);
      expect(f.repository.loadLibrary).toHaveBeenCalledOnce();
    },
  );

  it('blocks new calls after quit and bounds replay/pre-cancellation history explicitly', async () => {
    const f = setup();
    for (let i = 0; i < 128; i++) {
      expect(await f.invoke(AI_CHANNELS.cancelGeneration, `map-${i}`, 1)).toMatchObject({ ok: true });
    }
    expect(await f.invoke(AI_CHANNELS.cancelGeneration, 'another-map', 1)).toMatchObject({
      ok: false, error: { code: 'REQUEST_LIMIT' },
    });
    expect(await f.invoke(AI_CHANNELS.cancelGeneration, 'map-0', 2)).toMatchObject({ ok: true });
    f.service.dispose();
    for (const channel of Object.values(AI_CHANNELS)) {
      expect(await f.invoke(channel)).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    }
    expect(f.repository.loadLibrary).not.toHaveBeenCalled();
    expect(f.settings.summary).not.toHaveBeenCalled();
  });

  it('allows at most eight active generations per owner and releases capacity on completion', async () => {
    const f = setup();
    let library = createMapLibrary(Array.from({ length: 9 }, (_, i) => createTopicMap(`map-${i}`, `root-${i}`, 'Topic')));
    const requests: GenerationRequest[] = [];
    for (let i = 0; i < 9; i++) {
      const started = beginGeneration(library, `map-${i}`, `root-${i}`);
      library = started.library;
      requests.push(started.request);
    }
    f.persist(library);
    const response = deferred<unknown>();
    f.transport.request.mockReturnValue(response.promise);
    const pending = requests.slice(0, 8).map((request) => f.invoke(AI_CHANNELS.generate, request));
    await vi.waitFor(() => expect(f.transport.request).toHaveBeenCalledTimes(8));
    expect(await f.invoke(AI_CHANNELS.generate, requests[8])).toMatchObject({
      ok: false, error: { code: 'REQUEST_LIMIT' },
    });
    const replacement = beginGeneration(f.current().library, 'map-0', 'root-0');
    f.persist(replacement.library);
    const replaced = f.invoke(AI_CHANNELS.generate, replacement.request);
    expect(await pending[0]).toMatchObject({ ok: false, error: { code: 'STALE_GENERATION' } });
    await vi.waitFor(() => expect(f.transport.request).toHaveBeenCalledTimes(9));
    response.resolve({ changes: [] });
    expect(await Promise.all(pending.slice(1))).toEqual(Array.from({ length: 7 }, () => ({ ok: true, value: [] })));
    expect(await replaced).toEqual({ ok: true, value: [] });
    expect(await f.invoke(AI_CHANNELS.generate, requests[8])).toEqual({ ok: true, value: [] });
    expect(f.owner.listenerCount('destroyed')).toBe(0);
  });
});
