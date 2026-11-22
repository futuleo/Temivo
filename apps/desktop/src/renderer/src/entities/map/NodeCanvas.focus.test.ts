import { Children, isValidElement } from 'react';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapDocument } from '@temivo/core';
import { CanvasNodeCard, NodeCanvas } from './NodeCanvas';
import type { NodeCanvasProps } from './NodeCanvas';
import { layoutNodes } from './canvas-layout';
import type { Rectangle } from './canvas-layout';
import { canvasViewReducer, createCanvasView } from './canvas-viewport';
import type { CanvasViewAction, CanvasViewState, Viewport, WheelInput } from './canvas-viewport';

interface InjectedWheel extends WheelInput {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
}

interface InjectedBoard {
  getBoundingClientRect: () => Rectangle & { left: number; top: number };
  readonly scrollLeft: number;
  readonly scrollTop: number;
  addEventListener: (type: string, listener: (event: InjectedWheel) => void) => void;
  removeEventListener: (type: string, listener: (event: InjectedWheel) => void) => void;
}

const hooks = vi.hoisted(() => ({
  view: null as CanvasViewState | null,
  board: null as InjectedBoard | null,
  dispatch: vi.fn<(action: CanvasViewAction) => void>(),
  effects: [] as (() => void | (() => void))[],
  wheel: null as ((event: InjectedWheel) => void) | null,
}));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  return {
    ...actual,
    useId: () => 'focus-fixture',
    useMemo: (create: () => unknown) => create(),
    useRef: () => ({ current: hooks.board }),
    useReducer: () => [hooks.view, hooks.dispatch],
    useLayoutEffect: () => undefined,
    useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
  };
});

interface FocusTarget {
  matches: (selector: string) => boolean;
  getBoundingClientRect: () => Rectangle;
}

interface TreeProps {
  children?: ReactNode;
  className?: string;
  style?: { transform?: string };
  onFocus?: (event: { target: FocusTarget }) => void;
}

function elements(node: ReactNode): ReactElement<TreeProps>[] {
  if (!isValidElement<TreeProps>(node)) return [];
  return [node, ...Children.toArray(node.props.children).flatMap(elements)];
}

function renderBoard(props: NodeCanvasProps): ReactElement<TreeProps> {
  const shell = NodeCanvas(props);
  expect(typeof shell.type).toBe('function');
  const component = shell.type as (props: NodeCanvasProps) => ReactElement<TreeProps>;
  return component(props);
}

const boardBounds = { x: 42, y: 83, width: 350, height: 450 };

function screenBounds(rectangle: Rectangle, viewport: Viewport): Rectangle {
  return {
    x: boardBounds.x + viewport.x + rectangle.x * viewport.scale,
    y: boardBounds.y + viewport.y + rectangle.y * viewport.scale,
    width: rectangle.width * viewport.scale, height: rectangle.height * viewport.scale,
  };
}

function expectVisible(rectangle: Rectangle) {
  expect(rectangle.x).toBeGreaterThanOrEqual(boardBounds.x + 64 - 0.00001);
  expect(rectangle.y).toBeGreaterThanOrEqual(boardBounds.y + 64 - 0.00001);
  expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(boardBounds.x + boardBounds.width - 64 + 0.00001);
  expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(boardBounds.y + boardBounds.height - 64 + 0.00001);
}

function fixture(nodeId: string, controlClass: string) {
  const document = createMapDocument({ id: 'map', title: 'Map', nodes: [
    { id: 'root', parentId: null, text: 'Topic' },
    { id: 'right', parentId: 'root', text: 'Right' },
    { id: 'right-detail', parentId: 'right', text: 'Detail' },
    { id: 'left', parentId: 'root', text: 'Left' },
    { id: 'left-detail', parentId: 'left', text: 'Detail' },
  ] });
  const expandedNodeIds = ['root', 'left', 'right'];
  const layout = layoutNodes(document, expandedNodeIds);
  const item = layout.byId.get(nodeId)!;
  hooks.view = {
    ...createCanvasView(layout, nodeId, boardBounds), measured: true,
    viewport: {
      x: boardBounds.width / 2 - (item.x + item.width / 2) * 2,
      y: boardBounds.height / 2 - (item.y + item.height / 2) * 2,
      scale: 2,
    },
  };
  hooks.dispatch.mockImplementation((action) => { hooks.view = canvasViewReducer(hooks.view!, action); });
  hooks.board = {
    getBoundingClientRect: () => ({ ...boardBounds, left: boardBounds.x, top: boardBounds.y }),
    get scrollLeft(): never { throw new Error('Native scrolling is not a canvas camera.'); },
    get scrollTop(): never { throw new Error('Native scrolling is not a canvas camera.'); },
    addEventListener: (type: string, listener: (event: InjectedWheel) => void) => {
      if (type === 'wheel') hooks.wheel = listener;
    },
    removeEventListener: vi.fn(),
  };
  const callbacks = { onSelect: vi.fn(), onToggle: vi.fn(), onOpenWorld: vi.fn() };
  const props: NodeCanvasProps = {
    document, expandedNodeIds, selectedNodeId: nodeId,
    links: ['root', 'left', 'right'].map((id) => ({ sourceMapId: 'map', sourceNodeId: id, targetMapId: 'other' })),
    ...callbacks,
  };
  const tree = renderBoard(props);
  const cardElement = elements(tree).find((element) => {
    return element.type === CanvasNodeCard
      && isValidElement<ComponentProps<typeof CanvasNodeCard>>(element) && element.props.item.node.id === nodeId;
  })!;
  expect(isValidElement<ComponentProps<typeof CanvasNodeCard>>(cardElement)).toBe(true);
  const card = CanvasNodeCard((cardElement as ReactElement<ComponentProps<typeof CanvasNodeCard>>).props);
  expect(elements(card).some((element) => element.type === 'button' && element.props.className === controlClass)).toBe(true);
  const rectangle = controlClass === 'branch-toggle'
    ? { x: item.x + item.width - 60, y: item.y + item.height - 32, width: 48, height: 22 }
    : controlClass === 'world-link'
      ? { x: item.x + 12, y: item.y + item.height - 32, width: 90, height: 22 }
      : { x: item.x + 1, y: item.y + 1, width: item.width - 2, height: item.height - 34 };
  const paintedViewport = hooks.view.viewport;
  const target = {
    matches: (selector: string) => selector === ':focus-visible',
    getBoundingClientRect: vi.fn(() => screenBounds(rectangle, paintedViewport)),
  };
  return { card, target, rectangle, props, tree, callbacks };
}

function focus(card: ReactNode, target: FocusTarget) {
  expect(isValidElement<TreeProps>(card)).toBe(true);
  if (isValidElement<TreeProps>(card)) card.props.onFocus?.({ target });
}

describe('actual NodeCanvas focused-control pipeline with injected bounds, not a DOM/browser', () => {
  beforeEach(() => {
    hooks.view = null;
    hooks.board = null;
    hooks.effects = [];
    hooks.wheel = null;
    hooks.dispatch.mockReset();
  });

  it.each([
    ['root', 'branch-toggle'], ['root', 'world-link'],
    ['left', 'branch-toggle'], ['left', 'world-link'],
    ['right', 'branch-toggle'], ['right', 'world-link'],
  ])('reveals the focused %s %s at 350px / 200%, not the oversized card', (nodeId, controlClass) => {
    const { card, target, rectangle, callbacks } = fixture(nodeId, controlClass);
    const before = screenBounds(rectangle, hooks.view!.viewport);
    expect(before.x < boardBounds.x || before.x + before.width > boardBounds.x + boardBounds.width).toBe(true);
    focus(card, target);
    expectVisible(screenBounds(rectangle, hooks.view!.viewport));
    expect(target.getBoundingClientRect).toHaveBeenCalledOnce();
    expect(hooks.view!.viewport.scale).toBe(2);
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
  });

  it('reduces zoom only when the focused selection button itself is too large to fit', () => {
    const { card, target, rectangle } = fixture('root', 'node-content');
    focus(card, target);
    expectVisible(screenBounds(rectangle, hooks.view!.viewport));
    expect(hooks.view!.viewport.scale).toBeLessThan(2);
    expect(hooks.view!.viewport.scale).toBeGreaterThan(0);
  });

  it('converts measured bounds with the painted camera even when another camera update is already queued', () => {
    const { card, target, rectangle } = fixture('root', 'branch-toggle');
    hooks.view = canvasViewReducer(hooks.view!, { type: 'pan', delta: { x: 80, y: 120 } });
    focus(card, target);
    expect(hooks.dispatch).toHaveBeenLastCalledWith({ type: 'focus-control', rectangle });
    expectVisible(screenBounds(rectangle, hooks.view!.viewport));
    expect(hooks.view!.viewport.scale).toBe(2);
  });

  it('keeps overlays outside the moving scene and wheel zoom pointer-anchored after focus without native offsets', () => {
    const { card, target, props, rectangle } = fixture('root', 'branch-toggle');
    for (const effect of [...hooks.effects]) effect();
    focus(card, target);
    expectVisible(screenBounds(rectangle, hooks.view!.viewport));
    const tree = renderBoard(props);
    const scene = elements(tree).find((element) => element.props.className === 'canvas-scene')!;
    const overlays = ['canvas-caption', 'canvas-toolbar', 'canvas-help'];
    expect(elements(scene).some((element) => overlays.includes(element.props.className ?? ''))).toBe(false);
    const beforeStyles = overlays.map((name) => elements(tree).find((element) => element.props.className === name)?.props.style);
    const pointer = { x: 123, y: 147 };
    const before = hooks.view!.viewport;
    const world = { x: (pointer.x - before.x) / before.scale, y: (pointer.y - before.y) / before.scale };
    hooks.wheel!({
      deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false,
      clientX: boardBounds.x + pointer.x, clientY: boardBounds.y + pointer.y, preventDefault: vi.fn(),
    });
    const after = hooks.view!.viewport;
    expect((pointer.x - after.x) / after.scale).toBeCloseTo(world.x, 10);
    expect((pointer.y - after.y) / after.scale).toBeCloseTo(world.y, 10);
    const updated = elements(renderBoard(props));
    expect(overlays.map((name) => updated.find((element) => element.props.className === name)?.props.style)).toEqual(beforeStyles);
    expect(updated.find((element) => element.props.className === 'canvas-scene')?.props.style?.transform).not.toBe(scene.props.style?.transform);
  });

  it('does not shift the camera or select a node on ordinary pointer focus', () => {
    const { card, target } = fixture('root', 'branch-toggle');
    const before = hooks.view!.viewport;
    focus(card, { ...target, matches: () => false });
    expect(hooks.view!.viewport).toEqual(before);
    expect(target.getBoundingClientRect).not.toHaveBeenCalled();
    expect(hooks.dispatch).not.toHaveBeenCalled();
  });
});
