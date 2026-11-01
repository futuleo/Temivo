import { assertMapId } from './mind-map';
import type { MapLink } from './mind-map';
import { assertMapLibrary, invalid, isRecord, requireDocument, requireNode } from './map-library';
import type { MapLibrary } from './map-library';

export interface NavigationStep {
  readonly mapId: string;
  readonly viaNodeId: string | null;
}

export interface NavigationPath {
  readonly steps: readonly NavigationStep[];
}

export interface LinkedWorldRow {
  readonly mapId: string;
  readonly title: string;
  readonly depth: number;
  readonly parentRow: number | null;
  readonly via: MapLink | null;
  readonly kind: 'map' | 'cycle-reference' | 'shared-reference';
  readonly expanded: boolean;
}

function assertPath(value: unknown): asserts value is NavigationPath {
  if (!isRecord(value) || !Array.isArray(value['steps']) || value['steps'].length === 0) {
    invalid('Navigation requires a nonempty traversal path.');
  }
  for (const [index, step] of value['steps'].entries()) {
    if (!isRecord(step)) invalid('A navigation step is required.');
    assertMapId(step['mapId']);
    if (index === 0) {
      if (step['viaNodeId'] !== null) invalid('The first navigation step cannot have a source node.');
    } else {
      assertMapId(step['viaNodeId']);
    }
  }
}

function assertLivePath(library: MapLibrary, path: NavigationPath): void {
  assertMapLibrary(library);
  assertPath(path);
  for (const step of path.steps) requireDocument(library, step.mapId);
}

export function startNavigation(library: MapLibrary, mapId: string): NavigationPath {
  assertMapLibrary(library);
  requireDocument(library, mapId);
  return { steps: [{ mapId, viaNodeId: null }] };
}

export function followMapLink(
  library: MapLibrary,
  path: NavigationPath,
  sourceNodeId: string,
): NavigationPath {
  assertLivePath(library, path);
  const current = path.steps[path.steps.length - 1];
  if (!current) invalid('A current map is required.');
  requireNode(requireDocument(library, current.mapId), sourceNodeId);
  const link = library.links.find((candidate) =>
    candidate.sourceMapId === current.mapId && candidate.sourceNodeId === sourceNodeId,
  );
  if (!link) invalid('The node has no linked map.');
  return { steps: [...path.steps, { mapId: link.targetMapId, viaNodeId: sourceNodeId }] };
}

export function navigateToBreadcrumb(
  library: MapLibrary,
  path: NavigationPath,
  depth: number,
): NavigationPath {
  assertLivePath(library, path);
  if (!Number.isSafeInteger(depth) || depth < 0 || depth >= path.steps.length) {
    invalid('Breadcrumb depth must identify an existing traversal step.');
  }
  return { steps: path.steps.slice(0, depth + 1) };
}

export function navigateBack(library: MapLibrary, path: NavigationPath): NavigationPath {
  assertPath(path);
  return navigateToBreadcrumb(library, path, Math.max(0, path.steps.length - 2));
}

export function reconcileNavigation(library: MapLibrary, path: NavigationPath): NavigationPath | null {
  assertMapLibrary(library);
  assertPath(path);
  const maps = new Set(library.documents.map((document) => document.map.id));
  const firstMissing = path.steps.findIndex((step) => !maps.has(step.mapId));
  const steps = path.steps.slice(0, firstMissing < 0 ? path.steps.length : firstMissing);
  return steps.length === 0 ? null : { steps };
}

export function projectLinkedWorlds(
  library: MapLibrary,
  rootMapId: string,
  expandedMapIds: readonly string[],
): readonly LinkedWorldRow[] {
  assertMapLibrary(library);
  requireDocument(library, rootMapId);
  if (!Array.isArray(expandedMapIds)) invalid('Expanded map identifiers must be an array.');
  for (const mapId of expandedMapIds) requireDocument(library, mapId);
  const expanded = new Set(expandedMapIds);
  const seen = new Set<string>();
  const rows: LinkedWorldRow[] = [];
  const pending: {
    mapId: string;
    parentRow: number | null;
    via: MapLink | null;
    ancestors: ReadonlySet<string>;
    depth: number;
  }[] = [{ mapId: rootMapId, parentRow: null, via: null, ancestors: new Set(), depth: 0 }];
  while (pending.length > 0) {
    const next = pending.pop();
    if (!next) break;
    const document = requireDocument(library, next.mapId);
    const kind = next.ancestors.has(next.mapId) ? 'cycle-reference'
      : seen.has(next.mapId) ? 'shared-reference' : 'map';
    const shouldExpand = kind === 'map' && expanded.has(next.mapId);
    const index = rows.length;
    rows.push({
      mapId: next.mapId,
      title: document.map.title,
      depth: next.depth,
      parentRow: next.parentRow,
      via: next.via ? { ...next.via } : null,
      kind,
      expanded: shouldExpand,
    });
    seen.add(next.mapId);
    if (!shouldExpand) continue;
    const ancestors = new Set([...next.ancestors, next.mapId]);
    const outgoing = document.map.nodes.flatMap((node) => {
      const link = library.links.find((candidate) =>
        candidate.sourceMapId === next.mapId && candidate.sourceNodeId === node.id,
      );
      return link ? [link] : [];
    });
    for (const link of outgoing.reverse()) {
      pending.push({
        mapId: link.targetMapId,
        parentRow: index,
        via: link,
        ancestors,
        depth: next.depth + 1,
      });
    }
  }
  return rows;
}
