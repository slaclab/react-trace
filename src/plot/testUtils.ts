// Test helpers for the plot layers.
//
// `projectionOf` builds a full projection from plain grid fakes.
//
// `firePointer` dispatches a bubbling, cancelable PointerEvent (MouseEvent
// where the environment has none) at `el`. jsdom lays nothing out, so every
// getBoundingClientRect is zero and clientX/clientY ARE wrapper-local pixels.

import { inRect, type GridProjection, type Projection } from './geometry';

/** A {@link Projection} over `grids` (grid 0 first), as `buildProjection` shapes one. */
export function projectionOf(...grids: [GridProjection, ...GridProjection[]]): Projection {
  return {
    ...grids[0],
    grids,
    gridOf: (axisId) => grids.find((g) => g.axisIds.includes(axisId)),
    gridAt: (px, py) => grids.find((g) => inRect(g.gridRect, px, py)),
  };
}

export interface PointerOpts {
  x?: number;
  y?: number;
  button?: number;
  /** Defaults to 1 for pointerdown/pointermove, 0 otherwise. */
  buttons?: number;
  shiftKey?: boolean;
  pointerId?: number;
}

export function firePointer(el: EventTarget, type: string, opts: PointerOpts = {}): MouseEvent {
  const pressed = type === 'pointerdown' || type === 'pointermove';
  const init: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: opts.x ?? 0,
    clientY: opts.y ?? 0,
    button: opts.button ?? 0,
    buttons: opts.buttons ?? (pressed ? 1 : 0),
    shiftKey: opts.shiftKey ?? false,
    pointerId: opts.pointerId ?? 1,
    pointerType: 'mouse',
    isPrimary: true,
  };
  const Ctor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  const ev = new Ctor(type, init);
  el.dispatchEvent(ev);
  return ev;
}

/** A plain MouseEvent (mousedown / mousemove / mouseup) at wrapper-local px. */
export function fireMouse(
  el: EventTarget,
  type: string,
  opts: Omit<PointerOpts, 'pointerId'> = {}
): MouseEvent {
  const pressed = type === 'mousedown' || type === 'mousemove';
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: opts.x ?? 0,
    clientY: opts.y ?? 0,
    button: opts.button ?? 0,
    buttons: opts.buttons ?? (pressed ? 1 : 0),
    shiftKey: opts.shiftKey ?? false,
  });
  el.dispatchEvent(ev);
  return ev;
}
