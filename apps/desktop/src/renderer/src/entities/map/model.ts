import type { GenerationContext, MapDocument, MindMapNode, NodeEdit } from '@temivo/core';

export interface NodeFields {
  readonly text: string;
  readonly description: string;
  readonly instructions: string;
  readonly detail: GenerationContext['detail'];
  readonly depth: string;
}

export interface NodeDraft {
  readonly fields: NodeFields;
  readonly original: NodeFields;
  readonly base: string;
}

export function nodeFields(document: MapDocument, nodeId: string): NodeFields {
  const node = document.map.nodes.find((candidate) => candidate.id === nodeId);
  const metadata = document.nodeMetadata.find((candidate) => candidate.nodeId === nodeId);
  if (!node || !metadata) throw new Error('This node no longer exists. Your draft has been kept.');
  return {
    text: node.text,
    description: metadata.description,
    instructions: metadata.context.instructions,
    detail: metadata.context.detail,
    depth: String(metadata.context.depth),
  };
}

export function nodeFingerprint(document: MapDocument, nodeId: string): string {
  const node = document.map.nodes.find((candidate) => candidate.id === nodeId);
  const metadata = document.nodeMetadata.find((candidate) => candidate.nodeId === nodeId);
  return JSON.stringify([node ?? null, metadata ?? null]);
}

export function createNodeDraft(document: MapDocument, nodeId: string): NodeDraft {
  const fields = nodeFields(document, nodeId);
  return { fields, original: fields, base: nodeFingerprint(document, nodeId) };
}

export function isDraftDirty(draft: NodeDraft): boolean {
  return JSON.stringify(draft.fields) !== JSON.stringify(draft.original);
}

export function draftEdit(draft: NodeDraft): NodeEdit {
  const depth = Number(draft.fields.depth);
  if (!Number.isSafeInteger(depth) || depth < 1) {
    throw new Error('Generation depth must be a whole number of at least 1.');
  }
  return {
    text: draft.fields.text,
    description: draft.fields.description,
    context: {
      instructions: draft.fields.instructions,
      detail: draft.fields.detail,
      depth,
    },
  };
}

export interface NodeRow {
  readonly node: MindMapNode;
  readonly depth: number;
  readonly childCount: number;
  readonly expanded: boolean;
}

export function projectNodes(document: MapDocument, expandedIds: readonly string[]): readonly NodeRow[] {
  const children = new Map<string | null, MindMapNode[]>();
  for (const node of document.map.nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const expanded = new Set(expandedIds);
  const pending = (children.get(null) ?? []).map((node) => ({ node, depth: 0 })).reverse();
  const rows: NodeRow[] = [];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) continue;
    const descendants = children.get(entry.node.id) ?? [];
    rows.push({ ...entry, childCount: descendants.length, expanded: expanded.has(entry.node.id) });
    if (expanded.has(entry.node.id)) {
      for (const node of [...descendants].reverse()) pending.push({ node, depth: entry.depth + 1 });
    }
  }
  return rows;
}

export function visibleDepth(
  document: MapDocument,
  expandedIds: readonly string[],
  anchorId: string,
  depth: number,
): readonly string[] {
  const expanded = new Set(expandedIds);
  const children = new Map<string, string[]>();
  for (const node of document.map.nodes) {
    if (node.parentId === null) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }
  const pending = [{ id: anchorId, depth: 0 }];
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (!current) continue;
    if (current.depth < depth) expanded.add(current.id);
    else expanded.delete(current.id);
    for (const id of children.get(current.id) ?? []) pending.push({ id, depth: current.depth + 1 });
  }
  return [...expanded];
}

export function parentChoices(document: MapDocument, nodeId: string): readonly MindMapNode[] {
  const excluded = new Set([nodeId]);
  const children = new Map<string, string[]>();
  for (const node of document.map.nodes) {
    if (node.parentId === null) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }
  const pending = [nodeId];
  for (let index = 0; index < pending.length; index += 1) {
    for (const id of children.get(pending[index] ?? '') ?? []) {
      excluded.add(id);
      pending.push(id);
    }
  }
  return document.map.nodes.filter((node) => !excluded.has(node.id));
}
