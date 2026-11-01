import { describe, expect, it, vi } from 'vitest';
import { createMapLibrary, createTopicMap } from '@temivo/core';
import type { AiApi, AiSettingsSummary, DesktopApi, LibrarySnapshot, MindMapsApi } from '../../../shared/desktop-api';
import { createLibraryPorts, createSettingsPorts, createWorkspacePorts } from './desktop-ports';
import { DesktopPortError, Workspace } from './workspace';

const summary: AiSettingsSummary = {
  config: { provider: 'anthropic', endpoint: 'https://provider.invalid/v1', model: 'chosen-model' },
  hasKey: true,
};

function aiFixture(): AiApi {
  return {
    getSettings: vi.fn<AiApi['getSettings']>(async () => ({ ok: true, value: summary })),
    updateSettings: vi.fn<AiApi['updateSettings']>(async () => ({ ok: true, value: summary })),
    generate: vi.fn<AiApi['generate']>(async () => ({ ok: true, value: [] })),
    cancelGeneration: vi.fn<AiApi['cancelGeneration']>(async () => ({ ok: true, value: null })),
  };
}

describe('real library bridge adapter with injected IPC', () => {
  it('passes full rich snapshots and storage revisions through the actual library contract', async () => {
    const library = createMapLibrary([createTopicMap('map', 'root', 'Topic')]);
    const loadLibrary = vi.fn(async () => ({ ok: true as const, value: { library, revision: 12 } }));
    const saveLibrary = vi.fn(async () => ({ ok: true as const, value: { library, revision: 13 } }));
    const ports = createLibraryPorts({ loadLibrary, saveLibrary });
    expect(await ports.load()).toEqual({ library, revision: 12 });
    expect(await ports.save(library, 12)).toEqual({ library, revision: 13 });
    expect(saveLibrary).toHaveBeenCalledWith(library, 12);
  });

  it('does not turn a CAS conflict into success or silently load replacement state', async () => {
    const loadLibrary = vi.fn();
    const ports = createLibraryPorts({
      loadLibrary,
      saveLibrary: vi.fn<MindMapsApi['saveLibrary']>(async () => ({ ok: false, error: { code: 'VERSION_CONFLICT', message: 'Reload required.' } })),
    });
    await expect(ports.save(createMapLibrary(), 12)).rejects.toEqual(new DesktopPortError('VERSION_CONFLICT', 'Reload required.'));
    expect(loadLibrary).not.toHaveBeenCalled();
  });

  it('sanitizes an IPC transport rejection instead of showing internal paths or pretending success', async () => {
    const ports = createLibraryPorts({
      loadLibrary: async () => { throw new Error('internal fixture path that must not be shown'); },
      saveLibrary: vi.fn(),
    });
    await expect(ports.load()).rejects.toMatchObject({ code: 'IPC_ERROR', message: expect.not.stringContaining('internal fixture') });
  });

  it('uses the exact metadata-only settings contract and write-only replacement action', async () => {
    const ai = aiFixture();
    const settings = createSettingsPorts(ai);
    expect(await settings.load()).toEqual(summary);
    await settings.save({
      provider: 'anthropic', endpoint: ' https://provider.invalid/v1 ', model: ' chosen-model ',
      keyAction: 'replace', apiKey: 'fixture-only-not-real',
    });
    expect(ai.updateSettings).toHaveBeenLastCalledWith({
      config: summary.config, keyAction: { kind: 'replace', key: 'fixture-only-not-real' },
    });
    for (const kind of ['keep', 'remove'] as const) {
      await settings.save({
        provider: 'anthropic', endpoint: 'https://provider.invalid/v1', model: 'chosen-model',
        keyAction: kind, apiKey: 'must-not-be-sent',
      });
      expect(ai.updateSettings).toHaveBeenLastCalledWith({ config: summary.config, keyAction: { kind } });
    }
    expect(ai.generate).not.toHaveBeenCalled();
  });

  it('wires the complete core/CAS/generation pipeline without legacy writes or real provider activity', async () => {
    let snapshot: LibrarySnapshot = { library: createMapLibrary([createTopicMap('map', 'root', 'Topic')]), revision: 0 };
    const ai = aiFixture();
    vi.mocked(ai.generate).mockImplementation(async () => {
      expect(snapshot.library.documents[0]?.activeGeneration).toMatchObject({ mapId: 'map', anchorNodeId: 'root', sequence: 1 });
      return { ok: true, value: [{ kind: 'upsert', nodeId: 'branch', parentId: 'root', text: 'Injected branch', description: 'Fixture response' }] };
    });
    const api: DesktopApi = {
      maps: {
        loadLibrary: vi.fn<MindMapsApi['loadLibrary']>(async () => ({ ok: true, value: snapshot })),
        saveLibrary: vi.fn<MindMapsApi['saveLibrary']>(async (library, expectedRevision) => {
          expect(expectedRevision).toBe(snapshot.revision);
          snapshot = { library, revision: snapshot.revision + 1 };
          return { ok: true, value: snapshot };
        }),
        list: vi.fn(), get: vi.fn(), save: vi.fn(), delete: vi.fn(), getLinks: vi.fn(), link: vi.fn(), unlink: vi.fn(),
      },
      ai, platform: 'fixture', versions: { electron: 'fixture', chrome: 'fixture', node: 'fixture' },
    };
    const ports = createWorkspacePorts(api, () => 'injected-id');
    const workspace = new Workspace(ports);
    await workspace.initialize();
    workspace.openWorld('map');
    await workspace.generate('map', 'root', 'expand');
    expect(workspace.currentDocument()?.map.nodes.map((node) => node.id)).toEqual(['root', 'branch']);
    expect(snapshot.revision).toBe(2);
    expect(workspace.getSnapshot().dirty).toBe(false);
    expect(api.maps.save).not.toHaveBeenCalled();
    expect(api.maps.list).not.toHaveBeenCalled();
    expect(api.maps.link).not.toHaveBeenCalled();
    await ports.cancel('map', 1);
    expect(ai.cancelGeneration).toHaveBeenCalledWith('map', 1);
  });
});
