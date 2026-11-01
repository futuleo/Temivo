import { describe, expect, it } from 'vitest';

import {
  addNode,
  createMapLibrary,
  createTopicMap,
  followMapLink,
  InvalidMindMapError,
  linkMaps,
  navigateBack,
  navigateToBreadcrumb,
  projectLinkedWorlds,
  reconcileNavigation,
  removeMap,
  removeNode,
  startNavigation,
  unlinkMap,
} from './index';
import type { MapLibrary } from './index';

function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) frozen(child);
  }
  return value;
}

function graph(): MapLibrary {
  let library = createMapLibrary(['a', 'b', 'c', 'd'].map((id) => createTopicMap(id, 'root', id)));
  library = addNode(library, 'a', { id: 'second', parentId: 'root', text: '' });
  library = linkMaps(library, { sourceMapId: 'a', sourceNodeId: 'root', targetMapId: 'b' });
  library = linkMaps(library, { sourceMapId: 'a', sourceNodeId: 'second', targetMapId: 'c' });
  library = linkMaps(library, { sourceMapId: 'b', sourceNodeId: 'root', targetMapId: 'd' });
  library = linkMaps(library, { sourceMapId: 'c', sourceNodeId: 'root', targetMapId: 'd' });
  return linkMaps(library, { sourceMapId: 'd', sourceNodeId: 'root', targetMapId: 'a' });
}

describe('traversal-path navigation', () => {
  it('records breadcrumbs per traversal, allows cycles and goes back without changing maps', () => {
    const library = frozen(graph());
    const before = JSON.stringify(library);
    const root = frozen(startNavigation(library, 'a'));
    const b = frozen(followMapLink(library, root, 'root'));
    const d = frozen(followMapLink(library, b, 'root'));
    const cycle = frozen(followMapLink(library, d, 'root'));
    expect(cycle.steps.map((step) => step.mapId)).toEqual(['a', 'b', 'd', 'a']);
    expect(cycle.steps.map((step) => step.viaNodeId)).toEqual([null, 'root', 'root', 'root']);
    expect(navigateBack(library, cycle)).toEqual(d);
    expect(navigateToBreadcrumb(library, cycle, 1)).toEqual(b);
    expect(navigateBack(library, root)).toEqual(root);
    expect(root.steps).toHaveLength(1);
    expect(JSON.stringify(library)).toBe(before);
  });

  it('reaches the same independent map through different paths without permanent parent ownership', () => {
    const library = graph();
    const start = startNavigation(library, 'a');
    const viaB = followMapLink(library, followMapLink(library, start, 'root'), 'root');
    const viaC = followMapLink(library, followMapLink(library, start, 'second'), 'root');
    expect(viaB.steps.map((step) => step.mapId)).toEqual(['a', 'b', 'd']);
    expect(viaC.steps.map((step) => step.mapId)).toEqual(['a', 'c', 'd']);
    expect(startNavigation(library, 'd').steps).toEqual([{ mapId: 'd', viaNodeId: null }]);
  });

  it('retains historical breadcrumbs after unlinking or deleting the source node', () => {
    const library = graph();
    const path = followMapLink(library, startNavigation(library, 'a'), 'root');
    for (const updated of [
      unlinkMap(library, 'a', 'root'),
      removeNode(library, 'a', 'root'),
    ]) {
      expect(navigateBack(updated, path)).toEqual(startNavigation(updated, 'a'));
      expect(reconcileNavigation(updated, path)).toEqual(path);
    }
  });

  it('explicitly reconciles map deletion by truncating at the first deleted traversal step', () => {
    const library = graph();
    const path = followMapLink(library,
      followMapLink(library, startNavigation(library, 'a'), 'root'), 'root');
    expect(reconcileNavigation(removeMap(library, 'b'), path)).toEqual(startNavigation(library, 'a'));
    expect(reconcileNavigation(removeMap(library, 'a'), path)).toBeNull();
    expect(() => navigateBack(removeMap(library, 'b'), path)).toThrow(InvalidMindMapError);
  });

  it('rejects missing maps, missing links, malformed paths and invalid breadcrumb depths', () => {
    const library = graph();
    const path = startNavigation(library, 'a');
    expect(() => startNavigation(library, 'missing')).toThrow(InvalidMindMapError);
    expect(() => followMapLink(library, path, 'missing')).toThrow(InvalidMindMapError);
    expect(() => followMapLink(unlinkMap(library, 'a', 'root'), path, 'root'))
      .toThrow(InvalidMindMapError);
    expect(() => navigateBack(library, { steps: [] })).toThrow(InvalidMindMapError);
    expect(() => navigateBack(library, { steps: [{ mapId: 'a', viaNodeId: 'root' }] }))
      .toThrow(InvalidMindMapError);
    for (const depth of [-1, 1, 0.1, NaN, Infinity]) {
      expect(() => navigateToBreadcrumb(library, path, depth)).toThrow(InvalidMindMapError);
    }
  });
});

describe('expandable linked-world overview', () => {
  it('projects cycle and shared references without recursively duplicating independent maps', () => {
    const library = frozen(graph());
    const before = JSON.stringify(library);
    const rows = projectLinkedWorlds(library, 'a', frozen(['a', 'b', 'c', 'd']));
    expect(rows.map((row) => [row.mapId, row.kind, row.depth, row.parentRow])).toEqual([
      ['a', 'map', 0, null],
      ['b', 'map', 1, 0],
      ['d', 'map', 2, 1],
      ['a', 'cycle-reference', 3, 2],
      ['c', 'map', 1, 0],
      ['d', 'shared-reference', 2, 4],
    ]);
    expect(rows[4]?.via).toEqual({ sourceMapId: 'a', sourceNodeId: 'second', targetMapId: 'c' });
    expect(rows.filter((row) => row.kind !== 'map').every((row) => !row.expanded)).toBe(true);
    expect(library.documents).toHaveLength(4);
    expect(JSON.stringify(library)).toBe(before);
  });

  it('respects expansion without making collections or traversal imply ownership', () => {
    const library = graph();
    expect(projectLinkedWorlds(library, 'a', [])).toHaveLength(1);
    expect(projectLinkedWorlds(library, 'a', ['a']).map((row) => row.mapId)).toEqual(['a', 'b', 'c']);
    expect(projectLinkedWorlds(library, 'd', ['d', 'a']).map((row) => row.mapId)).toEqual(['d', 'a', 'b', 'c']);
    expect(() => projectLinkedWorlds(library, 'missing', [])).toThrow(InvalidMindMapError);
    expect(() => projectLinkedWorlds(library, 'a', ['missing'])).toThrow(InvalidMindMapError);
  });

  it('terminates on a deep cross-map cycle without recursive call-stack traversal', () => {
    const count = 600;
    const ids = Array.from({ length: count }, (_, index) => `map-${index}`);
    const library: MapLibrary = {
      ...createMapLibrary(ids.map((id) => createTopicMap(id, 'root', id))),
      links: ids.map((id, index) => ({
        sourceMapId: id, sourceNodeId: 'root', targetMapId: `map-${(index + 1) % count}`,
      })),
    };
    const rows = projectLinkedWorlds(frozen(library), 'map-0', ids);
    expect(rows).toHaveLength(count + 1);
    expect(rows[count]).toMatchObject({ mapId: 'map-0', depth: count, kind: 'cycle-reference' });
  });
});
