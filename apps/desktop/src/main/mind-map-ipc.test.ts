import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MindMap } from '@temivo/core';

import { MIND_MAP_CHANNELS } from '../shared/desktop-api';
import type { DesktopResult } from '../shared/desktop-api';
import { registerMindMapIpc } from './mind-map-ipc';
import { SqliteMindMapRepository } from './mind-map-repository';

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

const source: MindMap = {
  id: 'source', title: 'Source', nodes: [{ id: 'root', parentId: null, text: 'Topic' }],
};
const target: MindMap = { id: 'target', title: 'Target', nodes: [] };
let repository: SqliteMindMapRepository;

function invoke(channel: string, ...args: unknown[]): Promise<DesktopResult<unknown>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error('Missing IPC handler.');
  return handler(undefined, ...args);
}

beforeEach(() => {
  handlers.clear();
  repository = new SqliteMindMapRepository(':memory:');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  repository.close();
  vi.restoreAllMocks();
});

describe('maps IPC', () => {
  it('wires all operations to persistent storage with explicit success results', async () => {
    registerMindMapIpc(repository, () => true);
    expect(handlers.size).toBe(Object.keys(MIND_MAP_CHANNELS).length);
    expect(await invoke(MIND_MAP_CHANNELS.save, source)).toEqual({ ok: true, value: null });
    expect(await invoke(MIND_MAP_CHANNELS.save, target)).toEqual({ ok: true, value: null });
    expect(await invoke(MIND_MAP_CHANNELS.get, source.id)).toEqual({ ok: true, value: source });
    expect(await invoke(MIND_MAP_CHANNELS.list)).toEqual({
      ok: true, value: [{ id: source.id, title: source.title }, { id: target.id, title: target.title }],
    });
    const link = { sourceMapId: source.id, sourceNodeId: 'root', targetMapId: target.id };
    expect(await invoke(MIND_MAP_CHANNELS.link, link)).toEqual({ ok: true, value: null });
    expect(await invoke(MIND_MAP_CHANNELS.getLinks, source.id)).toEqual({ ok: true, value: [link] });
    expect(await invoke(MIND_MAP_CHANNELS.unlink, source.id, 'root')).toEqual({ ok: true, value: null });
    expect(await repository.get(target.id)).toEqual(target);
    expect(await invoke(MIND_MAP_CHANNELS.delete, source.id)).toEqual({ ok: true, value: null });
    expect(await repository.get(source.id)).toBeNull();
    expect(await repository.get(target.id)).toEqual(target);
  });

  it('rejects every operation from untrusted senders before touching storage', async () => {
    registerMindMapIpc(repository, () => false);
    const operations = [
      vi.spyOn(repository, 'list'),
      vi.spyOn(repository, 'get'),
      vi.spyOn(repository, 'save'),
      vi.spyOn(repository, 'delete'),
      vi.spyOn(repository, 'getLinks'),
      vi.spyOn(repository, 'link'),
      vi.spyOn(repository, 'unlink'),
    ];
    for (const channel of Object.values(MIND_MAP_CHANNELS)) {
      expect(await invoke(channel, source)).toMatchObject({
        ok: false, error: { code: 'FORBIDDEN' },
      });
    }
    for (const operation of operations) expect(operation).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    expect(await repository.list()).toEqual([]);
  });

  it('validates renderer data at the main-process boundary', async () => {
    registerMindMapIpc(repository, () => true);
    for (const [channel, value] of [
      [MIND_MAP_CHANNELS.get, 42],
      [MIND_MAP_CHANNELS.getLinks, null],
      [MIND_MAP_CHANNELS.save, { id: 'bad' }],
      [MIND_MAP_CHANNELS.delete, ''],
      [MIND_MAP_CHANNELS.link, { sourceMapId: 'source' }],
      [MIND_MAP_CHANNELS.unlink, 'source'],
    ] as const) {
      expect(await invoke(channel, value)).toMatchObject({
        ok: false, error: { code: 'INVALID_INPUT' },
      });
    }
    expect(console.warn).toHaveBeenCalled();
    expect(await repository.list()).toEqual([]);
  });

  it('reports storage failures without exposing internal error details to the renderer', async () => {
    registerMindMapIpc(repository, () => true);
    vi.spyOn(repository, 'get').mockRejectedValue(new Error('private database details'));
    const result = await invoke(MIND_MAP_CHANNELS.get, source.id);
    expect(result).toEqual({
      ok: false, error: { code: 'STORAGE_ERROR', message: 'Unable to access local maps.' },
    });
    expect(JSON.stringify(result)).not.toContain('private database details');
    expect(console.error).toHaveBeenCalled();
  });
});
