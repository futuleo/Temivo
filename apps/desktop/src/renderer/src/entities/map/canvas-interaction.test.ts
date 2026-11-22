import { describe, expect, it, vi } from 'vitest';
import { createMapDocument } from '@temivo/core';
import { createCanvasPan } from './canvas-interaction';
import { layoutNodes } from './canvas-layout';
import { canvasViewReducer, createCanvasView } from './canvas-viewport';
import type { CanvasViewAction } from './canvas-viewport';

function fixture() {
  const document = createMapDocument({ id: 'map', title: 'Map', nodes: [{ id: 'root', parentId: null, text: 'Root' }] });
  let state = createCanvasView(layoutNodes(document, []), 'root');
  const dispatch = vi.fn((action: CanvasViewAction) => { state = canvasViewReducer(state, action); });
  const captured = new Set<number>();
  const target = {
    focus: vi.fn(),
    setPointerCapture: vi.fn((id: number) => { captured.add(id); }),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: vi.fn((id: number) => { captured.delete(id); }),
  };
  const pan = createCanvasPan(dispatch);
  const input = { pointerId: 7, pointerType: 'mouse', button: 0, isControl: false, point: { x: 100, y: 100 }, target, preventDefault: vi.fn() };
  return { pan, input, target, captured, dispatch, getState: () => state };
}

describe('actual canvas pan handler using injected capture ports, no DOM or running app', () => {
  it('captures empty-board gestures and releases capture after the final up movement, not node selection', () => {
    const { pan, input, target, dispatch, getState } = fixture();
    const initial = getState().viewport;
    pan.start(input);
    expect(input.preventDefault).toHaveBeenCalledOnce();
    expect(target.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(target.setPointerCapture).toHaveBeenCalledExactlyOnceWith(7);
    pan.move(7, { x: 102, y: 101 });
    expect(getState().viewport).toEqual(initial);
    pan.end(7, { x: 150, y: 130 });
    expect(getState().viewport).toEqual({ ...initial, x: initial.x + 50, y: initial.y + 30 });
    expect(getState().gesture).toBeNull();
    expect(target.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
    const count = dispatch.mock.calls.length;
    pan.lost(7);
    expect(dispatch).toHaveBeenCalledTimes(count);
    expect(dispatch.mock.calls.every(([action]) => ['begin', 'move', 'end'].includes(action.type))).toBe(true);
  });

  it('never captures controls, touch, right-clicks, invalid points, or secondary pointers', () => {
    const { pan, input, target } = fixture();
    for (const rejected of [
      { ...input, isControl: true }, { ...input, pointerType: 'touch' }, { ...input, button: 2 },
      { ...input, point: { x: NaN, y: 0 } },
    ]) pan.start(rejected);
    expect(target.setPointerCapture).not.toHaveBeenCalled();
    expect(input.preventDefault).not.toHaveBeenCalled();
    pan.start(input);
    pan.start({ ...input, pointerId: 8 });
    pan.end(8, { x: 200, y: 200 });
    expect(target.setPointerCapture).toHaveBeenCalledOnce();
    expect(target.releasePointerCapture).not.toHaveBeenCalled();
  });

  it('rolls back a canceled pan, releases its exact capture, and ignores another pointer cancel', () => {
    const { pan, input, target, getState } = fixture();
    const initial = getState().viewport;
    pan.start(input);
    pan.move(7, { x: 140, y: 120 });
    pan.cancel(8);
    expect(getState().gesture).not.toBeNull();
    pan.cancel(7);
    expect(getState().viewport).toEqual(initial);
    expect(getState().gesture).toBeNull();
    expect(target.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('handles externally lost capture without attempting a second release', () => {
    const { pan, input, captured, target, getState } = fixture();
    const initial = getState().viewport;
    pan.start(input);
    pan.move(7, { x: 200, y: 200 });
    captured.delete(7);
    pan.lost(7);
    expect(getState().gesture).toBeNull();
    expect(getState().viewport).toEqual(initial);
    expect(target.releasePointerCapture).not.toHaveBeenCalled();
  });

  it('releases on layout/resize reset or unmount and ignores late captured events', () => {
    const { pan, input, target, dispatch } = fixture();
    pan.start(input);
    pan.release();
    expect(target.releasePointerCapture).toHaveBeenCalledOnce();
    pan.start(input);
    pan.dispose();
    expect(target.releasePointerCapture).toHaveBeenCalledTimes(2);
    const count = dispatch.mock.calls.length;
    pan.move(7, { x: 200, y: 200 });
    pan.end(7, { x: 200, y: 200 });
    pan.lost(7);
    expect(dispatch).toHaveBeenCalledTimes(count);
  });
});
