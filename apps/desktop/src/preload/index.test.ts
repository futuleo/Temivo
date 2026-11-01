import { expect, it, vi } from 'vitest';

import { createMapLibrary } from '@temivo/core';

import { MIND_MAP_CHANNELS } from '../shared/desktop-api';
import type { DesktopApi } from '../shared/desktop-api';

const bridge = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: DesktopApi) => void>(),
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ ok: true, value: null }),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: bridge.exposeInMainWorld },
  ipcRenderer: { invoke: bridge.invoke },
}));

it('exposes only the typed API and invokes fixed map channels', async () => {
  await import('./index');
  const exposed = bridge.exposeInMainWorld.mock.calls[0];
  if (!exposed) throw new Error('The preload bridge was not exposed.');
  const [name, api] = exposed;
  expect(name).toBe('temivo');
  expect(Object.keys(api).sort()).toEqual(['maps', 'platform', 'versions']);
  expect(Object.keys(api.maps).sort()).toEqual([
    'delete', 'get', 'getLinks', 'link', 'list', 'loadLibrary', 'save', 'saveLibrary', 'unlink',
  ]);
  expect(Object.keys(api.versions).sort()).toEqual(['chrome', 'electron', 'node']);

  const map = { id: 'map', title: 'Topic', nodes: [] };
  const link = { sourceMapId: 'map', sourceNodeId: 'node', targetMapId: 'other' };
  await api.maps.list();
  await api.maps.get('map');
  await api.maps.save(map);
  await api.maps.delete('map');
  await api.maps.getLinks('map');
  await api.maps.link(link);
  await api.maps.unlink('map', 'node');
  const library = createMapLibrary();
  await api.maps.loadLibrary();
  await api.maps.saveLibrary(library, 42);
  expect(bridge.invoke.mock.calls).toEqual([
    [MIND_MAP_CHANNELS.list],
    [MIND_MAP_CHANNELS.get, 'map'],
    [MIND_MAP_CHANNELS.save, map],
    [MIND_MAP_CHANNELS.delete, 'map'],
    [MIND_MAP_CHANNELS.getLinks, 'map'],
    [MIND_MAP_CHANNELS.link, link],
    [MIND_MAP_CHANNELS.unlink, 'map', 'node'],
    [MIND_MAP_CHANNELS.loadLibrary],
    [MIND_MAP_CHANNELS.saveLibrary, library, 42],
  ]);
});
