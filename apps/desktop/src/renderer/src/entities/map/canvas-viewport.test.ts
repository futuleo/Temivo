import { describe, expect, it } from 'vitest';
import { createMapDocument } from '@temivo/core';
import type { MindMapNode } from '@temivo/core';
import { layoutNodes } from './canvas-layout';
import type { CanvasLayout, Rectangle } from './canvas-layout';
import {
  boardKeyboardAction, canStartPan, canvasViewReducer, createCanvasView, fitViewport, keyboardAction,
  MAX_SCALE, minimumScale, panViewport, revealRectangle, viewSize, wheelViewport, zoomLabel, zoomViewport,
} from './canvas-viewport';
import type { CanvasViewState, Viewport, ViewSize, WheelInput } from './canvas-viewport';

const size = { width: 1_000, height: 700 };

function layout(nodes: readonly MindMapNode[] = [
  { id: 'root', parentId: null, text: 'Topic' },
  { id: 'right', parentId: 'root', text: 'Branch' },
  { id: 'left', parentId: 'root', text: 'Branch' },
]): CanvasLayout {
  return layoutNodes(createMapDocument({ id: 'map', title: 'Map', nodes }), nodes.map((node) => node.id));
}

function state(): CanvasViewState {
  return canvasViewReducer(createCanvasView(layout(), 'root'), { type: 'resize', size });
}

function pointInView(viewport: Viewport, rectangle: Rectangle) {
  return { x: (rectangle.x + rectangle.width / 2) * viewport.scale + viewport.x, y: (rectangle.y + rectangle.height / 2) * viewport.scale + viewport.y };
}

function expectFit(viewport: Viewport, bounds: Rectangle, view: ViewSize) {
  expect(viewport.scale).toBeGreaterThan(0);
  expect(Object.values(viewport).every(Number.isFinite)).toBe(true);
  expect(bounds.x * viewport.scale + viewport.x).toBeGreaterThanOrEqual(-0.00001);
  expect(bounds.y * viewport.scale + viewport.y).toBeGreaterThanOrEqual(-0.00001);
  expect((bounds.x + bounds.width) * viewport.scale + viewport.x).toBeLessThanOrEqual(view.width + 0.00001);
  expect((bounds.y + bounds.height) * viewport.scale + viewport.y).toBeLessThanOrEqual(view.height + 0.00001);
}

describe('finite canvas viewport geometry', () => {
  it('fits all content including negative coordinates, centered forests and a tiny resized board', () => {
    const bounds = layout().bounds;
    for (const view of [size, { width: 220, height: 180 }, { width: 1, height: 1 }]) {
      const fit = fitViewport(bounds, view);
      expectFit(fit, bounds, view);
      expect(pointInView(fit, bounds)).toEqual({ x: view.width / 2, y: view.height / 2 });
    }
    expect(fitViewport({ x: 0, y: 0, width: 0, height: 0 }, size)).toEqual({ x: 500, y: 350, scale: 1 });
  });

  it('fits a deep chain below 20% and makes that scale reachable by ordinary zoom-out', () => {
    const deep = layout(Array.from({ length: 12_000 }, (_, index) => ({
      id: String(index), parentId: index === 0 ? null : String(index - 1), text: 'Detail',
    })));
    const fit = fitViewport(deep.bounds, size);
    expect(fit.scale).toBeLessThan(0.001);
    expectFit(fit, deep.bounds, size);
    const minimum = minimumScale(deep, size);
    expect(minimum).toBe(fit.scale);
    expect(zoomViewport({ x: 0, y: 0, scale: 1 }, 0, { x: 500, y: 350 }, minimum).scale).toBe(minimum);
    expect(zoomLabel(fit.scale)).not.toBe('0%');
  });

  it('fits every bound of a broad forest rather than imposing a fixed minimum zoom', () => {
    const forest = layout(Array.from({ length: 2_000 }, (_, index) => ({ id: String(index), parentId: null, text: 'Root' })));
    const fit = fitViewport(forest.bounds, size);
    expect(fit.scale).toBeLessThan(0.01);
    expectFit(fit, forest.bounds, size);
    for (const node of forest.nodes) expectFit(fit, node, size);
  });

  it('zooms around the pointer, including both bounds, without moving its world-space anchor', () => {
    const viewport = { x: -320, y: 120, scale: 0.75 };
    const pointer = { x: 172, y: 211 };
    for (const factor of [1.5, 0.0001, 1e100]) {
      const next = zoomViewport(viewport, factor, pointer, 0.2);
      expect((pointer.x - next.x) / next.scale).toBeCloseTo((pointer.x - viewport.x) / viewport.scale, 10);
      expect((pointer.y - next.y) / next.scale).toBeCloseTo((pointer.y - viewport.y) / viewport.scale, 10);
      expect(next.scale).toBeGreaterThanOrEqual(0.2);
      expect(next.scale).toBeLessThanOrEqual(MAX_SCALE);
    }
    expect(zoomViewport(viewport, NaN, pointer, 0.2)).toEqual(viewport);
  });

  it('bounds repeated transforms and rejects nonfinite gesture deltas without poisoning the view', () => {
    let current = state();
    for (let index = 0; index < 100; index += 1) {
      current = canvasViewReducer(current, { type: 'zoom', factor: 1e100 });
      current = canvasViewReducer(current, { type: 'pan', delta: { x: 1e100, y: -1e100 } });
    }
    expect(current.viewport.scale).toBe(MAX_SCALE);
    expect(Object.values(current.viewport).every(Number.isFinite)).toBe(true);
    expect(panViewport(current.viewport, { x: NaN, y: Infinity })).toEqual(current.viewport);
    expect(viewSize({ width: NaN, height: -40 })).toEqual({ width: 1, height: 1 });
  });

  it('pans trackpad deltas, normalizes line/page wheels, and reserves Ctrl/Cmd scroll for anchored zoom', () => {
    const current = state();
    const wheel: WheelInput = { deltaX: 2, deltaY: 5, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(wheelViewport(current, wheel, { x: 100, y: 100 })).toEqual(panViewport(current.viewport, { x: -2, y: -5 }));
    expect(wheelViewport(current, { ...wheel, deltaMode: 1 }, { x: 0, y: 0 })).toEqual(panViewport(current.viewport, { x: -32, y: -80 }));
    expect(wheelViewport(current, { ...wheel, deltaX: 0, deltaMode: 2 }, { x: 0, y: 0 }).y).toBe(current.viewport.y - size.height * 5);
    expect(wheelViewport(current, { ...wheel, deltaX: 0, shiftKey: true }, { x: 0, y: 0 })).toEqual(panViewport(current.viewport, { x: -5, y: 0 }));
    const zoom = wheelViewport(current, { ...wheel, ctrlKey: true }, { x: 100, y: 100 });
    expect(zoom.scale).toBeLessThan(current.viewport.scale);
    expect(wheelViewport(current, { ...wheel, metaKey: true }, { x: 100, y: 100 })).toEqual(zoom);
  });

  it('reveals offscreen selections by the minimum pan and centers cards larger than the viewport', () => {
    const current = state();
    const root = current.layout.byId.get('root')!;
    expect(revealRectangle(current.viewport, size, root)).toEqual(current.viewport);
    const reveal = revealRectangle(panViewport(current.viewport, { x: 1_000, y: 0 }), size, root);
    expect(root.x * reveal.scale + reveal.x + root.width * reveal.scale).toBeCloseTo(size.width - 40);
    const narrow = { width: 120, height: 100 };
    const oversized = revealRectangle({ x: 0, y: 0, scale: 2 }, narrow, root);
    expect(pointInView(oversized, root)).toEqual({ x: 60, y: 50 });
  });

  it('uses the first real measurement to initialize the map, not the SSR placeholder dimensions', () => {
    const automatic = layout();
    const measured = canvasViewReducer(createCanvasView(automatic, 'root'), { type: 'resize', size: { width: 350, height: 500 } });
    expect(measured.measured).toBe(true);
    expect(measured.size).toEqual({ width: 350, height: 500 });
    expect(pointInView(measured.viewport, automatic.byId.get('root')!)).toEqual({ x: 175, y: 250 });
    expect(measured.viewport.scale).toBeGreaterThanOrEqual(0.55);
    const tiny = canvasViewReducer(createCanvasView(automatic, 'root'), { type: 'resize', size: { width: 120, height: 180 } });
    expectFit(tiny.viewport, automatic.byId.get('root')!, tiny.size);
  });

  it('keeps large initial maps readable around the selected topic until Fit is explicitly requested', () => {
    const large = layout(Array.from({ length: 300 }, (_, index) => ({ id: String(index), parentId: null, text: 'Topic' })));
    const current = createCanvasView(large, '200', size);
    expect(current.viewport.scale).toBe(0.8);
    expect(pointInView(current.viewport, large.byId.get('200')!)).toEqual({ x: 500, y: 350 });
    const fitted = canvasViewReducer(current, { type: 'fit' });
    expectFit(fitted.viewport, large.bounds, size);
  });

  it('preserves user pan/zoom across unchanged saves, draft-like updates and expanded-array copies', () => {
    let current = canvasViewReducer(state(), { type: 'pan', delta: { x: -380, y: 250 } });
    current = canvasViewReducer(current, { type: 'zoom', factor: 1.2 });
    current = canvasViewReducer(current, { type: 'begin', pointerId: 1, point: { x: 0, y: 0 } });
    const synchronized = canvasViewReducer(current, { type: 'sync', layout: layout(), anchorId: 'root' });
    expect(synchronized.viewport).toEqual(current.viewport);
    expect(synchronized.gesture).toEqual(current.gesture);
    expect(canvasViewReducer(synchronized, { type: 'sync', layout: synchronized.layout, anchorId: 'root' })).toBe(synchronized);
  });

  it('preserves the selected screen position through forest addition, expansion, and re-layout', () => {
    const old = layout([{ id: 'first', parentId: null, text: 'First' }, { id: 'selected', parentId: null, text: 'Selected' }]);
    const next = layout([
      { id: 'first', parentId: null, text: 'First' }, { id: 'selected', parentId: null, text: 'Selected' },
      ...Array.from({ length: 8 }, (_, index) => ({ id: `child-${index}`, parentId: 'first', text: 'Branch' })),
    ]);
    const current = canvasViewReducer(createCanvasView(old, 'selected'), { type: 'resize', size });
    const synchronized = canvasViewReducer(current, { type: 'sync', layout: next, anchorId: 'selected' });
    expect(pointInView(synchronized.viewport, next.byId.get('selected')!)).toEqual(pointInView(current.viewport, old.byId.get('selected')!));
    expect(synchronized.viewport.scale).toBe(current.viewport.scale);
  });

  it('brings new or newly visible selections into view without fitting/resetting the user scale', () => {
    const current = canvasViewReducer(state(), { type: 'pan', delta: { x: -3_000, y: 0 } });
    const synchronized = canvasViewReducer(current, { type: 'sync', layout: current.layout, anchorId: 'left' });
    const left = current.layout.byId.get('left')!;
    expectFit(synchronized.viewport, left, size);
    expect(synchronized.viewport.scale).toBe(current.viewport.scale);
    expect(canvasViewReducer(synchronized, { type: 'reveal', nodeId: 'missing' })).toBe(synchronized);
  });

  it('preserves the world point at center on resize without snapping an intentionally offscreen selection back', () => {
    const current = canvasViewReducer(state(), { type: 'pan', delta: { x: -2_000, y: 900 } });
    const resized = canvasViewReducer(current, { type: 'resize', size: { width: 600, height: 500 } });
    expect((current.size.width / 2 - current.viewport.x) / current.viewport.scale).toBe((resized.size.width / 2 - resized.viewport.x) / resized.viewport.scale);
    expect((current.size.height / 2 - current.viewport.y) / current.viewport.scale).toBe((resized.size.height / 2 - resized.viewport.y) / resized.viewport.scale);
    expect(canvasViewReducer(resized, { type: 'resize', size: resized.size })).toBe(resized);
  });

  it('keeps a previously visible selected card accessible after narrowing the viewport', () => {
    const current = state();
    const resized = canvasViewReducer(current, { type: 'resize', size: { width: 350, height: 450 } });
    expectFit(resized.viewport, current.layout.byId.get('root')!, resized.size);
    expect(resized.viewport.scale).toBe(current.viewport.scale);
  });

  it('creates fresh viewport state for another map even when node IDs are shared', () => {
    const moved = canvasViewReducer(state(), { type: 'pan', delta: { x: 1_500, y: -200 } });
    const another = createCanvasView(layout(), 'root', size);
    expect(another.viewport).not.toEqual(moved.viewport);
    expect(another.gesture).toBeNull();
    expect(pointInView(another.viewport, another.layout.byId.get('root')!)).toEqual({ x: 500, y: 350 });
  });
});

describe('genuine board gesture state and keyboard routing without a DOM', () => {
  it('distinguishes a small click motion from pan and keeps the final pointer-up motion', () => {
    const initial = state();
    const begin = canvasViewReducer(initial, { type: 'begin', pointerId: 7, point: { x: 100, y: 100 } });
    expect(canvasViewReducer(begin, { type: 'move', pointerId: 7, point: { x: 102, y: 101 } })).toBe(begin);
    const moved = canvasViewReducer(begin, { type: 'move', pointerId: 7, point: { x: 150, y: 120 } });
    expect(moved.viewport).toEqual(panViewport(initial.viewport, { x: 50, y: 20 }));
    expect(moved.gesture?.dragged).toBe(true);
    const final = canvasViewReducer(moved, { type: 'move', pointerId: 7, point: { x: 160, y: 130 } });
    const ended = canvasViewReducer(final, { type: 'end', pointerId: 7 });
    expect(ended.gesture).toBeNull();
    expect(ended.viewport).toEqual(panViewport(initial.viewport, { x: 60, y: 30 }));
  });

  it('ignores secondary pointers and restores the starting viewport on cancel or capture loss', () => {
    const initial = state();
    const begin = canvasViewReducer(initial, { type: 'begin', pointerId: 1, point: { x: 0, y: 0 } });
    expect(canvasViewReducer(begin, { type: 'begin', pointerId: 2, point: { x: 10, y: 10 } })).toBe(begin);
    expect(canvasViewReducer(begin, { type: 'move', pointerId: 2, point: { x: 10, y: 10 } })).toBe(begin);
    expect(canvasViewReducer(begin, { type: 'end', pointerId: 2 })).toBe(begin);
    expect(canvasViewReducer(begin, { type: 'cancel', pointerId: 2 })).toBe(begin);
    const moved = canvasViewReducer(begin, { type: 'move', pointerId: 1, point: { x: 20, y: 30 } });
    const canceled = canvasViewReducer(moved, { type: 'cancel', pointerId: 1 });
    expect(canceled.viewport).toEqual(initial.viewport);
    expect(canceled.gesture).toBeNull();
    expect(canvasViewReducer(canceled, { type: 'cancel', pointerId: 1 })).toBe(canceled);
    expect(canvasViewReducer(begin, { type: 'move', pointerId: 1, point: { x: NaN, y: 10 } })).toBe(begin);
  });

  it('ends an active gesture safely when geometry changes or the board resizes', () => {
    const begin = canvasViewReducer(state(), { type: 'begin', pointerId: 1, point: { x: 0, y: 0 } });
    expect(canvasViewReducer(begin, { type: 'resize', size: { width: 700, height: 500 } }).gesture).toBeNull();
    const changed = layout([{ id: 'root', parentId: null, text: 'Topic' }]);
    expect(canvasViewReducer(begin, { type: 'sync', layout: changed, anchorId: 'root' }).gesture).toBeNull();
  });

  it('only starts mouse/pen panning on empty board space, never node controls, right-clicks or touch gestures', () => {
    const input = { pointerType: 'mouse', button: 0, isControl: false, capturedPointerId: null };
    expect(canStartPan(input)).toBe(true);
    expect(canStartPan({ ...input, pointerType: 'pen' })).toBe(true);
    expect(canStartPan({ ...input, button: 1 })).toBe(true);
    expect(canStartPan({ ...input, isControl: true })).toBe(false);
    expect(canStartPan({ ...input, button: 2 })).toBe(false);
    expect(canStartPan({ ...input, pointerType: 'touch' })).toBe(false);
    expect(canStartPan({ ...input, capturedPointerId: 0 })).toBe(false);
  });

  it('routes supported focused-board shortcuts and leaves editor/input and modified shortcuts alone', () => {
    const input = { key: '+', targetIsBoard: true, ctrlKey: false, metaKey: false, altKey: false };
    expect(boardKeyboardAction(input)).toEqual({ type: 'zoom', factor: 1.2 });
    expect(boardKeyboardAction({ ...input, targetIsBoard: false })).toBeNull();
    expect(boardKeyboardAction({ ...input, ctrlKey: true })).toBeNull();
    expect(boardKeyboardAction({ ...input, metaKey: true })).toBeNull();
    expect(boardKeyboardAction({ ...input, altKey: true })).toBeNull();
    for (const key of ['f', 'F', '0', 'Home']) expect(keyboardAction(key)).toEqual({ type: 'fit' });
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) expect(keyboardAction(key)?.type).toBe('pan');
    expect(keyboardAction('-')).toEqual({ type: 'zoom', factor: 1 / 1.2 });
    expect(keyboardAction('Escape')).toEqual({ type: 'cancel' });
    expect(keyboardAction('Delete')).toBeNull();
  });
});
