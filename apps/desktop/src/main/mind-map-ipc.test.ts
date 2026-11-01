import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMapDocument, createMapLibrary, editNode, linkMaps, removeMap, unlinkMap } from '@temivo/core';
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
    expect(await invoke(MIND_MAP_CHANNELS.loadLibrary)).toEqual({
      ok: true, value: { revision: 0, library: createMapLibrary() },
    });
    let library = createMapLibrary([createMapDocument(source), createMapDocument(target)]);
    library = editNode(library, source.id, 'root', { description: 'Durable context' });
    expect(await invoke(MIND_MAP_CHANNELS.saveLibrary, library, 0)).toEqual({
      ok: true, value: { revision: 1, library },
    });
    expect(await invoke(MIND_MAP_CHANNELS.get, source.id)).toEqual({ ok: true, value: source });
    expect(await invoke(MIND_MAP_CHANNELS.list)).toEqual({
      ok: true, value: [{ id: source.id, title: source.title }, { id: target.id, title: target.title }],
    });
    const link = { sourceMapId: source.id, sourceNodeId: 'root', targetMapId: target.id };
    library = linkMaps(library, link);
    expect(await invoke(MIND_MAP_CHANNELS.saveLibrary, library, 1)).toMatchObject({ ok: true });
    expect(await invoke(MIND_MAP_CHANNELS.getLinks, source.id)).toEqual({ ok: true, value: [link] });
    library = unlinkMap(library, source.id, 'root');
    expect(await invoke(MIND_MAP_CHANNELS.saveLibrary, library, 2)).toMatchObject({ ok: true });
    expect(await repository.get(target.id)).toEqual(target);
    library = removeMap(library, source.id);
    expect(await invoke(MIND_MAP_CHANNELS.saveLibrary, library, 3)).toEqual({
      ok: true, value: { revision: 4, library },
    });
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
      vi.spyOn(repository, 'loadLibrary'),
      vi.spyOn(repository, 'saveLibrary'),
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
      [MIND_MAP_CHANNELS.saveLibrary, { documents: [] }],
    ] as const) {
      expect(await invoke(channel, value)).toMatchObject({
        ok: false, error: { code: 'INVALID_INPUT' },
      });
    }
    expect(console.warn).toHaveBeenCalled();
    expect(await repository.list()).toEqual([]);
  });

  it('validates rich snapshots and CAS revisions before repository access', async () => {
    registerMindMapIpc(repository, () => true);
    const save = vi.spyOn(repository, 'saveLibrary');
    const library = createMapLibrary([createMapDocument(source)]);
    for (const [value, revision] of [
      [library, undefined], [library, '0'], [library, -1], [library, 0.1],
      [library, NaN], [library, Number.MAX_SAFE_INTEGER + 1], [null, 0],
      [{ ...library, documents: [{ ...library.documents[0], activeGeneration: {} }] }, 0],
      [{ ...library, retiredMapIds: [source.id] }, 0],
      [{ ...library, links: [{ sourceMapId: 'missing', sourceNodeId: 'node', targetMapId: source.id }] }, 0],
    ]) {
      expect(await invoke(MIND_MAP_CHANNELS.saveLibrary, value, revision)).toMatchObject({
        ok: false, error: { code: 'INVALID_INPUT' },
      });
    }
    expect(save).not.toHaveBeenCalled();
  });

  it('reports a stale revision explicitly and preserves newer work', async () => {
    registerMindMapIpc(repository, () => true);
    const library = createMapLibrary([createMapDocument(source)]);
    await invoke(MIND_MAP_CHANNELS.saveLibrary, library, 0);
    expect(await invoke(MIND_MAP_CHANNELS.saveLibrary, createMapLibrary(), 0)).toEqual({
      ok: false,
      error: { code: 'VERSION_CONFLICT', message: 'The library changed. Reload it before applying your changes.' },
    });
    expect(await repository.loadLibrary()).toEqual({ revision: 1, library });
  });

  it('returns an actionable guarded failure for every valid legacy write', async () => {
    registerMindMapIpc(repository, () => true);
    const library = createMapLibrary([createMapDocument(source), createMapDocument(target)]);
    await repository.saveLibrary(library, 0);
    for (const [channel, ...args] of [
      [MIND_MAP_CHANNELS.save, source],
      [MIND_MAP_CHANNELS.delete, source.id],
      [MIND_MAP_CHANNELS.link, { sourceMapId: source.id, sourceNodeId: 'root', targetMapId: target.id }],
      [MIND_MAP_CHANNELS.unlink, source.id, 'root'],
    ]) {
      expect(await invoke(String(channel), ...args)).toEqual({
        ok: false,
        error: {
          code: 'LIBRARY_REQUIRED',
          message: 'Legacy writes are disabled. Use maps.loadLibrary and maps.saveLibrary with its storage revision.',
        },
      });
    }
    expect(await repository.loadLibrary()).toEqual({ revision: 1, library });
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

  it('sanitizes library read and save storage errors, not misclassifying them as invalid input', async () => {
    registerMindMapIpc(repository, () => true);
    vi.spyOn(repository, 'loadLibrary').mockRejectedValue(new Error('private corrupt payload'));
    vi.spyOn(repository, 'saveLibrary').mockRejectedValue(new Error('private SQLite path'));
    for (const [channel, ...args] of [
      [MIND_MAP_CHANNELS.loadLibrary],
      [MIND_MAP_CHANNELS.saveLibrary, createMapLibrary(), 0],
    ]) {
      expect(await invoke(String(channel), ...args)).toEqual({
        ok: false, error: { code: 'STORAGE_ERROR', message: 'Unable to access local maps.' },
      });
    }
  });

  it('classifies actual corrupt persisted rich state as STORAGE_ERROR on every read and CAS channel', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'temivo-ipc-'));
    const path = join(directory, 'fixture.sqlite');
    const storage = new SqliteMindMapRepository(path);
    const database = new DatabaseSync(path);
    try {
      registerMindMapIpc(storage, () => true);
      database.exec("UPDATE map_library SET payload = '{\"documents\":[]}'");
      for (const [channel, ...args] of [
        [MIND_MAP_CHANNELS.loadLibrary],
        [MIND_MAP_CHANNELS.list],
        [MIND_MAP_CHANNELS.get, source.id],
        [MIND_MAP_CHANNELS.getLinks, source.id],
        [MIND_MAP_CHANNELS.saveLibrary, createMapLibrary(), 0],
      ]) {
        expect(await invoke(String(channel), ...args)).toEqual({
          ok: false, error: { code: 'STORAGE_ERROR', message: 'Unable to access local maps.' },
        });
      }
      expect(database.prepare('SELECT revision, payload FROM map_library').get()).toEqual({
        revision: 0, payload: '{"documents":[]}',
      });
    } finally {
      database.close();
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
