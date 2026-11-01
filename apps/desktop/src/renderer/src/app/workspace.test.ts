import { describe, expect, it, vi } from 'vitest';
import {
  addMap, addNode, createMapLibrary, createTopicMap, linkMaps,
} from '@temivo/core';
import type { GenerationChange, MapLibrary } from '@temivo/core';
import { isDraftDirty, nodeFingerprint } from '../entities/map';
import { DesktopPortError, Workspace } from './workspace';
import type { WorkspacePorts } from './workspace';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  let library = createMapLibrary([createTopicMap('one', 'root', 'First world'), createTopicMap('two', 'root', 'Second world')]);
  library = addNode(library, 'one', { id: 'manual', parentId: 'root', text: 'My work' });
  return linkMaps(library, { sourceMapId: 'one', sourceNodeId: 'manual', targetMapId: 'two' });
}

async function setup(overrides: Partial<WorkspacePorts> = {}, initial = fixture()) {
  let revision = 0;
  let nextId = 0;
  const ports: WorkspacePorts = {
    load: vi.fn(async () => ({ library: initial, revision })),
    save: vi.fn(async (library, expectedRevision) => {
      if (expectedRevision !== revision) throw new DesktopPortError('VERSION_CONFLICT', 'Another window saved this library.');
      revision += 1;
      return { library, revision };
    }),
    generate: vi.fn(async () => []),
    cancel: vi.fn(async () => undefined),
    newId: () => `new-${++nextId}`,
    ...overrides,
  };
  const workspace = new Workspace(ports);
  await workspace.initialize();
  workspace.openWorld('one');
  return { workspace, ports };
}

describe('renderer workspace with isolated injected ports', () => {
  it('does not replace a failed load with a fake empty library', async () => {
    const { workspace } = await setup({ load: async () => { throw new DesktopPortError('STORAGE_ERROR', 'Storage is unavailable.'); } });
    expect(workspace.getSnapshot().library).toBeNull();
    expect(workspace.getSnapshot().error).toBe('Storage is unavailable.');
  });

  it('shares an initial load across repeated initialization', async () => {
    const load = deferred<{ library: MapLibrary; revision: number }>();
    const port = vi.fn(() => load.promise);
    const workspace = new Workspace({
      load: port, save: vi.fn(), generate: vi.fn(), cancel: vi.fn(), newId: () => 'unused',
    });
    const first = workspace.initialize();
    const second = workspace.initialize();
    expect(port).toHaveBeenCalledTimes(1);
    load.resolve({ library: fixture(), revision: 3 });
    await Promise.all([first, second]);
    expect(workspace.getSnapshot().revision).toBe(3);
  });

  it('keeps typed node drafts across navigation and storage failure, including later typing during save', async () => {
    const save = deferred<{ library: MapLibrary; revision: number }>();
    const { workspace, ports } = await setup({ save: () => save.promise });
    workspace.changeDraft('one', 'root', { ...workspace.getDraft('one', 'root')!.fields, text: 'Edited locally', description: 'My description', depth: '2' });
    workspace.showSettings();
    workspace.showLibrary();
    workspace.openWorld('one');
    expect(workspace.getDraft('one', 'root')?.fields.text).toBe('Edited locally');
    expect(workspace.applyDraft('one', 'root')).toBe(true);
    workspace.changeDraft('one', 'root', { ...workspace.getDraft('one', 'root')!.fields, text: 'Still typing' });
    save.reject(new DesktopPortError('STORAGE_ERROR', 'Disk is unavailable.'));
    await workspace.save();
    expect(workspace.getSnapshot()).toMatchObject({ dirty: true, saving: false, saveError: 'Disk is unavailable.' });
    expect(workspace.currentDocument()?.nodeMetadata[0]?.description).toBe('My description');
    expect(workspace.getDraft('one', 'root')?.fields.text).toBe('Still typing');
    expect(ports.generate).not.toHaveBeenCalled();
  });

  it('preserves local fields after CAS failure and retains them as drafts on explicit reload', async () => {
    const remote = fixture();
    const { workspace, ports } = await setup({ save: async () => { throw new DesktopPortError('VERSION_CONFLICT', 'Another window saved this library.'); } }, remote);
    workspace.changeDraft('one', 'root', { ...workspace.getDraft('one', 'root')!.fields, text: 'Do not lose this' });
    workspace.applyDraft('one', 'root');
    await workspace.save();
    expect(workspace.getSnapshot().storageConflict).toBe(true);
    expect(ports.load).toHaveBeenCalledTimes(1);
    expect(workspace.currentDocument()?.map.nodes[0]?.text).toBe('Do not lose this');
    await workspace.reloadSaved();
    expect(workspace.currentDocument()?.map.nodes[0]?.text).toBe('First world');
    expect(workspace.getDraft('one', 'root')?.fields.text).toBe('Do not lose this');
    expect(isDraftDirty(workspace.getDraft('one', 'root')!)).toBe(true);
    expect(workspace.getSnapshot()).toMatchObject({ storageConflict: false, dirty: false });
  });

  it('uses the actual visited path and keeps linked worlds after detaching or deleting a source', async () => {
    const { workspace } = await setup();
    workspace.selectNode('manual');
    workspace.changeDraft('one', 'manual', { ...workspace.getDraft('one', 'manual')!.fields, text: 'Draft before leaving' });
    workspace.followWorld('manual');
    expect(workspace.getSnapshot().path?.steps.map((step) => step.mapId)).toEqual(['one', 'two']);
    workspace.back();
    expect(workspace.getDraft('one', 'manual')?.fields.text).toBe('Draft before leaving');
    workspace.detachWorld('one', 'manual');
    await workspace.save();
    workspace.deleteMap('one');
    await workspace.save();
    expect(workspace.getSnapshot().library?.documents.map((document) => document.map.id)).toEqual(['two']);
    expect(workspace.getDraft('one', 'manual')?.fields.text).toBe('Draft before leaving');
  });

  it('persists a new map and keeps collection removal separate from world lifecycle', async () => {
    const { workspace } = await setup();
    workspace.createCollection('Reading');
    await workspace.save();
    workspace.showLibrary('new-1');
    await workspace.createMap('New topic');
    expect(workspace.getSnapshot().library?.collections[0]?.mapIds).toEqual(['new-2']);
    workspace.deleteCollection('new-1');
    await workspace.save();
    expect(workspace.getSnapshot().library?.documents).toHaveLength(3);
    expect(workspace.getSnapshot().library?.collections).toHaveLength(0);
  });

  it('CAS-saves begun generation before dispatch and only applies protected changes after explicit approval', async () => {
    const changes: readonly GenerationChange[] = [
      { kind: 'upsert', nodeId: 'ai-new', parentId: 'root', text: 'AI branch', description: 'Generated' },
      { kind: 'upsert', nodeId: 'manual', parentId: 'root', text: 'Proposed rewrite', description: 'Proposal' },
    ];
    const { workspace, ports } = await setup({ generate: vi.fn(async () => changes) });
    await workspace.generate('one', 'root', 'refresh');
    expect(ports.save).toHaveBeenCalledTimes(2);
    expect(ports.generate).toHaveBeenCalledTimes(1);
    const firstSave = vi.mocked(ports.save).mock.calls[0];
    expect(firstSave?.[0].documents.find((document) => document.map.id === 'one')?.activeGeneration).toMatchObject({ anchorNodeId: 'root' });
    expect(workspace.currentDocument()?.map.nodes.find((node) => node.id === 'ai-new')?.text).toBe('AI branch');
    expect(workspace.currentDocument()?.map.nodes.find((node) => node.id === 'manual')?.text).toBe('My work');
    expect(workspace.getSnapshot().proposals['one']?.pending.conflicts).toHaveLength(1);
    workspace.toggleProposal('one', 'manual');
    expect(workspace.approveProposals('one')).toBe(true);
    await workspace.save();
    expect(workspace.currentDocument()?.map.nodes.find((node) => node.id === 'manual')?.text).toBe('Proposed rewrite');
    expect(workspace.getSnapshot().library?.documents).toHaveLength(2);
    expect(workspace.getSnapshot().proposals['one']).toBeUndefined();
  });

  it('preserves typed drafts when automatic generation updates the underlying saved node', async () => {
    const response = deferred<readonly GenerationChange[]>();
    const { workspace } = await setup({ generate: () => response.promise });
    const generating = workspace.generate('one', 'root', 'refresh');
    await workspace.save();
    workspace.selectNode('manual');
    workspace.changeDraft('one', 'manual', { ...workspace.getDraft('one', 'manual')!.fields, text: 'Currently typing' });
    response.resolve([{ kind: 'upsert', nodeId: 'manual', parentId: 'root', text: 'AI suggests', description: '' }]);
    await generating;
    expect(workspace.getDraft('one', 'manual')?.fields.text).toBe('Currently typing');
    expect(workspace.currentDocument()?.map.nodes.find((node) => node.id === 'manual')?.text).toBe('My work');
    expect(workspace.getSnapshot().proposals['one']).toBeDefined();
  });

  it('rejects late generation after an applied edit and ignores locally canceled responses', async () => {
    const response = deferred<readonly GenerationChange[]>();
    const { workspace } = await setup({ generate: () => response.promise });
    const generating = workspace.generate('one', 'root', 'refresh');
    await workspace.save();
    workspace.changeDraft('one', 'root', { ...workspace.getDraft('one', 'root')!.fields, text: 'New topic' });
    workspace.applyDraft('one', 'root');
    await workspace.save();
    response.resolve([{ kind: 'upsert', nodeId: 'late', parentId: 'root', text: 'Old result', description: '' }]);
    await generating;
    expect(workspace.getSnapshot().error).toContain('stale');
    expect(workspace.currentDocument()?.map.nodes.some((node) => node.id === 'late')).toBe(false);

    const canceledResponse = deferred<readonly GenerationChange[]>();
    const canceled = await setup({ generate: () => canceledResponse.promise });
    const pending = canceled.workspace.generate('one', 'root', 'expand');
    await canceled.workspace.save();
    await canceled.workspace.cancelGeneration();
    canceledResponse.resolve([{ kind: 'upsert', nodeId: 'canceled', parentId: 'root', text: 'Never apply', description: '' }]);
    await pending;
    expect(canceled.ports.cancel).toHaveBeenCalledWith('one', 1);
    expect(canceled.workspace.currentDocument()?.map.nodes.some((node) => node.id === 'canceled')).toBe(false);
  });

  it('does not dispatch generation if begun state cannot be persisted', async () => {
    const { workspace, ports } = await setup({ save: async () => { throw new Error('Save failed.'); } });
    await workspace.generate('one', 'root', 'refresh');
    expect(ports.generate).not.toHaveBeenCalled();
    expect(workspace.getSnapshot()).toMatchObject({ dirty: true, generation: null });
    expect(workspace.getSnapshot().error).toContain('not sent');
  });

  it('keeps a stale draft until the user explicitly chooses to replace saved fields', async () => {
    const { workspace } = await setup();
    workspace.selectNode('manual');
    workspace.changeDraft('one', 'manual', { ...workspace.getDraft('one', 'manual')!.fields, text: 'My draft' });
    workspace.reparent('one', 'manual', null);
    await workspace.save();
    expect(workspace.getDraft('one', 'manual')?.base).not.toBe(nodeFingerprint(workspace.currentDocument()!, 'manual'));
    expect(workspace.applyDraft('one', 'manual')).toBe(false);
    expect(workspace.applyDraft('one', 'manual', true)).toBe(true);
    await workspace.save();
    expect(workspace.currentDocument()?.map.nodes.find((node) => node.id === 'manual')).toMatchObject({ text: 'My draft', parentId: null });
  });

  it('creates a world from a node without reusing map or node identities', async () => {
    const { workspace } = await setup();
    await workspace.createMap('Separate world', false, { mapId: 'one', nodeId: 'root' });
    expect(workspace.getSnapshot().path?.steps.map((step) => step.mapId)).toEqual(['one', 'new-1']);
    expect(workspace.getSnapshot().library?.documents).toHaveLength(3);
    expect(workspace.currentDocument()?.map.nodes[0]?.id).toBe('new-2');
  });

  it('does not resurrect moved AI descendants through renderer generation handlers', async () => {
    const initial = addMap(createMapLibrary([createTopicMap('one', 'root', 'Topic')]), createTopicMap('two', 'root', 'Other'));
    const { workspace } = await setup({
      generate: async () => [{ kind: 'remove', nodeId: 'outside' }],
    }, addNode(initial, 'one', { id: 'outside', parentId: null, text: 'Outside scope' }));
    await workspace.generate('one', 'root', 'refresh');
    expect(workspace.currentDocument()?.map.nodes.some((node) => node.id === 'outside')).toBe(true);
    expect(workspace.getSnapshot().error).not.toBeNull();
  });
});
