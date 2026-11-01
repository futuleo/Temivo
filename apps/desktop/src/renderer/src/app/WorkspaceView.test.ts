import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { addNode, createMapLibrary, createTopicMap } from '@temivo/core';
import { App } from './index';
import { Workspace } from './workspace';
import { WorkspaceView } from './WorkspaceView';
import type { DesktopApi } from '../../../shared/desktop-api';
import type { ProviderSettingsProps } from '../features/provider-settings';

const settings: ProviderSettingsProps = {
  fields: { provider: 'openai-compatible', endpoint: '', model: '', keyAction: 'keep', apiKey: '' },
  hasStoredKey: false, loaded: true, loading: false, dirty: false, saving: false, error: null, status: null,
  onChange: vi.fn(), onSave: vi.fn(), onRetryLoad: vi.fn(),
};

describe('assembled application presentation without a DOM or running app', () => {
  it.each(['constructor', 'toString', '__proto__'])('server-renders a loaded world and its proposals for the valid map/node ID %s', async (id) => {
    const library = addNode(createMapLibrary([createTopicMap(id, id, `World ${id}`)]), id, {
      id: 'manual', parentId: id, text: 'Protected branch',
    });
    let revision = 0;
    let saved = library;
    const workspace = new Workspace({
      load: async () => ({ library: saved, revision }),
      save: async (value) => {
        saved = value;
        return { library: saved, revision: ++revision };
      },
      generate: async () => [{ kind: 'upsert', nodeId: 'manual', parentId: id, text: 'Suggested branch', description: '' }],
      cancel: async () => undefined,
      newId: () => 'unused',
    });
    await workspace.initialize();
    workspace.openWorld(id);
    const before = renderToStaticMarkup(createElement(WorkspaceView, { workspace, settings, aiReady: true }));
    expect(before).toContain(`World ${id}`);
    expect(before).toContain('Node details');
    await workspace.generate(id, id, 'refresh');
    const after = renderToStaticMarkup(createElement(WorkspaceView, { workspace, settings, aiReady: true }));
    expect(after).toContain('Review AI proposals');
    expect(after).toContain('Suggested branch');
    workspace.showLibrary();
    expect(renderToStaticMarkup(createElement(WorkspaceView, { workspace, settings, aiReady: true }))).toContain('Review proposals');
    await workspace.reloadSaved();
    workspace.openWorld(id);
    expect(renderToStaticMarkup(createElement(WorkspaceView, { workspace, settings, aiReady: true }))).toContain('Node details');
    await workspace.generate(id, id, 'refresh');
    expect(renderToStaticMarkup(createElement(WorkspaceView, { workspace, settings, aiReady: true }))).toContain('Review AI proposals');
  });

  it('connects the actual root entry without making IPC or provider calls during server rendering', () => {
    const api: DesktopApi = {
      maps: {
        loadLibrary: vi.fn(), saveLibrary: vi.fn(), list: vi.fn(), get: vi.fn(), save: vi.fn(),
        delete: vi.fn(), getLinks: vi.fn(), link: vi.fn(), unlink: vi.fn(),
      },
      ai: { getSettings: vi.fn(), updateSettings: vi.fn(), generate: vi.fn(), cancelGeneration: vi.fn() },
      platform: 'fixture',
      versions: { electron: 'fixture', chrome: 'fixture', node: 'fixture' },
    };
    const html = renderToStaticMarkup(createElement(App, { api }));
    expect(html).toContain('Opening your worlds');
    expect(api.maps.loadLibrary).not.toHaveBeenCalled();
    expect(api.maps.saveLibrary).not.toHaveBeenCalled();
  });

  it('keeps unsaved-node recovery accessible across library and world views', async () => {
    const library = createMapLibrary([createTopicMap('one', 'root', 'My world')]);
    const workspace = new Workspace({
      load: async () => ({ library, revision: 1 }),
      save: async (value) => ({ library: value, revision: 2 }),
      generate: vi.fn(async () => []),
      cancel: vi.fn(async () => undefined),
      newId: () => 'unused',
    });
    await workspace.initialize();
    workspace.openWorld('one');
    workspace.changeDraft('one', 'root', { ...workspace.getDraft('one', 'root')!.fields, text: 'Keep my draft' });
    workspace.showLibrary();
    const html = renderToStaticMarkup(createElement(WorkspaceView, { workspace, settings, aiReady: false }));
    expect(html).toContain('Unapplied node drafts (1)');
    expect(html).toContain('Keep my draft');
    expect(html).toContain('Continue editing');
    workspace.openWorld('one');
    const world = renderToStaticMarkup(createElement(WorkspaceView, { workspace, settings, aiReady: false }));
    expect(world).toContain('Visited worlds');
    expect(world).toContain('Keep my draft');
    expect(world).toContain('AI is not configured');
  });
});
