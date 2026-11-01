export interface MindMapNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly text: string;
}

export interface MindMap {
  readonly id: string;
  readonly title: string;
  readonly nodes: readonly MindMapNode[];
}

export interface MindMapSummary {
  readonly id: string;
  readonly title: string;
}

export interface MapLink {
  readonly sourceMapId: string;
  readonly sourceNodeId: string;
  readonly targetMapId: string;
}

export interface MindMapRepository {
  list(): Promise<readonly MindMapSummary[]>;
  get(id: string): Promise<MindMap | null>;
  save(map: MindMap): Promise<void>;
  delete(id: string): Promise<void>;
  getLinks(sourceMapId: string): Promise<readonly MapLink[]>;
  link(link: MapLink): Promise<void>;
  unlink(sourceMapId: string, sourceNodeId: string): Promise<void>;
}

export class InvalidMindMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMindMapError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function assertMapId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidMindMapError('Map and node identifiers must be nonempty strings.');
  }
}

export function assertMindMap(value: unknown): asserts value is MindMap {
  if (!isRecord(value) || typeof value['title'] !== 'string' || !Array.isArray(value['nodes'])) {
    throw new InvalidMindMapError('A map must have a title and a nodes array.');
  }
  assertMapId(value['id']);
  const parents = new Map<string, string | null>();
  for (const node of value['nodes']) {
    if (!isRecord(node) || typeof node['text'] !== 'string') {
      throw new InvalidMindMapError('Each node must have text.');
    }
    assertMapId(node['id']);
    if (node['parentId'] !== null) assertMapId(node['parentId']);
    if (parents.has(node['id'])) {
      throw new InvalidMindMapError('Node identifiers must be unique within a map.');
    }
    parents.set(node['id'], node['parentId']);
  }

  const visited = new Set<string>();
  for (const id of parents.keys()) {
    const path = new Set<string>();
    let current: string | null = id;
    while (current !== null && !visited.has(current)) {
      if (!parents.has(current)) throw new InvalidMindMapError('A parent must belong to the same map.');
      if (path.has(current)) throw new InvalidMindMapError('Node parents must not form a cycle.');
      path.add(current);
      current = parents.get(current) ?? null;
    }
    for (const nodeId of path) visited.add(nodeId);
  }
}

export function assertMapLink(value: unknown): asserts value is MapLink {
  if (!isRecord(value)) throw new InvalidMindMapError('A link must identify its source and target.');
  assertMapId(value['sourceMapId']);
  assertMapId(value['sourceNodeId']);
  assertMapId(value['targetMapId']);
  if (value['sourceMapId'] === value['targetMapId']) {
    throw new InvalidMindMapError('A linked map must be a separate map.');
  }
}
