import { assertMapId, assertMapLink, assertMindMap, InvalidMindMapError } from './mind-map';
import type { MapLink, MindMap, MindMapNode } from './mind-map';

export interface GenerationContext {
  readonly instructions: string;
  readonly detail: 'brief' | 'detailed';
  readonly depth: number;
}

export type GenerationMode = 'refresh' | 'expand';

export interface GeneratedContent {
  readonly parentId: string | null;
  readonly text: string;
  readonly description: string;
}

export type NodeProvenance =
  | { readonly kind: 'user' }
  | {
      readonly kind: 'ai';
      readonly anchorNodeId: string;
      readonly baseline: GeneratedContent;
      readonly baselineRevision: number;
      readonly userEdited: boolean;
    };

export interface NodeMetadata {
  readonly nodeId: string;
  readonly revision: number;
  readonly description: string;
  readonly context: GenerationContext;
  readonly provenance: NodeProvenance;
}

export interface GenerationToken {
  readonly mapId: string;
  readonly anchorNodeId: string;
  readonly sequence: number;
  readonly documentRevision: number;
  readonly mode: GenerationMode;
  readonly requestedDepth: number;
}

// This wrapper is deliberately not a MindMapRepository payload.
export interface MapDocument {
  readonly kind: 'map-document';
  readonly map: MindMap;
  readonly revision: number;
  readonly nodeMetadata: readonly NodeMetadata[];
  readonly retiredNodeIds: readonly string[];
  readonly generationSequence: number;
  readonly activeGeneration: GenerationToken | null;
}

export interface MapCollection {
  readonly id: string;
  readonly title: string;
  readonly mapIds: readonly string[];
}

export interface MapLibrary {
  readonly documents: readonly MapDocument[];
  readonly links: readonly MapLink[];
  readonly collections: readonly MapCollection[];
  readonly retiredMapIds: readonly string[];
}

export interface NewNode extends MindMapNode {
  readonly description?: string;
  readonly context?: GenerationContext;
}

export interface NodeEdit {
  readonly text?: string;
  readonly description?: string;
  readonly context?: GenerationContext;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function invalid(message: string): never {
  throw new InvalidMindMapError(message);
}

function assertRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    invalid('Revisions and generation sequences must be nonnegative safe integers.');
  }
}

export function nextRevision(value: number): number {
  assertRevision(value);
  const next = value + 1;
  assertRevision(next);
  return next;
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== 'string') invalid('Text fields must be strings.');
}

export function assertGenerationContext(value: unknown): asserts value is GenerationContext {
  if (!isRecord(value)) invalid('A generation context is required.');
  assertString(value['instructions']);
  if (value['detail'] !== 'brief' && value['detail'] !== 'detailed') {
    invalid('Generation detail must be brief or detailed.');
  }
  assertGenerationDepth(value['depth']);
}

export function assertGenerationDepth(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid('Generation depth must be a positive safe integer relative to the selected node.');
  }
}

export function assertGeneratedContent(value: unknown): asserts value is GeneratedContent {
  if (!isRecord(value)) invalid('Generated content is required.');
  if (value['parentId'] !== null) assertMapId(value['parentId']);
  assertString(value['text']);
  assertString(value['description']);
}

function assertUniqueIds(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value)) invalid('An identifiers array is required.');
  const ids = new Set<string>();
  for (const id of value) {
    assertMapId(id);
    if (ids.has(id)) invalid('Identifiers must be unique.');
    ids.add(id);
  }
}

export function assertGenerationToken(value: unknown): asserts value is GenerationToken {
  if (!isRecord(value)) invalid('A generation token is required.');
  assertMapId(value['mapId']);
  assertMapId(value['anchorNodeId']);
  assertRevision(value['sequence']);
  assertRevision(value['documentRevision']);
  assertGenerationDepth(value['requestedDepth']);
  if (value['mode'] !== 'refresh' && value['mode'] !== 'expand') {
    invalid('Generation mode must be refresh or expand.');
  }
  if (value['sequence'] === 0) invalid('A generation token must have a positive sequence.');
}

export function assertMapDocument(value: unknown): asserts value is MapDocument {
  if (!isRecord(value) || value['kind'] !== 'map-document') invalid('A map document is required.');
  assertMindMap(value['map']);
  const map = value['map'];
  assertRevision(value['revision']);
  assertRevision(value['generationSequence']);
  if (value['generationSequence'] > value['revision']) invalid('A sequence cannot exceed the document revision.');
  assertUniqueIds(value['retiredNodeIds']);
  const nodeIds = new Set(map.nodes.map((node) => node.id));
  if (value['retiredNodeIds'].some((id) => nodeIds.has(id))) {
    invalid('Retired node identities cannot be reused.');
  }
  if (!Array.isArray(value['nodeMetadata'])) invalid('Node metadata is required.');
  const metadataIds = new Set<string>();
  for (const metadata of value['nodeMetadata']) {
    if (!isRecord(metadata)) invalid('Each node must have metadata.');
    assertMapId(metadata['nodeId']);
    if (!nodeIds.has(metadata['nodeId']) || metadataIds.has(metadata['nodeId'])) {
      invalid('Metadata must identify exactly one existing node.');
    }
    metadataIds.add(metadata['nodeId']);
    assertRevision(metadata['revision']);
    if (metadata['revision'] > value['revision']) invalid('A node revision cannot exceed the document revision.');
    assertString(metadata['description']);
    assertGenerationContext(metadata['context']);
    const provenance = metadata['provenance'];
    if (!isRecord(provenance)) invalid('Node provenance is required.');
    if (provenance['kind'] === 'ai') {
      assertMapId(provenance['anchorNodeId']);
      assertGeneratedContent(provenance['baseline']);
      assertRevision(provenance['baselineRevision']);
      if (
        provenance['baselineRevision'] > metadata['revision'] ||
        typeof provenance['userEdited'] !== 'boolean'
      ) {
        invalid('AI provenance must track a valid baseline revision and user edits.');
      }
    } else if (provenance['kind'] !== 'user') {
      invalid('Node provenance must be user or ai.');
    }
  }
  if (metadataIds.size !== nodeIds.size) invalid('Every node must have metadata.');
  if (value['activeGeneration'] !== null) {
    assertGenerationToken(value['activeGeneration']);
    const token = value['activeGeneration'];
    if (
      token.mapId !== map.id ||
      token.sequence !== value['generationSequence'] ||
      token.documentRevision > value['revision'] ||
      !nodeIds.has(token.anchorNodeId)
    ) {
      invalid('An active generation must identify this document and an existing anchor.');
    }
  }
}

export function assertMapLibrary(value: unknown): asserts value is MapLibrary {
  if (
    !isRecord(value) ||
    !Array.isArray(value['documents']) ||
    !Array.isArray(value['links']) ||
    !Array.isArray(value['collections'])
  ) {
    invalid('A map library must contain documents, links and collections.');
  }
  assertUniqueIds(value['retiredMapIds']);
  const maps = new Map<string, MindMap>();
  for (const document of value['documents']) {
    assertMapDocument(document);
    if (maps.has(document.map.id) || value['retiredMapIds'].includes(document.map.id)) {
      invalid('Map identities must be unique and cannot reuse retired identities.');
    }
    maps.set(document.map.id, document.map);
  }
  const sources = new Map<string, Set<string>>();
  for (const link of value['links']) {
    assertMapLink(link);
    if (
      !maps.get(link.sourceMapId)?.nodes.some((node) => node.id === link.sourceNodeId) ||
      !maps.has(link.targetMapId)
    ) {
      invalid('Links must reference existing source nodes and target maps.');
    }
    const nodes = sources.get(link.sourceMapId) ?? new Set<string>();
    if (nodes.has(link.sourceNodeId)) invalid('A node may have only one outgoing map link.');
    nodes.add(link.sourceNodeId);
    sources.set(link.sourceMapId, nodes);
  }
  const collectionIds = new Set<string>();
  for (const collection of value['collections']) {
    if (!isRecord(collection)) invalid('A collection is required.');
    assertMapId(collection['id']);
    assertString(collection['title']);
    assertUniqueIds(collection['mapIds']);
    if (collectionIds.has(collection['id'])) invalid('Collection identifiers must be unique.');
    collectionIds.add(collection['id']);
    if (collection['mapIds'].some((id) => !maps.has(id))) {
      invalid('Collections may reference only existing maps.');
    }
  }
}

function defaultContext(): GenerationContext {
  return { instructions: '', detail: 'brief', depth: 1 };
}

function userMetadata(nodeId: string, description = '', context = defaultContext()): NodeMetadata {
  assertString(description);
  assertGenerationContext(context);
  return { nodeId, revision: 0, description, context: { ...context }, provenance: { kind: 'user' } };
}

export function createMapDocument(map: MindMap): MapDocument {
  assertMindMap(map);
  return {
    kind: 'map-document',
    map: { id: map.id, title: map.title, nodes: map.nodes.map((node) => ({ ...node })) },
    revision: 0,
    nodeMetadata: map.nodes.map((node) => userMetadata(node.id)),
    retiredNodeIds: [],
    generationSequence: 0,
    activeGeneration: null,
  };
}

export function createTopicMap(mapId: string, nodeId: string, topic: string): MapDocument {
  return createMapDocument({
    id: mapId,
    title: topic,
    nodes: [{ id: nodeId, parentId: null, text: topic }],
  });
}

export function createMapLibrary(documents: readonly MapDocument[] = []): MapLibrary {
  if (!Array.isArray(documents)) invalid('Map documents must be an array.');
  const library: MapLibrary = { documents: [...documents], links: [], collections: [], retiredMapIds: [] };
  assertMapLibrary(library);
  return library;
}

export function requireDocument(library: MapLibrary, mapId: string): MapDocument {
  assertMapId(mapId);
  return library.documents.find((document) => document.map.id === mapId) ??
    invalid('The map does not exist.');
}

export function requireNode(document: MapDocument, nodeId: string): MindMapNode {
  assertMapId(nodeId);
  return document.map.nodes.find((node) => node.id === nodeId) ?? invalid('The node does not exist.');
}

export function requireMetadata(document: MapDocument, nodeId: string): NodeMetadata {
  return document.nodeMetadata.find((metadata) => metadata.nodeId === nodeId) ??
    invalid('The node metadata does not exist.');
}

export function replaceDocument(library: MapLibrary, document: MapDocument): MapLibrary {
  const result = {
    ...library,
    documents: library.documents.map((current) =>
      current.map.id === document.map.id ? document : current,
    ),
  };
  assertMapLibrary(result);
  return result;
}

export function markUserEdited(metadata: NodeMetadata): NodeMetadata {
  return {
    ...metadata,
    revision: nextRevision(metadata.revision),
    provenance: metadata.provenance.kind === 'ai'
      ? { ...metadata.provenance, userEdited: true }
      : metadata.provenance,
  };
}

export function descendantIds(map: MindMap, nodeId: string): ReadonlySet<string> {
  const children = new Map<string, string[]>();
  for (const node of map.nodes) {
    if (node.parentId === null) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }
  const ids = new Set<string>();
  const pending = [nodeId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || ids.has(id)) continue;
    ids.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return ids;
}

export function addMap(library: MapLibrary, document: MapDocument): MapLibrary {
  assertMapLibrary(library);
  assertMapDocument(document);
  const result = { ...library, documents: [...library.documents, document] };
  assertMapLibrary(result);
  return result;
}

export function renameMap(library: MapLibrary, mapId: string, title: string): MapLibrary {
  assertMapLibrary(library);
  assertString(title);
  const document = requireDocument(library, mapId);
  return replaceDocument(library, {
    ...document,
    map: { ...document.map, title },
    revision: nextRevision(document.revision),
  });
}

export function addNode(library: MapLibrary, mapId: string, node: NewNode): MapLibrary {
  assertMapLibrary(library);
  if (!isRecord(node)) invalid('A new node is required.');
  const document = requireDocument(library, mapId);
  const map = {
    ...document.map,
    nodes: [...document.map.nodes, { id: node.id, parentId: node.parentId, text: node.text }],
  };
  assertMindMap(map);
  if (document.retiredNodeIds.includes(node.id)) invalid('Retired node identities cannot be reused.');
  const metadata = userMetadata(node.id, node.description, node.context);
  return replaceDocument(library, {
    ...document,
    map,
    nodeMetadata: [...document.nodeMetadata, metadata],
    revision: nextRevision(document.revision),
  });
}

export function editNode(
  library: MapLibrary,
  mapId: string,
  nodeId: string,
  edit: NodeEdit,
): MapLibrary {
  assertMapLibrary(library);
  const document = requireDocument(library, mapId);
  const node = requireNode(document, nodeId);
  if (!isRecord(edit) || Object.keys(edit).length === 0 ||
      Object.keys(edit).some((key) => !['text', 'description', 'context'].includes(key))) {
    invalid('A node edit must contain text, description or generation context.');
  }
  const metadata = markUserEdited(requireMetadata(document, nodeId));
  const text = 'text' in edit ? edit.text : node.text;
  const description = 'description' in edit ? edit.description : metadata.description;
  const context = 'context' in edit ? edit.context : metadata.context;
  assertString(text);
  assertString(description);
  assertGenerationContext(context);
  return replaceDocument(library, {
    ...document,
    map: {
      ...document.map,
      nodes: document.map.nodes.map((current) =>
        current.id === nodeId ? { ...node, text } : current,
      ),
    },
    nodeMetadata: document.nodeMetadata.map((current) =>
      current.nodeId === nodeId
        ? {
            ...metadata,
            description,
            context: { ...context },
          }
        : current,
    ),
    revision: nextRevision(document.revision),
  });
}

export function reparentNode(
  library: MapLibrary,
  mapId: string,
  nodeId: string,
  parentId: string | null,
): MapLibrary {
  assertMapLibrary(library);
  const document = requireDocument(library, mapId);
  requireNode(document, nodeId);
  const map = {
    ...document.map,
    nodes: document.map.nodes.map((node) => node.id === nodeId ? { ...node, parentId } : node),
  };
  assertMindMap(map);
  return replaceDocument(library, {
    ...document,
    map,
    revision: nextRevision(document.revision),
    nodeMetadata: document.nodeMetadata.map((metadata) =>
      metadata.nodeId === nodeId ? markUserEdited(metadata) : metadata,
    ),
  });
}

export function removeNode(library: MapLibrary, mapId: string, nodeId: string): MapLibrary {
  assertMapLibrary(library);
  const document = requireDocument(library, mapId);
  requireNode(document, nodeId);
  const removed = descendantIds(document.map, nodeId);
  const links = library.links.filter((link) =>
    link.sourceMapId !== mapId || !removed.has(link.sourceNodeId),
  );
  return replaceDocument({ ...library, links }, {
    ...document,
    map: { ...document.map, nodes: document.map.nodes.filter((node) => !removed.has(node.id)) },
    nodeMetadata: document.nodeMetadata.filter((metadata) => !removed.has(metadata.nodeId)),
    retiredNodeIds: [...document.retiredNodeIds, ...removed],
    revision: nextRevision(document.revision),
    activeGeneration: document.activeGeneration && removed.has(document.activeGeneration.anchorNodeId)
      ? null
      : document.activeGeneration,
  });
}

function touchLinkSources(library: MapLibrary, links: readonly MapLink[]): MapLibrary {
  let result = library;
  for (const link of links) {
    const document = requireDocument(result, link.sourceMapId);
    result = {
      ...result,
      documents: result.documents.map((current) => current.map.id !== document.map.id ? current : {
        ...document,
        revision: nextRevision(document.revision),
        nodeMetadata: document.nodeMetadata.map((metadata) =>
          metadata.nodeId === link.sourceNodeId ? markUserEdited(metadata) : metadata,
        ),
      }),
    };
  }
  return result;
}

export function linkMaps(library: MapLibrary, link: MapLink): MapLibrary {
  assertMapLibrary(library);
  assertMapLink(link);
  requireNode(requireDocument(library, link.sourceMapId), link.sourceNodeId);
  requireDocument(library, link.targetMapId);
  const links = [
    ...library.links.filter((current) =>
      current.sourceMapId !== link.sourceMapId || current.sourceNodeId !== link.sourceNodeId,
    ),
    { ...link },
  ];
  const result = touchLinkSources({ ...library, links }, [link]);
  assertMapLibrary(result);
  return result;
}

export function unlinkMap(library: MapLibrary, sourceMapId: string, sourceNodeId: string): MapLibrary {
  assertMapLibrary(library);
  requireNode(requireDocument(library, sourceMapId), sourceNodeId);
  const removed = library.links.filter((link) =>
    link.sourceMapId === sourceMapId && link.sourceNodeId === sourceNodeId,
  );
  return touchLinkSources({
    ...library,
    links: library.links.filter((link) => !removed.includes(link)),
  }, removed);
}

export function removeMap(library: MapLibrary, mapId: string): MapLibrary {
  assertMapLibrary(library);
  requireDocument(library, mapId);
  const incoming = library.links.filter((link) => link.targetMapId === mapId);
  const result = touchLinkSources({
    ...library,
    documents: library.documents.filter((document) => document.map.id !== mapId),
    links: library.links.filter((link) => link.sourceMapId !== mapId && link.targetMapId !== mapId),
    collections: library.collections.map((collection) => ({
      ...collection,
      mapIds: collection.mapIds.filter((id) => id !== mapId),
    })),
    retiredMapIds: [...library.retiredMapIds, mapId],
  }, incoming);
  assertMapLibrary(result);
  return result;
}

function requireCollection(library: MapLibrary, collectionId: string): MapCollection {
  assertMapId(collectionId);
  return library.collections.find((collection) => collection.id === collectionId) ??
    invalid('The collection does not exist.');
}

export function createCollection(library: MapLibrary, id: string, title: string): MapLibrary {
  assertMapLibrary(library);
  const result = { ...library, collections: [...library.collections, { id, title, mapIds: [] }] };
  assertMapLibrary(result);
  return result;
}

export function renameCollection(library: MapLibrary, id: string, title: string): MapLibrary {
  assertMapLibrary(library);
  requireCollection(library, id);
  assertString(title);
  return {
    ...library,
    collections: library.collections.map((collection) =>
      collection.id === id ? { ...collection, title } : collection,
    ),
  };
}

export function removeCollection(library: MapLibrary, id: string): MapLibrary {
  assertMapLibrary(library);
  requireCollection(library, id);
  return { ...library, collections: library.collections.filter((collection) => collection.id !== id) };
}

export function addCollectionMember(library: MapLibrary, collectionId: string, mapId: string): MapLibrary {
  assertMapLibrary(library);
  requireDocument(library, mapId);
  const collection = requireCollection(library, collectionId);
  if (collection.mapIds.includes(mapId)) return library;
  return {
    ...library,
    collections: library.collections.map((current) => current.id !== collectionId ? current : {
      ...current, mapIds: [...current.mapIds, mapId],
    }),
  };
}

export function removeCollectionMember(
  library: MapLibrary,
  collectionId: string,
  mapId: string,
): MapLibrary {
  assertMapLibrary(library);
  requireCollection(library, collectionId);
  requireDocument(library, mapId);
  return {
    ...library,
    collections: library.collections.map((collection) => collection.id !== collectionId ? collection : {
      ...collection, mapIds: collection.mapIds.filter((id) => id !== mapId),
    }),
  };
}
