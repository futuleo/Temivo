import { assertMapId, assertMindMap, InvalidMindMapError } from './mind-map';
import type { MindMapNode } from './mind-map';
import {
  assertGeneratedContent,
  assertGenerationContext,
  assertGenerationToken,
  assertMapDocument,
  assertMapLibrary,
  descendantIds,
  invalid,
  isRecord,
  nextRevision,
  replaceDocument,
  requireDocument,
  requireMetadata,
  requireNode,
} from './map-library';
import type {
  GeneratedContent,
  GenerationContext,
  GenerationMode,
  GenerationToken,
  MapDocument,
  MapLibrary,
  NodeMetadata,
} from './map-library';

export class StaleGenerationError extends InvalidMindMapError {
  constructor() {
    super('Generation results or approvals are stale; start a new generation against current content.');
    this.name = 'StaleGenerationError';
  }
}

export interface GenerationRequest extends GenerationToken {
  readonly topic: string;
  readonly context: GenerationContext;
  readonly existingNodes: readonly GenerationNodeSnapshot[];
  readonly expectedSnapshot: string;
}

export interface GenerationNodeSnapshot extends GeneratedContent {
  readonly nodeId: string;
  readonly depth: number;
}

export type GenerationChange =
  | ({ readonly kind: 'upsert'; readonly nodeId: string } & GeneratedContent)
  | { readonly kind: 'remove'; readonly nodeId: string };

export type GenerationConflictReason =
  | 'manual-or-edited'
  | 'different-generation'
  | 'linked-world'
  | 'protected-descendants'
  | 'depends-on-conflict';

export interface GenerationConflict {
  readonly nodeId: string;
  readonly reason: GenerationConflictReason;
}

export interface GenerationPlan {
  readonly request: GenerationRequest;
  readonly changes: readonly GenerationChange[];
  readonly automaticNodeIds: readonly string[];
  readonly conflicts: readonly GenerationConflict[];
}

export interface PendingGenerationConflicts {
  readonly token: GenerationToken;
  readonly changes: readonly GenerationChange[];
  readonly conflicts: readonly GenerationConflict[];
  readonly expectedSnapshot: string;
}

export interface GenerationApplication {
  readonly library: MapLibrary;
  readonly pendingConflicts: PendingGenerationConflicts | null;
}

function copyRequest(request: GenerationRequest): GenerationRequest {
  return {
    mapId: request.mapId,
    anchorNodeId: request.anchorNodeId,
    sequence: request.sequence,
    documentRevision: request.documentRevision,
    mode: request.mode,
    requestedDepth: request.requestedDepth,
    topic: request.topic,
    context: { ...request.context },
    existingNodes: request.existingNodes.map((node) => ({ ...node })),
    expectedSnapshot: request.expectedSnapshot,
  };
}

function snapshotKey(library: MapLibrary, document: MapDocument): string {
  // Exact canonical values also distinguish divergent immutable branches with equal counters.
  return JSON.stringify([
    document.map.id,
    document.map.title,
    document.map.nodes.map((node) => [node.id, node.parentId, node.text]),
    document.revision,
    document.generationSequence,
    document.retiredNodeIds,
    document.nodeMetadata.map((metadata) => [
      metadata.nodeId, metadata.revision, metadata.description,
      [metadata.context.instructions, metadata.context.detail, metadata.context.depth],
      metadata.provenance.kind === 'user' ? ['user'] : [
        'ai', metadata.provenance.anchorNodeId, metadata.provenance.baselineRevision,
        metadata.provenance.userEdited,
        [
          metadata.provenance.baseline.parentId,
          metadata.provenance.baseline.text,
          metadata.provenance.baseline.description,
        ],
      ],
    ]),
    library.links.filter((link) => link.sourceMapId === document.map.id)
      .map((link) => [link.sourceNodeId, link.targetMapId])
      .sort(([a = ''], [b = '']) => a < b ? -1 : a > b ? 1 : 0),
  ]);
}

function nodeDepths(document: MapDocument, anchorNodeId: string): ReadonlyMap<string, number> {
  const children = new Map<string, string[]>();
  for (const node of document.map.nodes) {
    if (node.parentId === null) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }
  const depths = new Map<string, number>([[anchorNodeId, 0]]);
  const pending = [anchorNodeId];
  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index];
    if (id === undefined) continue;
    const depth = depths.get(id) ?? 0;
    for (const child of children.get(id) ?? []) {
      depths.set(child, depth + 1);
      pending.push(child);
    }
  }
  return depths;
}

function snapshotNodes(
  document: MapDocument,
  anchorNodeId: string,
  depth: number,
): readonly GenerationNodeSnapshot[] {
  const depths = nodeDepths(document, anchorNodeId);
  return document.map.nodes.flatMap((node) => {
    const relativeDepth = depths.get(node.id);
    if (relativeDepth === undefined || relativeDepth > depth) return [];
    return [{
      nodeId: node.id,
      parentId: node.parentId,
      text: node.text,
      description: requireMetadata(document, node.id).description,
      depth: relativeDepth,
    }];
  });
}

export function beginGeneration(
  library: MapLibrary,
  mapId: string,
  anchorNodeId: string,
  mode: GenerationMode = 'refresh',
): { readonly library: MapLibrary; readonly request: GenerationRequest } {
  assertMapLibrary(library);
  const document = requireDocument(library, mapId);
  const anchor = requireNode(document, anchorNodeId);
  const metadata = requireMetadata(document, anchorNodeId);
  const token: GenerationToken = {
    mapId,
    anchorNodeId,
    sequence: nextRevision(document.generationSequence),
    documentRevision: nextRevision(document.revision),
    mode,
    requestedDepth: metadata.context.depth,
  };
  const nextDocument: MapDocument = {
    ...document,
    revision: token.documentRevision,
    generationSequence: token.sequence,
    activeGeneration: { ...token },
  };
  const nextLibrary = replaceDocument(library, nextDocument);
  return {
    library: nextLibrary,
    request: {
      ...token,
      topic: anchor.text,
      context: { ...metadata.context },
      existingNodes: snapshotNodes(document, anchorNodeId, token.requestedDepth),
      expectedSnapshot: snapshotKey(nextLibrary, nextDocument),
    },
  };
}

function currentRequest(library: MapLibrary, request: GenerationRequest): MapDocument {
  assertMapLibrary(library);
  assertGenerationToken(request);
  if (!isRecord(request) || typeof request.topic !== 'string') invalid('A request topic is required.');
  assertGenerationContext(request.context);
  const document = library.documents.find((current) => current.map.id === request.mapId);
  const active = document?.activeGeneration;
  if (
    !document ||
    !active ||
    active.sequence !== request.sequence ||
    active.anchorNodeId !== request.anchorNodeId ||
    active.documentRevision !== request.documentRevision ||
    active.mode !== request.mode ||
    active.requestedDepth !== request.requestedDepth ||
    document.revision !== request.documentRevision ||
    request.expectedSnapshot !== snapshotKey(library, document)
  ) {
    throw new StaleGenerationError();
  }
  const node = requireNode(document, request.anchorNodeId);
  const metadata = requireMetadata(document, request.anchorNodeId);
  if (
    node.text !== request.topic ||
    metadata.context.instructions !== request.context.instructions ||
    metadata.context.detail !== request.context.detail ||
    metadata.context.depth !== request.context.depth ||
    request.requestedDepth !== request.context.depth
  ) {
    throw new StaleGenerationError();
  }
  if (!Array.isArray(request.existingNodes)) invalid('A request must include its existing node snapshot.');
  const expected = snapshotNodes(document, request.anchorNodeId, request.requestedDepth);
  if (expected.length !== request.existingNodes.length ||
      expected.some((node, index) => {
        const actual: unknown = request.existingNodes[index];
        return !isRecord(actual) || node.nodeId !== actual['nodeId'] ||
          node.parentId !== actual['parentId'] || node.text !== actual['text'] ||
          node.description !== actual['description'] || node.depth !== actual['depth'];
      })) {
    throw new StaleGenerationError();
  }
  return document;
}

export function isPristineAiNode(document: MapDocument, nodeId: string): boolean {
  assertMapDocument(document);
  return pristineAiNode(document, nodeId);
}

function pristineAiNode(document: MapDocument, nodeId: string): boolean {
  const node = requireNode(document, nodeId);
  const metadata = requireMetadata(document, nodeId);
  const provenance = metadata.provenance;
  return provenance.kind === 'ai' &&
    !provenance.userEdited &&
    metadata.revision === provenance.baselineRevision &&
    node.parentId === provenance.baseline.parentId &&
    node.text === provenance.baseline.text &&
    metadata.description === provenance.baseline.description;
}

function sameContent(document: MapDocument, change: GenerationChange): boolean {
  if (change.kind !== 'upsert') return false;
  const node = document.map.nodes.find((current) => current.id === change.nodeId);
  return node !== undefined &&
    node.parentId === change.parentId &&
    node.text === change.text &&
    requireMetadata(document, node.id).description === change.description;
}

function projectedNodes(document: MapDocument, changes: readonly GenerationChange[]): readonly MindMapNode[] {
  const operations = new Map(changes.map((change) => [change.nodeId, change]));
  const oldNodes = new Map(document.map.nodes.map((node) => [node.id, node]));
  const removed = new Set(changes.filter((change) => change.kind === 'remove').map((change) => change.nodeId));
  const nodes: MindMapNode[] = [];
  for (const node of document.map.nodes) {
    if (removed.has(node.id)) continue;
    const change = operations.get(node.id);
    if (change?.kind === 'upsert') {
      nodes.push({ id: node.id, parentId: change.parentId, text: change.text });
    } else {
      let parentId = node.parentId;
      // Generation removes individual nodes, promoting survivors instead of deleting a subtree.
      while (parentId !== null && removed.has(parentId)) {
        parentId = oldNodes.get(parentId)?.parentId ?? null;
      }
      nodes.push(parentId === node.parentId ? node : { ...node, parentId });
    }
  }
  for (const change of changes) {
    if (change.kind === 'upsert' && !oldNodes.has(change.nodeId)) {
      nodes.push({ id: change.nodeId, parentId: change.parentId, text: change.text });
    }
  }
  assertMindMap({ ...document.map, nodes });
  return nodes;
}

function validatedChanges(
  document: MapDocument,
  anchorNodeId: string,
  changes: readonly GenerationChange[],
  requestedDepth: number,
  mode: GenerationMode,
): readonly GenerationChange[] {
  if (!Array.isArray(changes)) invalid('Generation changes must be an array.');
  const ids = new Set<string>();
  const depths = nodeDepths(document, anchorNodeId);
  const result: GenerationChange[] = [];
  for (const change of changes) {
    if (!isRecord(change)) invalid('A generation change is required.');
    assertMapId(change.nodeId);
    if (ids.has(change.nodeId)) invalid('A generation may change each node only once.');
    ids.add(change.nodeId);
    const existing = document.map.nodes.find((node) => node.id === change.nodeId);
    if (existing) {
      const depth = depths.get(existing.id);
      if (depth === undefined) {
        invalid('Generation may only change existing nodes in its current anchor subtree.');
      }
      if (depth > requestedDepth) {
        invalid('Generation cannot change stored nodes deeper than the requested depth.');
      }
    } else if (document.retiredNodeIds.includes(change.nodeId)) {
      invalid('Generation cannot reuse retired node identities.');
    }
    if (change.kind === 'upsert') {
      assertGeneratedContent(change);
      if (change.nodeId === anchorNodeId &&
          change.parentId !== requireNode(document, anchorNodeId).parentId) {
        invalid('Generation cannot reparent its anchor.');
      }
      result.push({
        kind: 'upsert',
        nodeId: change.nodeId,
        parentId: change.parentId,
        text: change.text,
        description: change.description,
      });
    } else if (change.kind === 'remove') {
      if (!existing) invalid('Generation cannot remove a missing node.');
      if (change.nodeId === anchorNodeId) invalid('Generation cannot remove its anchor.');
      result.push({ kind: 'remove', nodeId: change.nodeId });
    } else {
      invalid('A generation change must be an upsert or remove operation.');
    }
  }
  result.sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0);
  for (const change of result) {
    if (mode === 'expand' &&
        document.map.nodes.some((node) => node.id === change.nodeId) &&
        !sameContent(document, change)) {
      invalid('Lazy expansion may add missing nodes but cannot change or remove existing content.');
    }
  }
  assertProjectedScope(document, anchorNodeId, requestedDepth, result);
  return result;
}

function assertProjectedScope(
  document: MapDocument,
  anchorNodeId: string,
  requestedDepth: number,
  changes: readonly GenerationChange[],
): void {
  const nodes = projectedNodes(document, changes);
  const nextDepths = nodeDepths({ ...document, map: { ...document.map, nodes } }, anchorNodeId);
  for (const change of changes) {
    if (change.kind !== 'upsert') continue;
    const depth = nextDepths.get(change.nodeId);
    if (depth === undefined) {
      invalid('Generated nodes must remain within their anchor subtree.');
    }
    if (depth > requestedDepth) {
      invalid('Generated nodes cannot exceed the requested depth.');
    }
  }
}

function conflictReason(
  library: MapLibrary,
  document: MapDocument,
  anchorNodeId: string,
  change: GenerationChange,
): GenerationConflictReason | null {
  const node = document.map.nodes.find((current) => current.id === change.nodeId);
  if (!node || sameContent(document, change)) return null;
  const linked = (id: string): boolean => library.links.some((link) =>
    link.sourceMapId === document.map.id && link.sourceNodeId === id,
  );
  if (linked(node.id)) return 'linked-world';
  if (!pristineAiNode(document, node.id)) return 'manual-or-edited';
  const provenance = requireMetadata(document, node.id).provenance;
  if (provenance.kind !== 'ai' || provenance.anchorNodeId !== anchorNodeId) {
    return 'different-generation';
  }
  if (change.kind === 'remove' || change.parentId !== node.parentId) {
    for (const id of descendantIds(document.map, node.id)) {
      if (id === node.id) continue;
      const childProvenance = requireMetadata(document, id).provenance;
      if (
        linked(id) ||
        !pristineAiNode(document, id) ||
        childProvenance.kind !== 'ai' ||
        childProvenance.anchorNodeId !== anchorNodeId
      ) {
        return 'protected-descendants';
      }
    }
  }
  return null;
}

function canProject(
  document: MapDocument,
  request: GenerationRequest,
  changes: readonly GenerationChange[],
): boolean {
  try {
    assertProjectedScope(document, request.anchorNodeId, request.requestedDepth, changes);
    return true;
  } catch (error) {
    if (!(error instanceof InvalidMindMapError)) throw error;
    return false;
  }
}

export function planGeneration(
  library: MapLibrary,
  request: GenerationRequest,
  changes: readonly GenerationChange[],
): GenerationPlan {
  const document = currentRequest(library, request);
  const validated = validatedChanges(document, request.anchorNodeId, changes, request.requestedDepth, request.mode);
  const conflicts: GenerationConflict[] = [];
  let automatic: GenerationChange[] = [];
  for (const change of validated) {
    const reason = conflictReason(library, document, request.anchorNodeId, change);
    if (reason) conflicts.push({ nodeId: change.nodeId, reason });
    else automatic.push(change);
  }
  if (!canProject(document, request, automatic)) {
    // A valid final hierarchy can still depend on a protected reparenting proposal.
    automatic = automatic.filter((change) => {
      const existing = document.map.nodes.find((node) => node.id === change.nodeId);
      const structural = change.kind === 'remove' || !existing || change.parentId !== existing.parentId;
      if (structural) conflicts.push({ nodeId: change.nodeId, reason: 'depends-on-conflict' });
      return !structural;
    });
  }
  return {
    request: copyRequest(request),
    changes: validated,
    automaticNodeIds: automatic.map((change) => change.nodeId),
    conflicts: conflicts.sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0),
  };
}

function updatedMetadata(
  document: MapDocument,
  node: MindMapNode,
  change: GenerationChange | undefined,
  anchorNodeId: string,
): NodeMetadata {
  const previous = document.nodeMetadata.find((metadata) => metadata.nodeId === node.id);
  const description = change?.kind === 'upsert' ? change.description : previous?.description ?? '';
  const content: GeneratedContent = { parentId: node.parentId, text: node.text, description };
  if (!previous) {
    return {
      nodeId: node.id,
      revision: 0,
      description,
      context: { instructions: '', detail: 'brief', depth: 1 },
      provenance: {
        kind: 'ai',
        anchorNodeId,
        baseline: content,
        baselineRevision: 0,
        userEdited: false,
      },
    };
  }
  const oldNode = requireNode(document, node.id);
  if (oldNode.parentId === node.parentId && oldNode.text === node.text &&
      previous.description === description) return previous;
  const revision = nextRevision(previous.revision);
  return {
    ...previous,
    revision,
    description,
    provenance: previous.provenance.kind !== 'ai' ? previous.provenance : {
      ...previous.provenance,
      baseline: content,
      baselineRevision: revision,
      userEdited: !pristineAiNode(document, node.id),
    },
  };
}

function applyChanges(
  library: MapLibrary,
  document: MapDocument,
  anchorNodeId: string,
  changes: readonly GenerationChange[],
): MapLibrary {
  const nodes = projectedNodes(document, changes);
  const operations = new Map(changes.map((change) => [change.nodeId, change]));
  const removed = changes.filter((change) => change.kind === 'remove').map((change) => change.nodeId);
  const next = {
    ...document,
    map: { ...document.map, nodes },
    revision: nextRevision(document.revision),
    activeGeneration: null,
    retiredNodeIds: [...document.retiredNodeIds, ...removed],
    nodeMetadata: nodes.map((node) =>
      updatedMetadata(document, node, operations.get(node.id), anchorNodeId),
    ),
  };
  return replaceDocument({
    ...library,
    links: library.links.filter((link) =>
      link.sourceMapId !== document.map.id || !removed.includes(link.sourceNodeId),
    ),
  }, next);
}

export function applyGenerationPlan(library: MapLibrary, plan: GenerationPlan): GenerationApplication {
  if (!isRecord(plan)) invalid('A generation plan is required.');
  // Recompute safety instead of trusting classification supplied by a caller.
  const checked = planGeneration(library, plan.request, plan.changes);
  const document = requireDocument(library, checked.request.mapId);
  const automatic = checked.changes.filter((change) => checked.automaticNodeIds.includes(change.nodeId));
  const result = applyChanges(library, document, checked.request.anchorNodeId, automatic);
  const nextDocument = requireDocument(result, document.map.id);
  const changes = checked.changes.filter((change) => !checked.automaticNodeIds.includes(change.nodeId));
  return {
    library: result,
    pendingConflicts: changes.length === 0 ? null : {
      token: {
        mapId: document.map.id,
        anchorNodeId: checked.request.anchorNodeId,
        sequence: nextDocument.generationSequence,
        documentRevision: nextDocument.revision,
        mode: checked.request.mode,
        requestedDepth: checked.request.requestedDepth,
      },
      changes,
      conflicts: checked.conflicts,
      expectedSnapshot: snapshotKey(result, nextDocument),
    },
  };
}

export function approveGenerationConflicts(
  library: MapLibrary,
  pending: PendingGenerationConflicts,
  approvedNodeIds: readonly string[],
): MapLibrary {
  assertMapLibrary(library);
  if (!isRecord(pending)) invalid('Pending generation conflicts are required.');
  assertGenerationToken(pending.token);
  const document = library.documents.find((current) => current.map.id === pending.token.mapId);
  if (!document || document.revision !== pending.token.documentRevision ||
      document.generationSequence !== pending.token.sequence || document.activeGeneration !== null ||
      pending.expectedSnapshot !== snapshotKey(library, document)) {
    throw new StaleGenerationError();
  }
  requireNode(document, pending.token.anchorNodeId);
  const changes = validatedChanges(document, pending.token.anchorNodeId, pending.changes,
    pending.token.requestedDepth, pending.token.mode);
  if (!Array.isArray(approvedNodeIds) || approvedNodeIds.length === 0) {
    invalid('Explicitly select at least one conflict to approve.');
  }
  const selected = new Set<string>();
  for (const id of approvedNodeIds) {
    assertMapId(id);
    if (selected.has(id) || !changes.some((change) => change.nodeId === id)) {
      invalid('Approval must identify unique pending conflicts.');
    }
    selected.add(id);
  }
  const approved = validatedChanges(document, pending.token.anchorNodeId,
    changes.filter((change) => selected.has(change.nodeId)), pending.token.requestedDepth, pending.token.mode);
  return applyChanges(library, document, pending.token.anchorNodeId, approved);
}
