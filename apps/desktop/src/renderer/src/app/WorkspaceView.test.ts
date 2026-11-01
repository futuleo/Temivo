import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createMapLibrary, createTopicMap } from '@temivo/core';
import { App } from './index';
import { Workspace } from './workspace';
import { WorkspaceView } from './WorkspaceView';
import type { DesktopApi } from '../../../shared/desktop-api';

describe('assembled application presentation without a DOM or running app', () => {
  it('connects the actual root entry without making IPC or provider calls during server rendering', () => {
    const api: DesktopApi = {
      maps: {
        loadLibrary: vi.fn(), saveLibrary: vi.fn(), list: vi.fn(), get: vi.fn(), save: vi.fn(),
        delete: vi.fn(), getLinks: vi.fn(), link: vi.fn(), unlink: vi.fn(),
      },
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
      newId: () => 'unused',
    });
    await workspace.initialize();
    workspace.openWorld('one');
    workspace.changeDraft('one', 'root', { ...workspace.getDraft('one', 'root')!.fields, text: 'Keep my draft' });
    workspace.showLibrary();
    const html = renderToStaticMarkup(createElement(WorkspaceView, { workspace, settings: null, aiReady: false }));
    expect(html).toContain('Unapplied node drafts (1)');
    expect(html).toContain('Keep my draft');
    expect(html).toContain('Continue editing');
    workspace.openWorld('one');
    const world = renderToStaticMarkup(createElement(WorkspaceView, { workspace, settings: null, aiReady: false }));
    expect(world).toContain('Visited worlds');
    expect(world).toContain('Keep my draft');
    expect(world).toContain('AI is not configured');
  });
});
