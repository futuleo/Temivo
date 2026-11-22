import type { CanvasLayout, Point, Rectangle } from './canvas-layout';

export interface Viewport extends Point {
  readonly scale: number;
}

export interface ViewSize {
  readonly width: number;
  readonly height: number;
}

interface PanGesture {
  readonly pointerId: number;
  readonly start: Point;
  readonly viewport: Viewport;
  readonly dragged: boolean;
}

export interface CanvasViewState {
  readonly layout: CanvasLayout;
  readonly anchorId: string | null;
  readonly size: ViewSize;
  readonly viewport: Viewport;
  readonly gesture: PanGesture | null;
  readonly measured: boolean;
}

export const MAX_SCALE = 2;
export const DEFAULT_VIEW_SIZE: ViewSize = { width: 960, height: 600 };
const MAX_TRANSLATION = Number.MAX_SAFE_INTEGER / 4;
const PADDING = 40;
const FOCUS_PADDING = 64;
const DRAG_THRESHOLD = 4;

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function translation(value: number): number {
  return Math.max(-MAX_TRANSLATION, Math.min(MAX_TRANSLATION, finite(value, 0)));
}

export function viewSize(size: ViewSize): ViewSize {
  return { width: Math.max(1, finite(size.width, 1)), height: Math.max(1, finite(size.height, 1)) };
}

export function viewCenter(size: ViewSize): Point {
  return { x: size.width / 2, y: size.height / 2 };
}

export function fitViewport(bounds: Rectangle, rawSize: ViewSize): Viewport {
  const size = viewSize(rawSize);
  const inset = Math.min(PADDING, Math.min(size.width, size.height) / 4);
  const scale = Math.min(1,
    (size.width - inset * 2) / Math.max(1, bounds.width),
    (size.height - inset * 2) / Math.max(1, bounds.height));
  return {
    x: translation(size.width / 2 - (bounds.x + bounds.width / 2) * scale),
    y: translation(size.height / 2 - (bounds.y + bounds.height / 2) * scale),
    scale,
  };
}

export function minimumScale(layout: CanvasLayout, size: ViewSize): number {
  // Fit remains reachable even for very wide/deep maps; no fixed minimum can fit every forest.
  return Math.min(0.2, fitViewport(layout.bounds, size).scale);
}

export function panViewport(viewport: Viewport, delta: Point): Viewport {
  return { ...viewport, x: translation(viewport.x + finite(delta.x, 0)), y: translation(viewport.y + finite(delta.y, 0)) };
}

export function zoomViewport(viewport: Viewport, factor: number, anchor: Point, lowerBound: number): Viewport {
  const scale = Math.max(Math.min(viewport.scale, lowerBound), Math.min(MAX_SCALE, viewport.scale * finite(factor, 1)));
  const ratio = scale / viewport.scale;
  return {
    x: translation(finite(anchor.x, 0) - (finite(anchor.x, 0) - viewport.x) * ratio),
    y: translation(finite(anchor.y, 0) - (finite(anchor.y, 0) - viewport.y) * ratio),
    scale,
  };
}

export function revealRectangle(viewport: Viewport, rawSize: ViewSize, rectangle: Rectangle, padding = PADDING): Viewport {
  const size = viewSize(rawSize);
  const margin = Math.min(padding, Math.min(size.width, size.height) / 4);
  const left = rectangle.x * viewport.scale + viewport.x;
  const top = rectangle.y * viewport.scale + viewport.y;
  const width = rectangle.width * viewport.scale;
  const height = rectangle.height * viewport.scale;
  const shift = (start: number, length: number, available: number) => {
    if (length > available - margin * 2) return available / 2 - (start + length / 2);
    if (start < margin) return margin - start;
    if (start + length > available - margin) return available - margin - start - length;
    return 0;
  };
  return panViewport(viewport, { x: shift(left, width, size.width), y: shift(top, height, size.height) });
}

export function clientRectangleToCanvas(rectangle: Rectangle, boardOrigin: Point, paintedViewport: Viewport): Rectangle {
  return {
    x: (rectangle.x - boardOrigin.x - paintedViewport.x) / paintedViewport.scale,
    y: (rectangle.y - boardOrigin.y - paintedViewport.y) / paintedViewport.scale,
    width: rectangle.width / paintedViewport.scale,
    height: rectangle.height / paintedViewport.scale,
  };
}

export function revealFocusedControl(viewport: Viewport, rawSize: ViewSize, rectangle: Rectangle): Viewport {
  const size = viewSize(rawSize);
  // Keep keyboard targets clear of the stationary caption and floating view controls.
  const margin = Math.min(FOCUS_PADDING, Math.min(size.width, size.height) / 4);
  const scale = Math.min(viewport.scale,
    (size.width - margin * 2) / Math.max(1, rectangle.width),
    (size.height - margin * 2) / Math.max(1, rectangle.height));
  const center = {
    x: (rectangle.x + rectangle.width / 2) * viewport.scale + viewport.x,
    y: (rectangle.y + rectangle.height / 2) * viewport.scale + viewport.y,
  };
  const zoomed = zoomViewport(viewport, scale / viewport.scale, center, scale);
  return revealRectangle(zoomed, size, rectangle, FOCUS_PADDING);
}

function initialViewport(layout: CanvasLayout, size: ViewSize, anchorId: string | null): Viewport {
  const fit = fitViewport(layout.bounds, size);
  const anchor = anchorId === null ? undefined : layout.byId.get(anchorId);
  if (fit.scale >= 0.55 || !anchor) return fit;
  const scale = Math.min(0.8, fitViewport(anchor, size).scale);
  return {
    x: translation(size.width / 2 - (anchor.x + anchor.width / 2) * scale),
    y: translation(size.height / 2 - (anchor.y + anchor.height / 2) * scale),
    scale,
  };
}

export function createCanvasView(layout: CanvasLayout, anchorId: string | null, rawSize = DEFAULT_VIEW_SIZE): CanvasViewState {
  const size = viewSize(rawSize);
  return { layout, anchorId, size, viewport: initialViewport(layout, size, anchorId), gesture: null, measured: false };
}

export interface WheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export function wheelViewport(state: CanvasViewState, wheel: WheelInput, anchor: Point): Viewport {
  const unit = wheel.deltaMode === 1 ? 16 : 1;
  const x = finite(wheel.deltaX, 0) * (wheel.deltaMode === 2 ? state.size.width : unit);
  const y = finite(wheel.deltaY, 0) * (wheel.deltaMode === 2 ? state.size.height : unit);
  if (wheel.ctrlKey || wheel.metaKey) {
    const factor = Math.exp(-Math.max(-240, Math.min(240, y)) * 0.006);
    return zoomViewport(state.viewport, factor, anchor, minimumScale(state.layout, state.size));
  }
  return panViewport(state.viewport, { x: wheel.shiftKey && x === 0 ? -y : -x, y: wheel.shiftKey && x === 0 ? 0 : -y });
}

export type CanvasViewAction =
  | { type: 'sync'; layout: CanvasLayout; anchorId: string | null }
  | { type: 'resize'; size: ViewSize }
  | { type: 'zoom'; factor: number; anchor?: Point }
  | { type: 'pan'; delta: Point }
  | { type: 'wheel'; wheel: WheelInput; anchor: Point }
  | { type: 'fit' }
  | { type: 'reveal'; nodeId: string }
  | { type: 'focus-control'; rectangle: Rectangle }
  | { type: 'begin'; pointerId: number; point: Point }
  | { type: 'move'; pointerId: number; point: Point }
  | { type: 'end'; pointerId: number }
  | { type: 'cancel'; pointerId?: number };

export function keyboardAction(key: string): CanvasViewAction | null {
  switch (key) {
    case '+': case '=': return { type: 'zoom', factor: 1.2 };
    case '-': case '_': return { type: 'zoom', factor: 1 / 1.2 };
    case '0': case 'f': case 'F': case 'Home': return { type: 'fit' };
    case 'ArrowLeft': return { type: 'pan', delta: { x: 64, y: 0 } };
    case 'ArrowRight': return { type: 'pan', delta: { x: -64, y: 0 } };
    case 'ArrowUp': return { type: 'pan', delta: { x: 0, y: 64 } };
    case 'ArrowDown': return { type: 'pan', delta: { x: 0, y: -64 } };
    case 'Escape': return { type: 'cancel' };
    default: return null;
  }
}

export function boardKeyboardAction(input: {
  readonly key: string;
  readonly targetIsBoard: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}): CanvasViewAction | null {
  return input.targetIsBoard && !input.ctrlKey && !input.metaKey && !input.altKey ? keyboardAction(input.key) : null;
}

export function canStartPan(input: {
  readonly pointerType: string;
  readonly button: number;
  readonly isControl: boolean;
  readonly capturedPointerId: number | null;
}): boolean {
  return input.pointerType !== 'touch' && (input.button === 0 || input.button === 1)
    && !input.isControl && input.capturedPointerId === null;
}

export function canvasViewReducer(state: CanvasViewState, action: CanvasViewAction): CanvasViewState {
  switch (action.type) {
    case 'sync': {
      if (state.layout === action.layout && state.anchorId === action.anchorId) return state;
      const previous = state.anchorId === null ? undefined : state.layout.byId.get(state.anchorId);
      const next = action.anchorId === null ? undefined : action.layout.byId.get(action.anchorId);
      let viewport = state.viewport;
      if (previous && next && state.anchorId === action.anchorId) {
        viewport = panViewport(viewport, {
          x: (previous.x - next.x) * viewport.scale,
          y: (previous.y - next.y) * viewport.scale,
        });
      } else if (next) viewport = revealRectangle(viewport, state.size, next);
      const geometryChanged = state.layout.nodes.length !== action.layout.nodes.length
        || state.layout.nodes.some((node, index) => {
          const current = action.layout.nodes[index];
          return !current || node.node.id !== current.node.id || node.x !== current.x || node.y !== current.y;
        });
      return {
        ...state, layout: action.layout, anchorId: action.anchorId, viewport,
        gesture: geometryChanged || state.anchorId !== action.anchorId ? null : state.gesture,
      };
    }
    case 'resize': {
      const size = viewSize(action.size);
      if (!state.measured) return { ...state, size, viewport: initialViewport(state.layout, size, state.anchorId), measured: true, gesture: null };
      if (size.width === state.size.width && size.height === state.size.height) return state;
      let viewport = panViewport(state.viewport, { x: (size.width - state.size.width) / 2, y: (size.height - state.size.height) / 2 });
      const anchor = state.anchorId === null ? undefined : state.layout.byId.get(state.anchorId);
      if (anchor) {
        const centerX = (anchor.x + anchor.width / 2) * state.viewport.scale + state.viewport.x;
        const centerY = (anchor.y + anchor.height / 2) * state.viewport.scale + state.viewport.y;
        if (centerX >= 0 && centerX <= state.size.width && centerY >= 0 && centerY <= state.size.height) {
          viewport = revealRectangle(viewport, size, anchor);
        }
      }
      return { ...state, size, viewport, gesture: null };
    }
    case 'zoom':
      return { ...state, viewport: zoomViewport(state.viewport, action.factor, action.anchor ?? viewCenter(state.size), minimumScale(state.layout, state.size)), gesture: null };
    case 'pan':
      return { ...state, viewport: panViewport(state.viewport, action.delta), gesture: null };
    case 'wheel':
      return { ...state, viewport: wheelViewport(state, action.wheel, action.anchor), gesture: null };
    case 'fit':
      return { ...state, viewport: fitViewport(state.layout.bounds, state.size), gesture: null };
    case 'reveal': {
      const node = state.layout.byId.get(action.nodeId);
      return node ? { ...state, viewport: revealRectangle(state.viewport, state.size, node), gesture: null } : state;
    }
    case 'focus-control':
      return { ...state, viewport: revealFocusedControl(state.viewport, state.size, action.rectangle), gesture: null };
    case 'begin':
      if (state.gesture || !Number.isFinite(action.point.x) || !Number.isFinite(action.point.y)) return state;
      return { ...state, gesture: { pointerId: action.pointerId, start: action.point, viewport: state.viewport, dragged: false } };
    case 'move': {
      const gesture = state.gesture;
      if (!gesture || gesture.pointerId !== action.pointerId || !Number.isFinite(action.point.x) || !Number.isFinite(action.point.y)) return state;
      const delta = { x: action.point.x - gesture.start.x, y: action.point.y - gesture.start.y };
      const dragged = gesture.dragged || Math.hypot(delta.x, delta.y) >= DRAG_THRESHOLD;
      if (!dragged) return state;
      return { ...state, viewport: panViewport(gesture.viewport, delta), gesture: { ...gesture, dragged } };
    }
    case 'end':
      return state.gesture?.pointerId === action.pointerId ? { ...state, gesture: null } : state;
    case 'cancel':
      return state.gesture && (action.pointerId === undefined || action.pointerId === state.gesture.pointerId)
        ? { ...state, viewport: state.gesture.viewport, gesture: null } : state;
  }
}

export function zoomLabel(scale: number): string {
  const percent = scale * 100;
  return `${percent >= 1 ? Math.round(percent) : percent.toPrecision(2)}%`;
}
