import type { MapDocument } from '@temivo/core';
import { projectNodes } from './model';
import type { NodeRow } from './model';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rectangle extends Point {
  readonly width: number;
  readonly height: number;
}

export interface CanvasNode extends NodeRow, Rectangle {
  readonly side: 'root' | 'left' | 'right';
  readonly color: number;
}

export interface CanvasEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly color: number;
  readonly path: string;
}

export interface CanvasLayout {
  readonly nodes: readonly CanvasNode[];
  readonly byId: ReadonlyMap<string, CanvasNode>;
  readonly edges: readonly CanvasEdge[];
  readonly bounds: Rectangle;
}

export const CARD_SIZE = { width: 240, height: 178, rootWidth: 280, rootHeight: 194 } as const;
export const BRANCH_COLORS = ['#488572', '#6b85b4', '#b78065', '#9479ad', '#ad914b', '#578b99'] as const;
const SIBLING_GAP = 28;
const BRANCH_GAP = 84;
const FOREST_GAP = 100;

function groupHeight(ids: readonly string[], spans: ReadonlyMap<string, number>): number {
  return ids.reduce((sum, id) => sum + (spans.get(id) ?? CARD_SIZE.height), 0)
    + Math.max(0, ids.length - 1) * SIBLING_GAP;
}

export function connectionPath(parent: Rectangle, child: Rectangle, side: 'left' | 'right'): string {
  const direction = side === 'right' ? 1 : -1;
  const startX = parent.x + (direction === 1 ? parent.width : 0);
  const endX = child.x + (direction === 1 ? 0 : child.width);
  const startY = parent.y + parent.height / 2;
  const endY = child.y + child.height / 2;
  const bend = Math.abs(endX - startX) * 0.55;
  return `M ${startX} ${startY} C ${startX + direction * bend} ${startY}, ${endX - direction * bend} ${endY}, ${endX} ${endY}`;
}

export function layoutNodes(document: MapDocument, expandedIds: readonly string[]): CanvasLayout {
  const rows = projectNodes(document, expandedIds);
  const children = new Map<string, string[]>();
  const branchColors = new Map<string, number>();
  const roots: string[] = [];
  for (const { node } of rows) {
    if (node.parentId === null) roots.push(node.id);
    else {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node.id);
      children.set(node.parentId, siblings);
    }
  }

  const spans = new Map<string, number>();
  // Reverse preorder gives child spans before parents without recursive traversal.
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    spans.set(row.node.id, Math.max(CARD_SIZE.height, groupHeight(children.get(row.node.id) ?? [], spans)));
  }

  const sides = new Map<string, { left: string[]; right: string[] }>();
  for (const id of roots) {
    const left: string[] = [];
    const right: string[] = [];
    let leftHeight = 0;
    let rightHeight = 0;
    for (const childId of children.get(id) ?? []) {
      branchColors.set(childId, (left.length + right.length) % BRANCH_COLORS.length);
      const span = spans.get(childId) ?? CARD_SIZE.height;
      if (rightHeight <= leftHeight) {
        rightHeight += span + (right.length ? SIBLING_GAP : 0);
        right.push(childId);
      } else {
        leftHeight += span + (left.length ? SIBLING_GAP : 0);
        left.push(childId);
      }
    }
    sides.set(id, { left, right });
    spans.set(id, Math.max(CARD_SIZE.rootHeight, leftHeight, rightHeight));
  }

  const totalHeight = roots.reduce((sum, id) => sum + (spans.get(id) ?? CARD_SIZE.rootHeight), 0)
    + Math.max(0, roots.length - 1) * FOREST_GAP;
  const positions = new Map<string, Rectangle & { side: CanvasNode['side']; color: number }>();
  let rootTop = -totalHeight / 2;
  for (const rootId of roots) {
    const span = spans.get(rootId) ?? CARD_SIZE.rootHeight;
    positions.set(rootId, {
      x: -CARD_SIZE.rootWidth / 2, y: rootTop + span / 2 - CARD_SIZE.rootHeight / 2,
      width: CARD_SIZE.rootWidth, height: CARD_SIZE.rootHeight, side: 'root', color: 0,
    });
    rootTop += span + FOREST_GAP;
  }

  for (const row of rows) {
    const parent = positions.get(row.node.id);
    if (!parent) continue;
    const placeGroup = (ids: readonly string[], side: 'left' | 'right') => {
      let top = parent.y + parent.height / 2 - groupHeight(ids, spans) / 2;
      for (const childId of ids) {
        const span = spans.get(childId) ?? CARD_SIZE.height;
        positions.set(childId, {
          x: side === 'right' ? parent.x + parent.width + BRANCH_GAP : parent.x - BRANCH_GAP - CARD_SIZE.width,
          y: top + span / 2 - CARD_SIZE.height / 2,
          width: CARD_SIZE.width, height: CARD_SIZE.height, side,
          color: parent.side === 'root' ? (branchColors.get(childId) ?? 0) : parent.color,
        });
        top += span + SIBLING_GAP;
      }
    };
    if (parent.side === 'root') {
      const groups = sides.get(row.node.id);
      placeGroup(groups?.left ?? [], 'left');
      placeGroup(groups?.right ?? [], 'right');
    } else placeGroup(children.get(row.node.id) ?? [], parent.side);
  }

  const nodes: CanvasNode[] = [];
  const byId = new Map<string, CanvasNode>();
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const row of rows) {
    const position = positions.get(row.node.id);
    if (!position) continue;
    const node = { ...row, ...position };
    nodes.push(node);
    byId.set(row.node.id, node);
    left = Math.min(left, node.x);
    top = Math.min(top, node.y);
    right = Math.max(right, node.x + node.width);
    bottom = Math.max(bottom, node.y + node.height);
  }
  const edges: CanvasEdge[] = [];
  for (const node of nodes) {
    const parent = node.node.parentId === null ? undefined : byId.get(node.node.parentId);
    if (parent && node.side !== 'root') {
      edges.push({ sourceId: parent.node.id, targetId: node.node.id, color: node.color, path: connectionPath(parent, node, node.side) });
    }
  }
  return {
    nodes, byId, edges,
    bounds: nodes.length ? { x: left, y: top, width: right - left, height: bottom - top } : { x: 0, y: 0, width: 0, height: 0 },
  };
}

export function visibleAnchor(document: MapDocument, layout: CanvasLayout, selectedId: string | null): string | null {
  const parents = new Map(document.map.nodes.map((node) => [node.id, node.parentId]));
  let id = selectedId;
  while (id !== null) {
    if (layout.byId.has(id)) return id;
    id = parents.get(id) ?? null;
  }
  return layout.nodes[0]?.node.id ?? null;
}
