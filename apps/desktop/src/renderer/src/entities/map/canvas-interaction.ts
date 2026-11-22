import type { Point } from './canvas-layout';
import { canStartPan } from './canvas-viewport';
import type { CanvasViewAction } from './canvas-viewport';

interface CaptureTarget {
  focus: (options: { preventScroll: boolean }) => void;
  setPointerCapture: (pointerId: number) => void;
  hasPointerCapture: (pointerId: number) => boolean;
  releasePointerCapture: (pointerId: number) => void;
}

interface PanInput {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly button: number;
  readonly point: Point;
  readonly isControl: boolean;
  readonly target: CaptureTarget;
  readonly preventDefault: () => void;
}

export function createCanvasPan(dispatch: (action: CanvasViewAction) => void) {
  let captured: { pointerId: number; target: CaptureTarget } | null = null;
  const release = () => {
    const current = captured;
    captured = null;
    if (current?.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
  };
  return {
    start(input: PanInput) {
      if (!canStartPan({ ...input, capturedPointerId: captured?.pointerId ?? null })
        || !Number.isFinite(input.point.x) || !Number.isFinite(input.point.y)) return;
      input.preventDefault();
      input.target.focus({ preventScroll: true });
      input.target.setPointerCapture(input.pointerId);
      captured = { pointerId: input.pointerId, target: input.target };
      dispatch({ type: 'begin', pointerId: input.pointerId, point: input.point });
    },
    move(pointerId: number, point: Point) {
      if (captured?.pointerId === pointerId) dispatch({ type: 'move', pointerId, point });
    },
    end(pointerId: number, point: Point) {
      if (captured?.pointerId !== pointerId) return;
      dispatch({ type: 'move', pointerId, point });
      dispatch({ type: 'end', pointerId });
      release();
    },
    cancel(pointerId: number) {
      if (captured?.pointerId !== pointerId) return;
      dispatch({ type: 'cancel', pointerId });
      release();
    },
    lost(pointerId: number) {
      if (captured?.pointerId !== pointerId) return;
      captured = null;
      dispatch({ type: 'cancel', pointerId });
    },
    release,
    dispose: release,
  };
}
