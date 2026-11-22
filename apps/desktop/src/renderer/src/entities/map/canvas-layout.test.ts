import { describe, expect, it } from 'vitest';
import { createMapDocument } from '@temivo/core';
import type { MapDocument, MindMapNode } from '@temivo/core';
import { CARD_SIZE, layoutNodes, visibleAnchor } from './canvas-layout';
import type { CanvasLayout } from './canvas-layout';

function document(nodes: readonly MindMapNode[]): MapDocument {
  return createMapDocument({ id: 'map', title: 'Thinking space', nodes });
}

function expectNoOverlap(layout: CanvasLayout) {
  for (let index = 0; index < layout.nodes.length; index += 1) {
    const a = layout.nodes[index]!;
    for (const b of layout.nodes.slice(index + 1)) {
      const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      expect(overlaps, `${a.node.id} overlaps ${b.node.id}`).toBe(false);
    }
  }
}

describe('iterative spatial mind-map layout', () => {
  it('splits visible branches across both sides, extending descendants away from a centered topic', () => {
    const map = document([
      { id: 'root', parentId: null, text: 'Topic' },
      { id: 'right', parentId: 'root', text: 'First branch' },
      { id: 'right-deep', parentId: 'right', text: 'Detail' },
      { id: 'left', parentId: 'root', text: 'Second branch' },
      { id: 'left-deep', parentId: 'left', text: 'Detail' },
    ]);
    const layout = layoutNodes(map, ['root', 'right', 'left']);
    expect(layout.byId.get('root')).toMatchObject({ x: -140, y: -97, side: 'root' });
    expect(layout.byId.get('right')?.side).toBe('right');
    expect(layout.byId.get('left')?.side).toBe('left');
    expect(layout.byId.get('right-deep')?.x).toBeGreaterThan(layout.byId.get('right')!.x);
    expect(layout.byId.get('left-deep')?.x).toBeLessThan(layout.byId.get('left')!.x);
    expect(layout.byId.get('left-deep')?.color).toBe(layout.byId.get('left')?.color);
    expect(layout.byId.get('right')?.color).not.toBe(layout.byId.get('left')?.color);
    expect(layout.edges).toHaveLength(4);
    expect(layout.edges.every((edge) => edge.path.startsWith('M ') && edge.path.includes(' C '))).toBe(true);
    expect(layout.nodes.map((item) => item.node.id)).toEqual(['root', 'right', 'right-deep', 'left', 'left-deep']);
    expect(layoutNodes(map, ['left', 'right', 'root'])).toEqual(layout);
    expectNoOverlap(layout);
  });

  it('balances many siblings by subtree height instead of packing a large subtree into one crowded side', () => {
    const nodes: MindMapNode[] = [{ id: 'root', parentId: null, text: 'Topic' }];
    for (let index = 0; index < 12; index += 1) {
      nodes.push({ id: `branch-${index}`, parentId: 'root', text: 'Branch' });
      for (let child = 0; child < (index % 4) + 1; child += 1) {
        nodes.push({ id: `detail-${index}-${child}`, parentId: `branch-${index}`, text: 'Detail' });
      }
    }
    const layout = layoutNodes(document(nodes), nodes.map((node) => node.id));
    const sideHeight = (side: 'left' | 'right') => {
      const sideNodes = layout.nodes.filter((node) => node.side === side);
      return Math.max(...sideNodes.map((node) => node.y + node.height)) - Math.min(...sideNodes.map((node) => node.y));
    };
    expect(Math.abs(sideHeight('left') - sideHeight('right'))).toBeLessThanOrEqual(4 * (CARD_SIZE.height + 28));
    expect(layout.nodes.filter((node) => node.depth === 1 && node.side === 'left').length).toBeGreaterThan(1);
    expect(layout.nodes.filter((node) => node.depth === 1 && node.side === 'right').length).toBeGreaterThan(1);
    expectNoOverlap(layout);
  });

  it('keeps irregular subtrees and multiple independent roots nonoverlapping', () => {
    const nodes: MindMapNode[] = [];
    for (let index = 0; index < 180; index += 1) {
      nodes.push({ id: String(index), parentId: index % 23 === 0 ? null : String(Math.floor((index - 1) / 3)), text: 'A very long thought '.repeat(40) });
    }
    const layout = layoutNodes(document(nodes), nodes.map((node) => node.id));
    expect(layout.nodes).toHaveLength(nodes.length);
    expect(layout.edges).toHaveLength(nodes.filter((node) => node.parentId !== null).length);
    expectNoOverlap(layout);
    for (const item of layout.nodes) {
      expect(item.x).toBeGreaterThanOrEqual(layout.bounds.x);
      expect(item.y).toBeGreaterThanOrEqual(layout.bounds.y);
      expect(item.x + item.width).toBeLessThanOrEqual(layout.bounds.x + layout.bounds.width);
      expect(item.y + item.height).toBeLessThanOrEqual(layout.bounds.y + layout.bounds.height);
    }
  });

  it('uses bounded card geometry regardless of long text, descriptions, whitespace or empty content', () => {
    const map = document([
      { id: 'root', parentId: null, text: 'W'.repeat(20_000) },
      { id: 'child', parentId: 'root', text: '\n'.repeat(500) },
      { id: 'empty', parentId: 'root', text: '' },
    ]);
    const layout = layoutNodes(map, ['root']);
    expect(layout.byId.get('root')).toMatchObject({ width: CARD_SIZE.rootWidth, height: CARD_SIZE.rootHeight });
    expect(layout.byId.get('child')).toMatchObject({ width: CARD_SIZE.width, height: CARD_SIZE.height });
    expectNoOverlap(layout);
  });

  it('folds only saved descendants, retaining collapsed branch counts and visible ancestors for focus', () => {
    const map = document([
      { id: 'root', parentId: null, text: 'Root' },
      { id: 'child', parentId: 'root', text: 'Child' },
      { id: 'deep', parentId: 'child', text: 'Deep' },
      { id: 'other', parentId: null, text: 'Other' },
    ]);
    const before = JSON.stringify(map);
    const layout = layoutNodes(map, ['root', 'deep']);
    expect(layout.nodes.map((item) => item.node.id)).toEqual(['root', 'child', 'other']);
    expect(layout.byId.get('child')).toMatchObject({ childCount: 1, expanded: false });
    expect(layout.edges).toHaveLength(1);
    expect(visibleAnchor(map, layout, 'deep')).toBe('child');
    expect(visibleAnchor(map, layout, 'deleted')).toBe('root');
    expect(layoutNodes(map, ['root', 'child']).nodes).toHaveLength(4);
    expect(JSON.stringify(map)).toBe(before);
  });

  it('lays out a 12,000-node chain iteratively without a display-depth cap or stack overflow', () => {
    const nodes = Array.from({ length: 12_000 }, (_, index) => ({
      id: String(index), parentId: index === 0 ? null : String(index - 1), text: 'Detail',
    }));
    const layout = layoutNodes(document(nodes), nodes.map((node) => node.id));
    expect(layout.nodes).toHaveLength(nodes.length);
    expect(layout.edges).toHaveLength(nodes.length - 1);
    expect(layout.nodes.at(-1)?.depth).toBe(nodes.length - 1);
    expect(layout.bounds.width).toBeGreaterThan(3_000_000);
    expect(Object.values(layout.bounds).every(Number.isFinite)).toBe(true);
    expect(layout.nodes.every((node) => node.y + node.height / 2 === 0)).toBe(true);
  });

  it('supports a broad forest without connecting separate roots or depending on root-first input', () => {
    const nodes: MindMapNode[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      nodes.push({ id: `child-${index}`, parentId: `root-${index}`, text: 'Branch' });
      nodes.push({ id: `root-${index}`, parentId: null, text: 'Root' });
    }
    const layout = layoutNodes(document(nodes), nodes.map((node) => node.id));
    expect(layout.nodes).toHaveLength(2_000);
    expect(layout.edges).toHaveLength(1_000);
    expect(layout.nodes[0]?.node.id).toBe('root-0');
    expect(layout.byId.get('root-999')!.y).toBeGreaterThan(layout.byId.get('root-998')!.y + CARD_SIZE.rootHeight);
  });

  it.each(['constructor', 'toString', '__proto__', 'quoted" <node> / #'])('treats the valid identifier %s as an opaque map key', (id) => {
    const map = createMapDocument({ id, title: 'Topic', nodes: [
      { id, parentId: null, text: 'Root' }, { id: 'child', parentId: id, text: 'Branch' },
    ] });
    const layout = layoutNodes(map, [id]);
    expect(layout.byId.get(id)?.node.id).toBe(id);
    expect(layout.edges[0]?.sourceId).toBe(id);
    expect(visibleAnchor(map, layout, id)).toBe(id);
  });

  it('renders an empty map as empty geometry with finite bounds', () => {
    const map = document([]);
    const layout = layoutNodes(map, []);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(visibleAnchor(map, layout, null)).toBeNull();
  });
});
