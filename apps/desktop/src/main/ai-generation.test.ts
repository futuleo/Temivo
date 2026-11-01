import { describe, expect, it, vi } from 'vitest';

import {
  addNode, applyGenerationPlan, approveGenerationConflicts, beginGeneration,
  createMapLibrary, createTopicMap, editNode, planGeneration, removeNode,
} from '@temivo/core';
import type { GenerationRequest } from '@temivo/core';

import {
  assertCurrentGeneration, decodeGenerationChanges, generationPrompt, parseCancellation, parseGenerationRequest,
} from './ai-generation';

function fixture(anchor = 'root') {
  let library = createMapLibrary([
    createTopicMap('map', 'root', 'Topic'),
    createTopicMap('other-world', 'other-root', 'Private other-world topic'),
  ]);
  library = addNode(library, 'map', { id: 'manual', parentId: 'root', text: 'My branch' });
  library = addNode(library, 'map', { id: 'deep', parentId: 'manual', text: 'Saved deep branch' });
  library = addNode(library, 'map', { id: 'retired', parentId: 'root', text: 'Retire me' });
  library = removeNode(library, 'map', 'retired');
  library = editNode(library, 'map', anchor, {
    context: { instructions: 'For beginners', detail: 'detailed', depth: 1 },
  });
  return beginGeneration(library, 'map', anchor);
}

function upsert(
  target: { existing: string } | { new: string },
  parent: { existing: string } | { new: string } | null = { existing: 'root' },
) {
  return { kind: 'upsert', target, parent, text: 'Proposed text', description: 'Proposed description' };
}

describe('generation boundary parsing and prompt privacy', () => {
  it('copies a valid request and uses only validated, scoped provider context', () => {
    const { library, request } = fixture();
    const parsed = parseGenerationRequest(request);
    expect(parsed).toEqual(request);
    expect(parsed).not.toBe(request);
    expect(parsed.context).not.toBe(request.context);
    expect(parsed.existingNodes[0]).not.toBe(request.existingNodes[0]);
    assertCurrentGeneration(library, parsed);
    const prompt = generationPrompt(parsed);
    expect(JSON.parse(prompt.prompt)).toEqual({
      topic: request.topic, context: request.context, mode: request.mode,
      anchorNodeId: request.anchorNodeId, existingNodes: request.existingNodes,
    });
    expect(prompt.prompt).not.toContain('Private other-world');
    expect(prompt.prompt).not.toContain('Saved deep branch');
    expect(prompt.prompt).not.toContain('expectedSnapshot');
    expect(prompt.prompt).not.toContain('retired');
    expect(prompt.prompt).not.toContain('nodeMetadata');
    expect(prompt.maxOutputTokens).toBe(8192);
  });

  it.each([
    null, [], {}, 42,
    { topic: null }, { mapId: '' }, { anchorNodeId: [] },
    { sequence: 0 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { documentRevision: -1 }, { mode: 'replace-all' }, { requestedDepth: 0 },
    { context: null }, { context: { instructions: '', detail: 'brief', depth: 0 } },
    { existingNodes: null }, { existingNodes: [null] },
    { existingNodes: new Array(1) },
    { existingNodes: [{ nodeId: 'root', parentId: null, text: '', description: '', depth: -1 }] },
    { existingNodes: Array.from({ length: 2049 }, () => ({})) },
    { expectedSnapshot: null }, { expectedSnapshot: 'x'.repeat(8 * 1024 * 1024 + 1) },
    { topic: 'x'.repeat(16_001) }, { surprise: 'field' },
  ])('rejects malformed or oversized unknown requests %#', (patch) => {
    const { request } = fixture();
    const input = typeof patch === 'object' && patch !== null && !Array.isArray(patch) && Object.keys(patch).length > 0
      ? { ...request, ...patch } : patch;
    expect(() => parseGenerationRequest(input)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it.each([
    { topic: 'Forged topic' }, { expectedSnapshot: 'forged' },
    { context: { instructions: 'forged', detail: 'detailed', depth: 1 } },
    { existingNodes: [] }, { sequence: 2 }, { documentRevision: 0 },
    { anchorNodeId: 'manual' }, { mode: 'expand' }, { requestedDepth: 2 },
  ])('uses the core exact request guard, not just counters %#', (patch) => {
    const { library, request } = fixture();
    const parsed = parseGenerationRequest({ ...request, ...patch });
    expect(() => assertCurrentGeneration(library, parsed))
      .toThrow(expect.objectContaining({ code: 'STALE_GENERATION' }));
  });

  it('rejects an oversized prompt rather than silently dropping saved context', () => {
    const { request } = fixture();
    const large: GenerationRequest = {
      ...request,
      existingNodes: Array.from({ length: 5 }, (_, i) => ({
        nodeId: `node-${i}`, parentId: 'root', text: 'x'.repeat(16_000), description: '', depth: 1,
      })),
    };
    expect(() => generationPrompt(parseGenerationRequest(large)))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('accepts exact structural and prompt limits, rejecting one character beyond the prompt budget', () => {
    const { request } = fixture();
    const bounded = {
      ...request, topic: 'x'.repeat(16_000), expectedSnapshot: 'x'.repeat(8 * 1024 * 1024),
      existingNodes: Array.from({ length: 2048 }, (_, i) => ({
        nodeId: `node-${i}`, parentId: 'root', text: '', description: '', depth: 1,
      })),
    };
    expect(parseGenerationRequest(bounded).existingNodes).toHaveLength(2048);
    const base = {
      ...request,
      existingNodes: Array.from({ length: 4 }, (_, i) => ({
        nodeId: `node-${i}`, parentId: 'root', text: '', description: '', depth: 1,
      })),
    };
    const basePrompt = generationPrompt(base);
    let remaining = 64_000 - basePrompt.system.length - basePrompt.prompt.length;
    const existingNodes = base.existingNodes.map((node) => {
      const length = Math.min(16_000, remaining);
      remaining -= length;
      return { ...node, text: 'x'.repeat(length) };
    });
    const exact = { ...base, existingNodes };
    const prompt = generationPrompt(parseGenerationRequest(exact));
    expect(prompt.system.length + prompt.prompt.length).toBe(64_000);
    const overflow = { ...exact, topic: exact.topic + 'x' };
    expect(() => generationPrompt(parseGenerationRequest(overflow)))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it.each([[null, 1], ['', 1], ['map', 0], ['map', 1.5], ['map', Infinity], ['map', '1']])(
    'safely parses cancellation identity and sequence %#', (mapId, sequence) => {
      expect(() => parseCancellation(mapId, sequence)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    },
  );
});

describe('bounded provider proposals and stable identities', () => {
  it('assigns main IDs, resolves forward references, and keeps protected manual edits as proposals', () => {
    const initial = fixture();
    const library = editNode(initial.library, 'map', 'root', {
      context: { instructions: '', detail: 'brief', depth: 2 },
    });
    const started = beginGeneration(library, 'map', 'root');
    const createId = vi.fn().mockReturnValueOnce('main-child').mockReturnValueOnce('main-parent');
    const changes = decodeGenerationChanges({ changes: [
      upsert({ new: 'child' }, { new: 'parent' }),
      upsert({ new: 'parent' }),
      upsert({ existing: 'manual' }),
    ] }, started.library, started.request, createId);
    expect(changes).toContainEqual({
      kind: 'upsert', nodeId: 'main-child', parentId: 'main-parent',
      text: 'Proposed text', description: 'Proposed description',
    });
    expect(changes).toContainEqual(expect.objectContaining({ nodeId: 'manual' }));
    expect(createId).toHaveBeenCalledTimes(2);
    const result = applyGenerationPlan(started.library, planGeneration(started.library, started.request, changes));
    const document = result.library.documents[0];
    expect(document?.map.nodes.find((node) => node.id === 'manual')?.text).toBe('My branch');
    expect(result.pendingConflicts?.conflicts).toEqual([{ nodeId: 'manual', reason: 'manual-or-edited' }]);
    if (!result.pendingConflicts) throw new Error('Expected manual proposal.');
    const approved = approveGenerationConflicts(result.library, result.pendingConflicts, ['manual']);
    expect(approved.documents[0]?.map.nodes.find((node) => node.id === 'manual')?.text).toBe('Proposed text');
    expect(approved.documents[1]).toEqual(started.library.documents[1]);
  });

  it('distinguishes an explicit empty result from malformed data and never infers removals', () => {
    const { library, request } = fixture();
    const createId = vi.fn();
    expect(decodeGenerationChanges({ changes: [] }, library, request, createId)).toEqual([]);
    const changes = decodeGenerationChanges({ changes: [upsert({ new: 'a' })] }, library, request, () => 'main-new');
    const applied = applyGenerationPlan(library, planGeneration(library, request, changes));
    expect(applied.library.documents[0]?.map.nodes.map((node) => node.id)).toEqual(['root', 'manual', 'deep', 'main-new']);
    expect(createId).not.toHaveBeenCalled();
  });

  it('preserves a non-root anchor parent without allowing other nodes to escape its subtree', () => {
    const { library, request } = fixture('manual');
    expect(decodeGenerationChanges({ changes: [upsert({ existing: 'manual' })] }, library, request, vi.fn()))
      .toContainEqual(expect.objectContaining({ nodeId: 'manual', parentId: 'root' }));
    expect(() => decodeGenerationChanges({ changes: [
      upsert({ new: 'escaping' }, { existing: 'root' }),
    ] }, library, request, () => 'new-id')).toThrow(expect.objectContaining({ code: 'PROTOCOL' }));
  });

  it.each([
    null, [], {}, { changes: null }, { changes: [null] }, { changes: new Array(1) }, { changes: [], extra: true },
    { changes: Array.from({ length: 257 }, () => ({})) },
    { changes: [{ kind: 'upsert', nodeId: 'trusted-model-id', parentId: 'root', text: '', description: '' }] },
    { changes: [upsert({ existing: 'retired' })] },
    { changes: [upsert({ existing: 'deep' })] },
    { changes: [upsert({ existing: 'other-root' })] },
    { changes: [upsert({ existing: 'invented' })] },
    { changes: [upsert({ existing: 'manual' }), upsert({ existing: 'manual' })] },
    { changes: [upsert({ new: 'duplicate' }), upsert({ new: 'duplicate' })] },
    { changes: [upsert({ new: 'bad space' })] },
    { changes: [upsert({ new: 'a' }, { new: 'missing' })] },
    { changes: [upsert({ new: 'a' }, { new: 'a' })] },
    { changes: [upsert({ new: 'a' }, { new: 'b' }), upsert({ new: 'b' }, { new: 'a' })] },
    { changes: [upsert({ new: 'too-deep' }, { existing: 'manual' })] },
    { changes: [upsert({ new: 'new-root' }, null)] },
    { changes: [{ kind: 'remove', target: { existing: 'root' } }] },
    { changes: [{ kind: 'remove', target: { new: 'a' } }] },
    { changes: [{ ...upsert({ new: 'a' }), text: null }] },
    { changes: [{ ...upsert({ new: 'a' }), description: 'x'.repeat(16_001) }] },
    { changes: [{ ...upsert({ new: 'a' }), extra: true }] },
    { changes: [{ ...upsert({ new: 'a' }), target: { existing: 'root', new: 'a' } }] },
    { changes: [{ kind: 'remove', target: { existing: 'manual' }, text: 'extra' }] },
  ])('rejects invalid output, ambiguous refs, scope/depth violations and collisions %#', (response) => {
    const { library, request } = fixture();
    let id = 0;
    expect(() => decodeGenerationChanges(response, library, request, () => `main-${id++}`))
      .toThrow(expect.objectContaining({ code: 'PROTOCOL' }));
  });

  it.each(['root', 'manual', 'retired', 'other-root', 'map', 'other-world'])(
    'rejects a collision from the platform identity capability: %s', (id) => {
      const { library, request } = fixture();
      expect(() => decodeGenerationChanges({ changes: [upsert({ new: 'a' })] }, library, request, () => id))
        .toThrow(expect.objectContaining({ code: 'AI_ERROR' }));
    },
  );

  it('rejects duplicate assigned IDs and aggregate oversized content without truncating', () => {
    const { library, request } = fixture();
    expect(() => decodeGenerationChanges({ changes: [
      upsert({ new: 'a' }), upsert({ new: 'b' }),
    ] }, library, request, () => 'duplicate-main-id')).toThrow(expect.objectContaining({ code: 'AI_ERROR' }));
    expect(() => decodeGenerationChanges({ changes: Array.from({ length: 5 }, (_, i) => ({
      ...upsert({ new: `n${i}` }), text: 'x'.repeat(16_000),
    })) }, library, request, () => 'unused')).toThrow(expect.objectContaining({ code: 'PROTOCOL' }));
  });

  it('accepts 256 explicit changes and exactly 64000 aggregate content characters', () => {
    const { library, request } = fixture();
    const changes = Array.from({ length: 256 }, (_, i) => ({
      ...upsert({ new: `n${i}` }), text: i < 4 ? 'x'.repeat(16_000) : '', description: '',
    }));
    let id = 0;
    const result = decodeGenerationChanges({ changes }, library, request, () => `main-${id++}`);
    expect(result).toHaveLength(256);
    expect(result.reduce((sum, change) => sum + (change.kind === 'upsert' ? change.text.length : 0), 0)).toBe(64_000);
  });

  it.each(['', ' ', 'x'.repeat(1025)])('rejects invalid IDs supplied by the main capability %#', (id) => {
    const { library, request } = fixture();
    expect(() => decodeGenerationChanges({ changes: [upsert({ new: 'a' })] }, library, request, () => id))
      .toThrow(expect.objectContaining({ code: 'AI_ERROR' }));
  });

  it('supports explicit removal proposals but never silently removes manual content', () => {
    const { library, request } = fixture();
    const changes = decodeGenerationChanges({
      changes: [{ kind: 'remove', target: { existing: 'manual' } }],
    }, library, request, vi.fn());
    const applied = applyGenerationPlan(library, planGeneration(library, request, changes));
    expect(applied.pendingConflicts?.conflicts).toEqual([{ nodeId: 'manual', reason: 'manual-or-edited' }]);
    expect(applied.library.documents[0]?.map.nodes.some((node) => node.id === 'deep')).toBe(true);
  });

  it('uses core expand semantics and rejects modifying existing content', () => {
    const initial = fixture();
    const started = beginGeneration(initial.library, 'map', 'root', 'expand');
    expect(() => decodeGenerationChanges({ changes: [upsert({ existing: 'manual' })] },
      started.library, started.request, vi.fn())).toThrow(expect.objectContaining({ code: 'PROTOCOL' }));
  });
});
