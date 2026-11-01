import { describe, expect, it } from 'vitest';

import {
  addCollectionMember,
  addNode,
  applyGenerationPlan,
  approveGenerationConflicts,
  beginGeneration,
  createCollection,
  createMapLibrary,
  createTopicMap,
  editNode,
  InvalidMindMapError,
  isPristineAiNode,
  linkMaps,
  planGeneration,
  removeMap,
  removeNode,
  renameMap,
  reparentNode,
  StaleGenerationError,
  unlinkMap,
} from './index';
import type {
  GenerationChange,
  MapDocument,
  MapLibrary,
  PendingGenerationConflicts,
} from './index';

function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) frozen(child);
  }
  return value;
}

function document(library: MapLibrary): MapDocument {
  const found = library.documents.find((current) => current.map.id === 'map');
  if (!found) throw new Error('Missing fixture map');
  return found;
}

function pending(value: PendingGenerationConflicts | null): PendingGenerationConflicts {
  if (!value) throw new Error('Missing fixture conflicts');
  return value;
}

function upsert(nodeId: string, parentId: string | null, text = nodeId): GenerationChange {
  return { kind: 'upsert', nodeId, parentId, text, description: `Description: ${text}` };
}

function seeded(): MapLibrary {
  const library = createMapLibrary([
    createTopicMap('map', 'root', 'Topic'),
    createTopicMap('world', 'root', 'Independent world'),
  ]);
  const configured = editNode(library, 'map', 'root', {
    context: { instructions: '', detail: 'brief', depth: 4 },
  });
  const started = beginGeneration(configured, 'map', 'root');
  return applyGenerationPlan(started.library, planGeneration(started.library, started.request, [
    upsert('ai', 'root'), upsert('deep', 'ai'), upsert('sibling', 'root'),
  ])).library;
}

function apply(library: MapLibrary, changes: readonly GenerationChange[], anchor = 'root') {
  const started = beginGeneration(library, 'map', anchor);
  const plan = planGeneration(started.library, started.request, changes);
  return { ...applyGenerationPlan(started.library, plan), plan };
}

describe('generation requests and safe automatic application', () => {
  it('captures editable context and topic, using explicit sequences and immutable snapshots', () => {
    const original = frozen(editNode(seeded(), 'map', 'root', {
      text: 'New topic', context: { instructions: 'For beginners', detail: 'detailed', depth: 4 },
    }));
    const before = JSON.stringify(original);
    const started = beginGeneration(original, 'map', 'root');
    expect(started.request).toMatchObject({
      mapId: 'map', anchorNodeId: 'root', topic: 'New topic',
      context: { instructions: 'For beginners', detail: 'detailed', depth: 4 },
      sequence: 2, documentRevision: document(original).revision + 1,
    });
    const changes = frozen([upsert('ai', 'root', 'Updated'), upsert('new', 'ai')]);
    const request = frozen(started.request);
    const library = frozen(started.library);
    const plan = frozen(planGeneration(library, request, changes));
    expect(plan).toEqual(planGeneration(library, request, [...changes].reverse()));
    const result = applyGenerationPlan(library, plan);
    expect(result.pendingConflicts).toBeNull();
    expect(document(result.library).map.nodes.find((node) => node.id === 'ai')?.text).toBe('Updated');
    expect(isPristineAiNode(document(result.library), 'ai')).toBe(true);
    expect(isPristineAiNode(document(result.library), 'new')).toBe(true);
    expect(JSON.stringify(original)).toBe(before);
    expect(document(library).map.nodes.find((node) => node.id === 'ai')?.text).toBe('ai');
    expect(changes[0]).toEqual(upsert('ai', 'root', 'Updated'));
  });

  it('updates only requested content, preserving IDs, unfinished text and existing independent maps', () => {
    const original = frozen(seeded());
    const result = apply(original, [
      { kind: 'upsert', nodeId: 'ai', parentId: 'root', text: '', description: '' },
    ]);
    expect(result.plan.automaticNodeIds).toEqual(['ai']);
    expect(document(result.library).map.nodes.map((node) => node.id))
      .toEqual(document(original).map.nodes.map((node) => node.id));
    expect(document(result.library).map.nodes.find((node) => node.id === 'deep'))
      .toBe(document(original).map.nodes.find((node) => node.id === 'deep'));
    expect(result.library.documents[1]).toBe(original.documents[1]);
    expect(document(result.library).nodeMetadata.find((metadata) => metadata.nodeId === 'ai'))
      .toMatchObject({
        description: '', revision: 1,
        provenance: {
          kind: 'ai', anchorNodeId: 'root', baselineRevision: 1, userEdited: false,
          baseline: { parentId: 'root', text: '', description: '' },
        },
      });
  });

  it('removes only an individual generated node, promotes untouched survivors and retires its identity', () => {
    const original = frozen(seeded());
    const result = apply(original, [{ kind: 'remove', nodeId: 'ai' }]);
    expect(result.pendingConflicts).toBeNull();
    expect(document(result.library).map.nodes.find((node) => node.id === 'deep')?.parentId).toBe('root');
    expect(isPristineAiNode(document(result.library), 'deep')).toBe(true);
    expect(document(result.library).retiredNodeIds).toEqual(['ai']);
    expect(() => apply(result.library, [upsert('ai', 'root')])).toThrow(InvalidMindMapError);
  });

  it('does not trust caller-supplied automatic/conflict classification', () => {
    const library = editNode(seeded(), 'map', 'ai', { text: 'Mine' });
    const started = beginGeneration(library, 'map', 'root');
    const plan = planGeneration(started.library, started.request, [upsert('ai', 'root', 'AI')]);
    const result = applyGenerationPlan(started.library, {
      ...plan, automaticNodeIds: ['ai'], conflicts: [],
    });
    expect(document(result.library).map.nodes.find((node) => node.id === 'ai')?.text).toBe('Mine');
    expect(pending(result.pendingConflicts).conflicts).toEqual([
      { nodeId: 'ai', reason: 'manual-or-edited' },
    ]);
  });

  it('consumes even an empty result without permitting replays', () => {
    const started = beginGeneration(seeded(), 'map', 'root');
    const plan = planGeneration(started.library, started.request, []);
    const result = applyGenerationPlan(started.library, plan);
    expect(result.pendingConflicts).toBeNull();
    expect(() => applyGenerationPlan(result.library, plan)).toThrow(StaleGenerationError);
  });
});

describe('manual content and conflict proposals', () => {
  it.each([
    { text: 'My explanation' },
    { description: 'My notes' },
    { context: { instructions: 'My context', detail: 'brief' as const, depth: 1 } },
    { text: 'ai' },
  ])('records every user edit, including equal-valued edits: %j', (edit) => {
    const original = frozen(editNode(seeded(), 'map', 'ai', edit));
    expect(isPristineAiNode(document(original), 'ai')).toBe(false);
    const result = apply(original, [upsert('ai', 'root', 'New AI text'), upsert('sibling', 'root', 'Safe')]);
    expect(result.plan.automaticNodeIds).toEqual(['sibling']);
    expect(result.plan.conflicts).toEqual([{ nodeId: 'ai', reason: 'manual-or-edited' }]);
    expect(document(result.library).map.nodes.find((node) => node.id === 'ai'))
      .toEqual(document(original).map.nodes.find((node) => node.id === 'ai'));
    expect(document(result.library).map.nodes.find((node) => node.id === 'sibling')?.text).toBe('Safe');
    const accepted = approveGenerationConflicts(frozen(result.library), frozen(pending(result.pendingConflicts)), ['ai']);
    expect(document(accepted).map.nodes.find((node) => node.id === 'ai')?.text).toBe('New AI text');
    expect(isPristineAiNode(document(accepted), 'ai')).toBe(false);
    expect(apply(accepted, [upsert('ai', 'root', 'Another update')]).plan.conflicts).toHaveLength(1);
  });

  it('never converts manual nodes into pristine AI nodes, even after explicit approval', () => {
    const original = frozen(addNode(seeded(), 'map', { id: 'manual', parentId: 'root', text: 'Mine' }));
    const result = apply(original, [upsert('manual', 'root', 'Proposed'), upsert('root', null, 'New topic')]);
    expect(result.plan.automaticNodeIds).toEqual([]);
    expect(result.plan.conflicts.map((conflict) => conflict.nodeId)).toEqual(['manual', 'root']);
    const accepted = approveGenerationConflicts(result.library, pending(result.pendingConflicts), ['manual']);
    expect(document(accepted).map.nodes.find((node) => node.id === 'root')?.text).toBe('Topic');
    expect(document(accepted).nodeMetadata.find((metadata) => metadata.nodeId === 'manual')?.provenance)
      .toEqual({ kind: 'user' });
    expect(document(original).map.nodes.find((node) => node.id === 'manual')?.text).toBe('Mine');
  });

  it('leaves equal-valued protected content and its provenance untouched without noisy proposals', () => {
    const original = frozen(editNode(seeded(), 'map', 'ai', { text: 'ai' }));
    const result = apply(original, [upsert('ai', 'root')]);
    expect(result.pendingConflicts).toBeNull();
    expect(document(result.library).nodeMetadata).toEqual(document(original).nodeMetadata);
    expect(isPristineAiNode(document(result.library), 'ai')).toBe(false);
  });

  it('protects nested manual descendants when a generated ancestor is removed or moved', () => {
    const original = frozen(addNode(seeded(), 'map', { id: 'manual', parentId: 'deep', text: 'Keep me' }));
    for (const change of [
      { kind: 'remove' as const, nodeId: 'ai' },
      upsert('ai', 'sibling'),
    ]) {
      const result = apply(original, [change, upsert('sibling', 'root', 'Safe update')]);
      expect(result.plan.conflicts).toEqual([{ nodeId: 'ai', reason: 'protected-descendants' }]);
      expect(document(result.library).map.nodes.find((node) => node.id === 'ai')?.parentId).toBe('root');
      expect(document(result.library).map.nodes.find((node) => node.id === 'manual')?.parentId).toBe('deep');
    }
    const deletion = apply(original, [{ kind: 'remove', nodeId: 'ai' }, { kind: 'remove', nodeId: 'deep' }]);
    const accepted = approveGenerationConflicts(deletion.library, pending(deletion.pendingConflicts), ['ai', 'deep']);
    expect(document(accepted).map.nodes.find((node) => node.id === 'manual'))
      .toEqual({ id: 'manual', parentId: 'root', text: 'Keep me' });
    expect(document(accepted).nodeMetadata.find((metadata) => metadata.nodeId === 'manual')?.provenance)
      .toEqual({ kind: 'user' });
  });

  it('protects edited descendants, user reparenting, and nodes from a different generation scope', () => {
    const edited = editNode(seeded(), 'map', 'deep', { description: 'My notes' });
    expect(apply(edited, [{ kind: 'remove', nodeId: 'ai' }]).plan.conflicts)
      .toEqual([{ nodeId: 'ai', reason: 'protected-descendants' }]);
    const moved = reparentNode(seeded(), 'map', 'deep', 'sibling');
    expect(apply(moved, [upsert('deep', 'ai', 'Regenerated')]).plan.conflicts)
      .toEqual([{ nodeId: 'deep', reason: 'manual-or-edited' }]);
    expect(apply(seeded(), [upsert('deep', 'ai', 'Other scope')], 'ai').plan.conflicts)
      .toEqual([{ nodeId: 'deep', reason: 'different-generation' }]);
  });

  it.each<{ label: string; change: GenerationChange }>([
    { label: 'removal of a pristine descendant', change: { kind: 'remove', nodeId: 'X' } },
    { label: 'return of a pristine descendant', change: upsert('X', 'A', 'Regenerated') },
    { label: 'return of the edited ancestor', change: upsert('P', 'A', 'Regenerated') },
  ])('rejects $label from a branch relocated outside the current anchor', ({ change }) => {
    let library = addNode(createMapLibrary([createTopicMap('map', 'A', 'A')]), 'map', {
      id: 'B', parentId: null, text: 'Separate root',
    });
    library = editNode(library, 'map', 'A', {
      context: { instructions: '', detail: 'brief', depth: 2 },
    });
    const initial = beginGeneration(library, 'map', 'A');
    library = applyGenerationPlan(initial.library, planGeneration(initial.library, initial.request, [
      upsert('P', 'A'), upsert('X', 'P'),
    ])).library;
    const relocated = reparentNode(library, 'map', 'P', 'B');
    expect(isPristineAiNode(document(relocated), 'P')).toBe(false);
    expect(isPristineAiNode(document(relocated), 'X')).toBe(true);

    const started = beginGeneration(relocated, 'map', 'A');
    expect(started.request.existingNodes.map((node) => node.nodeId)).toEqual(['A']);
    const snapshot = frozen(started.library);
    const before = JSON.stringify(snapshot);
    const changes = frozen([change]);
    expect(() => applyGenerationPlan(snapshot, planGeneration(snapshot, started.request, changes)))
      .toThrow(InvalidMindMapError);
    expect(() => applyGenerationPlan(snapshot, {
      request: started.request, changes, automaticNodeIds: [change.nodeId], conflicts: [],
    })).toThrow(InvalidMindMapError);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(document(snapshot).map.nodes.find((node) => node.id === 'P')?.parentId).toBe('B');
    expect(document(snapshot).map.nodes.find((node) => node.id === 'X')?.parentId).toBe('P');
    expect(document(snapshot).retiredNodeIds).toEqual([]);
  });

  it('still automatically reparents pristine nodes within the current anchor subtree and depth', () => {
    const original = frozen(seeded());
    const result = apply(original, [upsert('deep', 'sibling')]);
    expect(result.plan.automaticNodeIds).toEqual(['deep']);
    expect(result.pendingConflicts).toBeNull();
    expect(document(result.library).map.nodes.find((node) => node.id === 'deep')?.parentId).toBe('sibling');
    expect(isPristineAiNode(document(result.library), 'deep')).toBe(true);
    expect(document(original).map.nodes.find((node) => node.id === 'deep')?.parentId).toBe('ai');
  });

  it('protects linked-world anchors and their ancestors without modifying the independent world', () => {
    const linked = frozen(linkMaps(seeded(), {
      sourceMapId: 'map', sourceNodeId: 'deep', targetMapId: 'world',
    }));
    const result = apply(linked, [
      { kind: 'remove', nodeId: 'ai' }, { kind: 'remove', nodeId: 'deep' },
    ]);
    expect(result.plan.conflicts).toEqual([
      { nodeId: 'ai', reason: 'protected-descendants' },
      { nodeId: 'deep', reason: 'linked-world' },
    ]);
    expect(result.library.links).toEqual(linked.links);
    const accepted = approveGenerationConflicts(result.library, pending(result.pendingConflicts), ['deep']);
    expect(accepted.links).toEqual([]);
    expect(accepted.documents[1]).toBe(linked.documents[1]);
    expect(document(accepted).map.nodes.some((node) => node.id === 'ai')).toBe(true);
  });

  it('demotes structural updates whose valid hierarchy depends on a protected operation', () => {
    const original = frozen(editNode(seeded(), 'map', 'deep', { text: 'Mine' }));
    const result = apply(original, [
      upsert('ai', 'deep'), upsert('deep', 'root', 'Proposal'), upsert('sibling', 'root', 'Safe'),
    ]);
    expect(result.plan.automaticNodeIds).toEqual(['sibling']);
    expect(result.plan.conflicts).toEqual([
      { nodeId: 'ai', reason: 'protected-descendants' },
      { nodeId: 'deep', reason: 'manual-or-edited' },
    ]);
    const conflicts = pending(result.pendingConflicts);
    expect(() => approveGenerationConflicts(result.library, conflicts, ['ai'])).toThrow(InvalidMindMapError);
    const accepted = approveGenerationConflicts(result.library, conflicts, ['ai', 'deep']);
    expect(document(accepted).map.nodes.find((node) => node.id === 'ai')?.parentId).toBe('deep');
    expect(document(accepted).map.nodes.find((node) => node.id === 'deep')?.parentId).toBe('root');
  });

  it('isolates additions whose depth depends on a conflicting hierarchy change', () => {
    const library = editNode(editNode(seeded(), 'map', 'deep', { text: 'Mine' }), 'map', 'root', {
      context: { instructions: '', detail: 'brief', depth: 2 },
    });
    const result = apply(library, [
      upsert('deep', 'root', 'Proposal'), upsert('new', 'deep'), upsert('sibling', 'root', 'Safe'),
    ]);
    expect(result.plan.automaticNodeIds).toEqual(['sibling']);
    expect(result.plan.conflicts).toEqual([
      { nodeId: 'deep', reason: 'manual-or-edited' },
      { nodeId: 'new', reason: 'depends-on-conflict' },
    ]);
    expect(document(result.library).map.nodes.some((node) => node.id === 'new')).toBe(false);
    const conflicts = pending(result.pendingConflicts);
    expect(() => approveGenerationConflicts(result.library, conflicts, ['new'])).toThrow(InvalidMindMapError);
    const accepted = approveGenerationConflicts(result.library, conflicts, ['deep', 'new']);
    expect(document(accepted).map.nodes.find((node) => node.id === 'new')?.parentId).toBe('deep');
  });
});

describe('stale generation and stale approvals', () => {
  it('rejects older sequences, duplicate applications and results against any intervening map edit', () => {
    const first = beginGeneration(seeded(), 'map', 'root');
    const second = beginGeneration(first.library, 'map', 'root');
    expect(() => planGeneration(second.library, first.request, [])).toThrow(StaleGenerationError);
    const plan = planGeneration(second.library, second.request, [upsert('ai', 'root', 'New')]);
    const mutations = [
      editNode(second.library, 'map', 'root', { text: 'Changed' }),
      editNode(second.library, 'map', 'root', { context: { instructions: 'Changed', detail: 'brief', depth: 4 } }),
      renameMap(second.library, 'map', 'Changed'),
      reparentNode(second.library, 'map', 'deep', 'sibling'),
      addNode(second.library, 'map', { id: 'manual', parentId: 'ai', text: 'Keep' }),
      removeNode(second.library, 'map', 'ai'),
      linkMaps(second.library, { sourceMapId: 'map', sourceNodeId: 'ai', targetMapId: 'world' }),
      removeNode(second.library, 'map', 'root'),
      removeMap(second.library, 'map'),
    ];
    for (const library of mutations) {
      expect(() => applyGenerationPlan(frozen(library), frozen(plan))).toThrow(StaleGenerationError);
    }
    const applied = applyGenerationPlan(second.library, plan);
    expect(() => applyGenerationPlan(applied.library, plan)).toThrow(StaleGenerationError);
    expect(() => planGeneration(second.library, { ...second.request, topic: 'Forged' }, []))
      .toThrow(StaleGenerationError);
  });

  it('invalidates results when incoming link cleanup changes the generating map', () => {
    const linked = linkMaps(seeded(), { sourceMapId: 'map', sourceNodeId: 'ai', targetMapId: 'world' });
    const started = beginGeneration(linked, 'map', 'root');
    for (const changed of [unlinkMap(started.library, 'map', 'ai'), removeMap(started.library, 'world')]) {
      expect(() => planGeneration(changed, started.request, [])).toThrow(StaleGenerationError);
    }
  });

  it('does not invalidate generation for unrelated maps or collection organization', () => {
    const started = beginGeneration(seeded(), 'map', 'root');
    let organized = addCollectionMember(createCollection(started.library, 'group', ''), 'group', 'map');
    organized = editNode(organized, 'world', 'root', { text: 'Other map changed' });
    expect(() => applyGenerationPlan(organized, planGeneration(organized, started.request, [])))
      .not.toThrow();
  });

  it('rejects changed-content, out-of-order and replayed conflict approvals', () => {
    const result = apply(editNode(seeded(), 'map', 'ai', { text: 'Mine' }), [upsert('ai', 'root', 'Proposal')]);
    const conflicts = frozen(pending(result.pendingConflicts));
    for (const changed of [
      editNode(result.library, 'map', 'ai', { text: 'Newer edit' }),
      addNode(result.library, 'map', { id: 'manual', parentId: 'ai', text: 'Keep' }),
      beginGeneration(result.library, 'map', 'root').library,
      removeMap(result.library, 'map'),
    ]) {
      expect(() => approveGenerationConflicts(frozen(changed), conflicts, ['ai']))
        .toThrow(StaleGenerationError);
    }
    const approved = approveGenerationConflicts(result.library, conflicts, ['ai']);
    expect(() => approveGenerationConflicts(approved, conflicts, ['ai'])).toThrow(StaleGenerationError);
    expect(document(result.library).map.nodes.find((node) => node.id === 'ai')?.text).toBe('Mine');
  });

  it('requires explicit unique pending identities for approval', () => {
    const result = apply(editNode(seeded(), 'map', 'ai', { text: 'Mine' }), [upsert('ai', 'root', 'Proposal')]);
    const conflicts = pending(result.pendingConflicts);
    for (const ids of [[], ['missing'], ['ai', 'ai'], ['']]) {
      expect(() => approveGenerationConflicts(result.library, conflicts, ids)).toThrow(InvalidMindMapError);
    }
  });

  it('rejects approvals and results from a divergent snapshot even when revision counters match', () => {
    const base = seeded();
    const branchA = editNode(base, 'map', 'ai', { text: 'Branch A' });
    const branchB = editNode(base, 'map', 'ai', { text: 'Branch B' });
    const startedA = beginGeneration(branchA, 'map', 'root');
    const startedB = beginGeneration(branchB, 'map', 'root');
    expect(document(startedA.library).revision).toBe(document(startedB.library).revision);
    const planA = planGeneration(startedA.library, startedA.request, [upsert('ai', 'root', 'Proposal A')]);
    expect(() => applyGenerationPlan(startedB.library, planA)).toThrow(StaleGenerationError);
    const resultA = applyGenerationPlan(startedA.library, planA);
    const resultB = applyGenerationPlan(startedB.library,
      planGeneration(startedB.library, startedB.request, [upsert('ai', 'root', 'Proposal B')]));
    expect(document(resultA.library).revision).toBe(document(resultB.library).revision);
    expect(() => approveGenerationConflicts(resultB.library, pending(resultA.pendingConflicts), ['ai']))
      .toThrow(StaleGenerationError);
  });
});

describe('generation input validation', () => {
  it('validates identities, parents, hierarchy, scope and reference existence before applying anything', () => {
    const started = beginGeneration(seeded(), 'map', 'root');
    const before = JSON.stringify(started.library);
    const invalidChanges: readonly (readonly GenerationChange[])[] = [
      [upsert('', 'root')],
      [upsert('new', 'missing')],
      [upsert('new', 'new')],
      [upsert('x', 'y'), upsert('y', 'x')],
      [upsert('ai', 'root'), upsert('ai', 'root')],
      [{ kind: 'remove', nodeId: 'missing' }],
      [{ kind: 'remove', nodeId: 'root' }],
      [upsert('root', 'ai')],
      [upsert('new', null)],
      [upsert('new', 'ai'), { kind: 'remove', nodeId: 'ai' }],
    ];
    for (const changes of invalidChanges) {
      expect(() => planGeneration(frozen(started.library), frozen(started.request), frozen(changes)))
        .toThrow(InvalidMindMapError);
    }
    const scoped = beginGeneration(seeded(), 'map', 'ai');
    expect(() => planGeneration(scoped.library, scoped.request, [upsert('sibling', 'ai')]))
      .toThrow(InvalidMindMapError);
    expect(JSON.stringify(started.library)).toBe(before);
  });

  describe('per-node depth and additive lazy expansion', () => {
    it('uses depth relative to the selected node, independently of linked-world traversal', () => {
      const library = linkMaps(seeded(), { sourceMapId: 'map', sourceNodeId: 'ai', targetMapId: 'world' });
      const started = beginGeneration(library, 'map', 'ai', 'expand');
      expect(started.request).toMatchObject({ mode: 'expand', requestedDepth: 1 });
      expect(started.request.existingNodes.map((node) => [node.nodeId, node.depth]))
        .toEqual([['ai', 0], ['deep', 1]]);
      expect(() => planGeneration(started.library, started.request, [upsert('new', 'deep')]))
        .toThrow(InvalidMindMapError);
      const result = applyGenerationPlan(started.library,
        planGeneration(started.library, started.request, [upsert('new', 'ai')]));
      expect(result.library.links).toEqual(library.links);
      expect(result.library.documents[1]).toBe(library.documents[1]);
    });

    it('reduces depth without pruning pristine AI descendants or manually added content', () => {
      const original = frozen(addNode(seeded(), 'map', { id: 'manual', parentId: 'deep', text: 'Keep' }));
      const shallow = editNode(original, 'map', 'root', {
        context: { instructions: '', detail: 'brief', depth: 1 },
      });
      expect(document(shallow).map).toEqual(document(original).map);
      expect(isPristineAiNode(document(shallow), 'deep')).toBe(true);
      const started = beginGeneration(shallow, 'map', 'root');
      expect(started.request.existingNodes.map((node) => node.nodeId)).toEqual(['root', 'ai', 'sibling']);
      const result = applyGenerationPlan(started.library,
        planGeneration(started.library, started.request, [upsert('ai', 'root', 'Updated immediate child')]));
      expect(document(result.library).map.nodes.find((node) => node.id === 'deep'))
        .toEqual(document(original).map.nodes.find((node) => node.id === 'deep'));
      expect(document(result.library).map.nodes.find((node) => node.id === 'manual'))
        .toEqual(document(original).map.nodes.find((node) => node.id === 'manual'));
      for (const changes of [
        [{ kind: 'remove' as const, nodeId: 'deep' }],
        [upsert('deep', 'ai', 'Out of scope')],
        [upsert('too-deep', 'ai')],
      ]) expect(() => planGeneration(started.library, started.request, changes)).toThrow(InvalidMindMapError);
    });

    it('increases depth and reuses saved children; expansion can only add missing identities', () => {
      const original = frozen(seeded());
      const configured = editNode(original, 'map', 'ai', {
        context: { instructions: '', detail: 'brief', depth: 2 },
      });
      const started = beginGeneration(configured, 'map', 'ai', 'expand');
      const plan = planGeneration(started.library, started.request, [upsert('deep', 'ai'), upsert('new', 'deep')]);
      const result = applyGenerationPlan(started.library, plan);
      expect(document(result.library).map.nodes.filter((node) => node.id === 'deep')).toHaveLength(1);
      expect(document(result.library).nodeMetadata.find((metadata) => metadata.nodeId === 'deep'))
        .toBe(document(original).nodeMetadata.find((metadata) => metadata.nodeId === 'deep'));
      expect(document(result.library).map.nodes.find((node) => node.id === 'new')?.parentId).toBe('deep');
      for (const changes of [
        [upsert('deep', 'ai', 'Overwrite')],
        [{ kind: 'remove' as const, nodeId: 'deep' }],
      ]) expect(() => planGeneration(started.library, started.request, changes)).toThrow(InvalidMindMapError);
    });

    it('does not interpret a smaller response as a deletion diff, including on repeat expansion', () => {
      let library = seeded();
      for (const depth of [1, 3, 1, 4]) {
        library = editNode(library, 'map', 'root', {
          context: { instructions: '', detail: 'brief', depth },
        });
        const before = document(library).map;
        const started = beginGeneration(library, 'map', 'root', 'expand');
        library = applyGenerationPlan(started.library, planGeneration(started.library, started.request, [])).library;
        expect(document(library).map).toEqual(before);
        expect(document(library).retiredNodeIds).toEqual([]);
      }
    });

    it('rejects results and conflict approvals tied to older depth parameters', () => {
      const started = beginGeneration(seeded(), 'map', 'root');
      const plan = planGeneration(started.library, started.request, [upsert('new', 'deep')]);
      const reduced = editNode(started.library, 'map', 'root', {
        context: { instructions: '', detail: 'brief', depth: 1 },
      });
      expect(() => applyGenerationPlan(reduced, plan)).toThrow(StaleGenerationError);
      const result = apply(editNode(seeded(), 'map', 'ai', { text: 'Mine' }), [upsert('ai', 'root', 'Proposal')]);
      const changed = editNode(result.library, 'map', 'root', {
        context: { instructions: '', detail: 'brief', depth: 1 },
      });
      expect(() => approveGenerationConflicts(changed, pending(result.pendingConflicts), ['ai']))
        .toThrow(StaleGenerationError);
    });

    it('rejects invalid depth settings without mutating or deleting anything', () => {
      const library = frozen(seeded());
      for (const depth of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => editNode(library, 'map', 'root', {
          context: { instructions: '', detail: 'brief', depth },
        })).toThrow(InvalidMindMapError);
      }
    });
  });

  it('rejects malformed runtime payloads with the existing domain error', () => {
    const started = beginGeneration(seeded(), 'map', 'root');
    for (const changes of [
      [null], [{}], [{ kind: 'unknown', nodeId: 'x' }],
      [{ kind: 'upsert', nodeId: 'x', parentId: 'root', text: 1, description: '' }],
      [{ kind: 'upsert', nodeId: 'x', parentId: 'root', text: '', description: null }],
    ]) {
      expect(() => planGeneration(started.library, started.request, changes as readonly GenerationChange[]))
        .toThrow(InvalidMindMapError);
    }
    expect(() => beginGeneration(seeded(), 'missing', 'root')).toThrow(InvalidMindMapError);
    expect(() => beginGeneration(seeded(), 'map', 'missing')).toThrow(InvalidMindMapError);
  });
});
