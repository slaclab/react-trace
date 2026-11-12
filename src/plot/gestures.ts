// The plot gesture layer: ONE set of pointer and wheel gestures every plot
// tool mounts on its wrapper, so Trace, Correlation and Waveform
// behave alike and differ only in what they plot.
//
//   Left-drag    on a Y band stretches that axis about its centre (down
//                widens); on the X band stretches the X axis (a surface may
//                own that drag: Trace's time band anchors at its right edge
//                and keeps following now). In the plot area it pans or draws
//                a zoom box, as the strip's drag mode says.
//   Pan          moves the X axis and every manual Y axis of the grid so the
//                content follows the pointer; an auto-scaled Y axis stays
//                auto-scaled.
//   Zoom box     zooms both axes to the box on release. A box thinner than
//                THIN_BOX_PX in one direction zooms the other axis only; a
//                box thin both ways is a click and writes nothing.
//   Wheel        over the plot area zooms the X axis and every Y axis of the
//                grid about the cursor; over an axis band zooms that axis
//                only. Shift or a sideways scroll pans the X axis; Alt zooms
//                the grid's primary Y alone; a pinch (ctrl/meta) always zooms.
//   Double-click on a band returns that axis to auto-scale; in the plot area
//                every axis of the grid.
//
// A press on plot chrome, or one the drawing layer claims, is never a
// gesture. Drags track on the plot's own window (a detached plot's too) and
// end on release, on a lost release (`buttons === 0`) and on blur. Every drag
// coalesces its writes to one per animation frame and runs off the extents
// captured at press, never the live ones a write re-renders. The first write
// to an auto-scaled axis freezes it, and the layer marks the axis manual at
// once so a burst of events never freezes it twice.
//
// The tool supplies a `PlotGestureSurface`: its geometry, its axes, how a
// value maps to a pixel, and its writers. The surface is read at event time
// through a ref, so the listeners are installed once per mount.
//
// No colour literals here (src/plot is literal-guarded).
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import {
  DRAG_THRESHOLD_PX,
  inRect,
  isPlotChrome,
  normalizeWheelDelta,
  panExtentBy,
  stretchExtent,
  stretchFactorX,
  stretchFactorY,
  toS,
  wheelFactor,
  zoomExtentAt,
  type Extent,
  type GridRect,
} from './geometry';
import type { DragMode } from './plotToggles';

/** One axis a gesture can move. The layer flips `auto` to false when it freezes it. */
export interface GestureAxis {
  id: string;
  dim: 'x' | 'y';
  log: boolean;
  /** Follows the data; the first write of a gesture freezes it. */
  auto: boolean;
  /** No writer: the gestures leave it alone. */
  fixed?: boolean;
}

/** One plot grid: its rect in wrapper-local px, its X axis and its Y axes. */
export interface GestureGrid {
  rect: GridRect;
  x: GestureAxis;
  /** In order; the first is the grid's primary Y (Alt+wheel). */
  ys: readonly GestureAxis[];
}

/** The axis band under a pointer and the grid it belongs to. */
export interface AxisHit {
  axis: GestureAxis;
  grid: GestureGrid;
}

/** The slice of the live chart the layer needs. */
export interface GestureChart {
  getWidth(): number;
  getHeight(): number;
  /** Sets the canvas cursor (zrender re-stamps its own on every move). */
  setCursor(cursor: string): void;
}

export interface AxisWriteOptions {
  /** Turn an auto-scaled axis manual with this write. */
  freeze: boolean;
  /** Part of a wheel burst: a surface may coalesce these per frame. */
  wheel: boolean;
}

/** A drag of the X band the surface runs itself (`move` gets the total dx). */
export interface XBandDrag {
  move(dx: number): void;
  /** `commit`: deliver what is pending; false on cleanup. */
  end(commit: boolean): void;
}

/** What a plot tool hands the gesture layer. */
export interface PlotGestureSurface {
  /** The live chart; null while there is none. */
  chart(): GestureChart | null;
  grids(): readonly GestureGrid[];
  /** The axis band under the wrapper-local pixel, or null. */
  axisAt(x: number, y: number): AxisHit | null;
  /** The axis's current extent, or null when unknown. */
  extent(axis: GestureAxis, grid: GestureGrid): Extent | null;
  /** The axis value at the wrapper-local pixel `px` (x for an X axis, y for a Y axis). */
  valueAt(axis: GestureAxis, grid: GestureGrid, px: number): number;
  /** Writes `axis` to `extent`; false when nothing was written. */
  write(axis: GestureAxis, extent: Extent, opts: AxisWriteOptions): boolean;
  /** Returns `axis` to auto-scale. */
  reset(axis: GestureAxis): void;
  dragMode(): DragMode;
  /** The drawing layer takes this press. */
  claimsPointer(e: MouseEvent): boolean;
  /** The X band's drag when the surface owns it; null for none (the press is ignored). */
  xBandDrag?(grid: GestureGrid, x: number): XBandDrag | null;
}

/** A zoom box thinner than this (px) in one direction zooms the other axis only. */
export const THIN_BOX_PX = 8;
/** Y-band wheel step: one event scales the axis by this factor. */
const Y_BAND_WHEEL_STEP = 1.1;

/** Height (px) of the X tick-label band directly below a grid. */
export const X_BAND_PX = 26;

/** A Y axis placed in a grid's side margin: `slot` 0 is nearest the grid. */
export interface SideAxis {
  axis: GestureAxis;
  side: 'left' | 'right';
  slot: number;
}

/**
 * The axis band of `grid` under (x, y): a Y axis claims its slot of the whole
 * side margin (`slotWidth` wide, within the grid's height), the X axis the
 * X_BAND_PX strip under the grid (within its width). `limit` bounds the
 * margins (a neighbouring grid, the canvas edge).
 */
export function bandAt(
  x: number,
  y: number,
  grid: GestureGrid,
  sides: readonly SideAxis[],
  slotWidth: number,
  limit: { left: number; right: number } = { left: -Infinity, right: Infinity }
): AxisHit | null {
  const r = grid.rect;
  const right = r.left + r.width;
  const bottom = r.top + r.height;
  if (y >= r.top && y <= bottom) {
    if (x < r.left && x >= limit.left) {
      const slot = Math.floor((r.left - x) / slotWidth);
      const hit = sides.find((s) => s.side === 'left' && s.slot === slot);
      return hit ? { axis: hit.axis, grid } : null;
    }
    if (x > right && x <= limit.right) {
      const slot = Math.floor((x - right) / slotWidth);
      const hit = sides.find((s) => s.side === 'right' && s.slot === slot);
      return hit ? { axis: hit.axis, grid } : null;
    }
    return null;
  }
  if (y > bottom && y <= bottom + X_BAND_PX && x >= r.left && x <= right) {
    return { axis: grid.x, grid };
  }
  return null;
}

/** `extent` spread to the S-space span of the pixel range [a, b] of `rect`. */
function boxExtent(
  surface: PlotGestureSurface,
  axis: GestureAxis,
  grid: GestureGrid,
  a: number,
  b: number
): Extent | null {
  const va = surface.valueAt(axis, grid, a);
  const vb = surface.valueAt(axis, grid, b);
  if (!Number.isFinite(va) || !Number.isFinite(vb)) return null;
  if (axis.log && (va <= 0 || vb <= 0)) return null;
  return { min: Math.min(va, vb), max: Math.max(va, vb) };
}

const isUsable = (e: Extent | null, log: boolean): e is Extent =>
  e !== null &&
  Number.isFinite(e.min) &&
  Number.isFinite(e.max) &&
  !(log && (e.min <= 0 || e.max <= 0));

/** Targets a double-click never resets on: a drawing, the drawing layer, an editor. */
const DRAWING_TARGET = '[data-annotation-layer], [data-annotation-id], textarea, input';

function onDrawing(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(DRAWING_TARGET) !== null;
}

/** The zoom box's look: contract variables only. */
const BOX_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  pointerEvents: 'none',
  border: '1px dashed var(--cds-border-interactive)',
  background: 'var(--cds-highlight)',
  opacity: '0.35',
  zIndex: '1',
  boxSizing: 'border-box',
};

/**
 * Installs the gesture layer on `wrapRef`'s element, once per mount. The
 * element must exactly overlay the chart canvas (its local px are canvas px).
 */
export function usePlotGestures(
  wrapRef: RefObject<HTMLElement | null>,
  surface: PlotGestureSurface
): void {
  const surfaceRef = useRef(surface);
  useLayoutEffect(() => {
    surfaceRef.current = surface;
  });
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    return installPlotGestures(wrap, () => surfaceRef.current);
  }, [wrapRef]);
}

/** The listener half of {@link usePlotGestures}; returns the uninstaller. */
export function installPlotGestures(
  wrap: HTMLElement,
  getSurface: () => PlotGestureSurface
): () => void {
  // Detached plots render into a `window.open` document: track drags on THAT window.
  const win = wrap.ownerDocument.defaultView ?? window;

  // Wrapper-local px: the chart sits at the wrapper's content origin, so a
  // scrolled wrapper (a tall split chart) adds its scroll offset.
  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = wrap.getBoundingClientRect();
    return { x: e.clientX - r.left + wrap.scrollLeft, y: e.clientY - r.top + wrap.scrollTop };
  };
  // The zoom box is placed in wrapper-local px: the wrapper is its containing block.
  const view = wrap.ownerDocument.defaultView;
  if (view && view.getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
  const gridAt = (s: PlotGestureSurface, x: number, y: number) =>
    s.grids().find((g) => g.rect.width > 0 && g.rect.height > 0 && inRect(g.rect, x, y));
  const setCursor = (cursor: string) => getSurface().chart()?.setCursor(cursor);

  // One writer for every gesture: an auto-scaled axis is frozen by the write
  // that asks for it and marked manual at once.
  const write = (axis: GestureAxis, next: Extent, freeze: boolean, wheel = false): boolean => {
    if (!Number.isFinite(next.min) || !Number.isFinite(next.max)) return false;
    // A degenerate extent is valid for a freeze (the axis must still go
    // manual), but a zoom or pan that collapses to zero range would lock it.
    if (next.min === next.max && !freeze) return false;
    if (axis.log && (next.min <= 0 || next.max <= 0)) return false;
    const lo = Math.min(next.min, next.max);
    const hi = Math.max(next.min, next.max);
    const done = getSurface().write(axis, { min: lo, max: hi }, { freeze, wheel });
    if (done && freeze) axis.auto = false;
    return done;
  };

  // ── Frame-coalesced drags ─────────────────────────────────────────────────

  interface Coalesced<T> {
    queue(v: T): void;
    /** Deliver the pending value now. */
    flush(): void;
    cancel(): void;
  }
  const coalesce = <T>(deliver: (v: T) => void): Coalesced<T> => {
    let frame: number | null = null;
    let pending: { v: T } | null = null;
    const flush = () => {
      if (frame !== null) win.cancelAnimationFrame(frame);
      frame = null;
      const p = pending;
      pending = null;
      if (p) deliver(p.v);
    };
    return {
      queue(v) {
        pending = { v };
        if (frame !== null) return;
        frame = win.requestAnimationFrame(() => {
          frame = null;
          const p = pending;
          pending = null;
          if (p) deliver(p.v);
        });
      },
      flush,
      cancel() {
        if (frame !== null) win.cancelAnimationFrame(frame);
        frame = null;
        pending = null;
      },
    };
  };

  // Axis-band stretch: the extent captured at press, scaled about its centre
  // by the total drag; an auto-scaled axis freezes on the first frame.
  let stretch: {
    axis: GestureAxis;
    captured: Extent;
    start: number;
    freeze: boolean;
    active: boolean;
  } | null = null;
  const stretchFrames = coalesce<number>((d) => {
    const s = stretch;
    if (!s) return;
    const factor = s.axis.dim === 'y' ? stretchFactorY(d) : stretchFactorX(d);
    // A factor-1 frame would only re-commit the capture (and freeze for nothing).
    if (factor === 1) return;
    const next = stretchExtent(s.captured, factor, s.axis.log);
    if (write(s.axis, next, s.freeze) && s.freeze) s.freeze = false;
  });
  const endStretch = (commit: boolean) => {
    if (commit) stretchFrames.flush();
    else stretchFrames.cancel();
    stretch = null;
  };

  // An X-band drag the surface owns.
  let xDrag: { drag: XBandDrag; start: number; active: boolean } | null = null;
  const endXDrag = (commit: boolean) => {
    const d = xDrag;
    xDrag = null;
    d?.drag.end(commit);
  };

  // Pan: the X axis and the grid's manual Y axes follow the pointer.
  let pan: {
    grid: GestureGrid;
    startX: number;
    startY: number;
    x: { axis: GestureAxis; captured: Extent; freeze: boolean } | null;
    ys: { axis: GestureAxis; captured: Extent }[];
    active: boolean;
  } | null = null;
  const panFrames = coalesce<{ dx: number; dy: number }>(({ dx, dy }) => {
    const p = pan;
    if (!p) return;
    const { width, height } = p.grid.rect;
    if (p.x && dx !== 0) {
      const { axis, captured } = p.x;
      const span = toS(captured.max, axis.log) - toS(captured.min, axis.log);
      const next = panExtentBy(captured, -(dx / width) * span, axis.log);
      if (write(axis, next, p.x.freeze) && p.x.freeze) p.x.freeze = false;
    }
    if (dy === 0) return;
    for (const { axis, captured } of p.ys) {
      // Screen y grows downward, S upward: a drag down shifts the extent up
      // so the value under the pointer stays under it.
      const span = toS(captured.max, axis.log) - toS(captured.min, axis.log);
      write(axis, panExtentBy(captured, (dy / height) * span, axis.log), false);
    }
  });
  const endPan = (commit: boolean) => {
    if (commit) panFrames.flush();
    else panFrames.cancel();
    pan = null;
  };

  // Zoom box: drawn while dragging, applied on release.
  let box: {
    grid: GestureGrid;
    startX: number;
    startY: number;
    x: number;
    y: number;
    el: HTMLElement | null;
    active: boolean;
  } | null = null;
  const clampTo = (r: GridRect, x: number, y: number) => ({
    x: Math.min(r.left + r.width, Math.max(r.left, x)),
    y: Math.min(r.top + r.height, Math.max(r.top, y)),
  });
  const drawBox = () => {
    const b = box;
    if (!b) return;
    if (!b.el) {
      b.el = wrap.ownerDocument.createElement('div');
      b.el.setAttribute('data-zoom-box', '');
      Object.assign(b.el.style, BOX_STYLE);
      wrap.appendChild(b.el);
    }
    const thinX = Math.abs(b.x - b.startX) < THIN_BOX_PX;
    const thinY = Math.abs(b.y - b.startY) < THIN_BOX_PX;
    const r = b.grid.rect;
    // A thin box previews the one axis it will zoom: a full-height or full-width band.
    const left = thinX && !thinY ? r.left : Math.min(b.x, b.startX);
    const right = thinX && !thinY ? r.left + r.width : Math.max(b.x, b.startX);
    const top = thinY && !thinX ? r.top : Math.min(b.y, b.startY);
    const bottom = thinY && !thinX ? r.top + r.height : Math.max(b.y, b.startY);
    Object.assign(b.el.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${right - left}px`,
      height: `${bottom - top}px`,
    });
  };
  const endBox = (commit: boolean) => {
    const b = box;
    box = null;
    if (!b) return;
    b.el?.remove();
    if (!commit || !b.active) return;
    const s = getSurface();
    const thinX = Math.abs(b.x - b.startX) < THIN_BOX_PX;
    const thinY = Math.abs(b.y - b.startY) < THIN_BOX_PX;
    if (thinX && thinY) return;
    if (!thinX && !b.grid.x.fixed) {
      const next = boxExtent(s, b.grid.x, b.grid, b.startX, b.x);
      if (next) write(b.grid.x, next, b.grid.x.auto);
    }
    if (!thinY) {
      for (const axis of b.grid.ys) {
        if (axis.fixed) continue;
        const next = boxExtent(s, axis, b.grid, b.startY, b.y);
        if (next) write(axis, next, axis.auto);
      }
    }
  };

  const endAll = (commit: boolean) => {
    endPan(commit);
    endStretch(commit);
    endXDrag(commit);
    endBox(commit);
  };

  // ── Press ─────────────────────────────────────────────────────────────────

  const startInterior = (
    e: MouseEvent,
    s: PlotGestureSurface,
    grid: GestureGrid,
    x: number,
    y: number
  ): boolean => {
    if (s.claimsPointer(e)) return false;
    if (s.dragMode() === 'zoom') {
      endBox(false);
      box = { grid, startX: x, startY: y, x, y, el: null, active: false };
      return true;
    }
    const xAxis = grid.x.fixed ? null : grid.x;
    const xExt = xAxis ? s.extent(xAxis, grid) : null;
    const xPart =
      xAxis && isUsable(xExt, xAxis.log)
        ? { axis: xAxis, captured: xExt, freeze: xAxis.auto }
        : null;
    const ys: { axis: GestureAxis; captured: Extent }[] = [];
    for (const axis of grid.ys) {
      if (axis.auto || axis.fixed) continue;
      const ext = s.extent(axis, grid);
      if (isUsable(ext, axis.log)) ys.push({ axis, captured: ext });
    }
    if (!xPart && ys.length === 0) return false;
    endPan(false);
    pan = { grid, startX: x, startY: y, x: xPart, ys, active: false };
    return true;
  };

  const onMouseDown = (e: MouseEvent) => {
    // Plot chrome (axis badges, the strip, the status line) owns its presses.
    if (isPlotChrome(e.target)) return;
    if (e.button !== 0) return;
    const s = getSurface();
    if (!s.chart()) return;
    const { x, y } = toLocal(e);
    const hit = s.axisAt(x, y);
    if (!hit) {
      const grid = gridAt(s, x, y);
      if (grid && startInterior(e, s, grid, x, y)) e.preventDefault();
      return;
    }
    if (hit.axis.fixed) return;
    if (hit.axis.dim === 'x' && s.xBandDrag) {
      const drag = s.xBandDrag(hit.grid, x);
      if (!drag) return;
      e.preventDefault();
      endXDrag(false);
      xDrag = { drag, start: x, active: false };
      return;
    }
    // Capture the extent, write nothing: a click or double-click on a band
    // must leave the state alone.
    e.preventDefault();
    const ext = s.extent(hit.axis, hit.grid);
    if (!ext) return;
    stretchFrames.cancel();
    stretch = {
      axis: hit.axis,
      captured: ext,
      start: hit.axis.dim === 'y' ? y : x,
      freeze: hit.axis.auto,
      active: false,
    };
  };

  // ── Drag tracking (on the window, so it follows and ends off the canvas) ──

  const onWindowMouseMove = (e: MouseEvent) => {
    if (!pan && !stretch && !xDrag && !box) return;
    // A release no mouseup reached (browser chrome, another window): end here.
    if (e.buttons === 0) {
      endAll(true);
      return;
    }
    const { x, y } = toLocal(e);
    if (pan) {
      const dx = x - pan.startX;
      const dy = y - pan.startY;
      if (!pan.active && Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;
      pan.active = true;
      panFrames.queue({ dx, dy });
      setCursor('grabbing');
      return;
    }
    if (box) {
      const p = clampTo(box.grid.rect, x, y);
      box.x = p.x;
      box.y = p.y;
      if (!box.active && Math.hypot(x - box.startX, y - box.startY) <= DRAG_THRESHOLD_PX) return;
      box.active = true;
      drawBox();
      setCursor('crosshair');
      return;
    }
    if (xDrag) {
      const dx = x - xDrag.start;
      if (!xDrag.active && Math.abs(dx) <= DRAG_THRESHOLD_PX) return;
      xDrag.active = true;
      xDrag.drag.move(dx);
      setCursor('ew-resize');
      return;
    }
    if (stretch) {
      const d = (stretch.axis.dim === 'y' ? y : x) - stretch.start;
      if (!stretch.active && Math.abs(d) <= DRAG_THRESHOLD_PX) return;
      stretch.active = true;
      stretchFrames.queue(d);
      setCursor(stretch.axis.dim === 'y' ? 'ns-resize' : 'ew-resize');
    }
  };

  const onWindowMouseUp = () => endAll(true);
  // Focus leaving the plot's window drops the release with it.
  const onWindowBlur = () => endAll(true);

  // ── Hover cursor ──────────────────────────────────────────────────────────

  // zrender resets the canvas cursor on every move: re-assert over a band (and
  // in the plot area in zoom mode); restore once on leaving.
  let hovering = false;
  const onHoverMove = (e: MouseEvent) => {
    if (pan || stretch || xDrag || box) return;
    const s = getSurface();
    if (!s.chart()) return;
    const { x, y } = toLocal(e);
    const chrome = isPlotChrome(e.target);
    const hit = chrome ? null : s.axisAt(x, y);
    const cursor = hit
      ? hit.axis.fixed
        ? null
        : hit.axis.dim === 'y'
          ? 'ns-resize'
          : 'ew-resize'
      : !chrome && s.dragMode() === 'zoom' && gridAt(s, x, y) && !onDrawing(e.target)
        ? 'crosshair'
        : null;
    if (cursor) setCursor(cursor);
    else if (hovering) setCursor('default');
    hovering = cursor !== null;
  };

  // ── Wheel ─────────────────────────────────────────────────────────────────

  // Zoom one axis about the value at `px` by `factor`, freezing it first (as
  // its own write) when it is auto-scaled.
  const zoomAxis = (
    s: PlotGestureSurface,
    axis: GestureAxis,
    grid: GestureGrid,
    px: number,
    factor: number,
    wheel: boolean,
    freezeFirst: boolean
  ): void => {
    const ext = s.extent(axis, grid);
    if (!ext) return;
    let freeze = axis.auto;
    if (freeze && freezeFirst) {
      write(axis, ext, true, wheel);
      freeze = false;
    }
    const anchor = s.valueAt(axis, grid, px);
    if (!Number.isFinite(anchor) || (axis.log && anchor <= 0)) return;
    write(axis, zoomExtentAt(ext, toS(anchor, axis.log), factor, axis.log), freeze, wheel);
  };

  // Pan the X axis by a wheel delta (shift, or a mostly sideways scroll).
  const wheelPanX = (s: PlotGestureSurface, grid: GestureGrid, e: WheelEvent): boolean => {
    const axis = grid.x;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (d === 0 || grid.rect.width <= 0) return false;
    const ext = s.extent(axis, grid);
    if (!ext) return true;
    const span = toS(ext.max, axis.log) - toS(ext.min, axis.log);
    const dS = (normalizeWheelDelta(d, e.deltaMode) / grid.rect.width) * span;
    write(axis, panExtentBy(ext, dS, axis.log), axis.auto, true);
    return true;
  };

  const panIntent = (e: WheelEvent) =>
    !(e.ctrlKey || e.metaKey) && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY));

  // The X band: zoom the X axis about the cursor, or pan it.
  const wheelX = (s: PlotGestureSurface, hit: AxisHit, e: WheelEvent, x: number): boolean => {
    if (hit.axis.fixed) return false;
    if (panIntent(e)) return wheelPanX(s, hit.grid, e);
    if (e.deltaY === 0) return e.ctrlKey || e.metaKey;
    zoomAxis(s, hit.axis, hit.grid, x, wheelFactor(e.deltaY, e.deltaMode), true, false);
    return true;
  };

  // A Y band: zoom that axis one step about the value under the cursor. A
  // purely sideways scroll carries no zoom intent.
  const wheelY = (s: PlotGestureSurface, hit: AxisHit, e: WheelEvent, y: number): boolean => {
    if (e.deltaY === 0 || hit.axis.fixed) return false;
    const factor = e.deltaY > 0 ? Y_BAND_WHEEL_STEP : 1 / Y_BAND_WHEEL_STEP;
    zoomAxis(s, hit.axis, hit.grid, y, factor, false, true);
    return true;
  };

  // The plot area: zoom every axis of the grid about the cursor.
  const wheelGrid = (
    s: PlotGestureSurface,
    grid: GestureGrid,
    e: WheelEvent,
    x: number,
    y: number
  ): boolean => {
    const pinch = e.ctrlKey || e.metaKey;
    if (e.altKey && !pinch) {
      // Alt: the primary Y alone.
      const primary = grid.ys[0];
      if (!primary || primary.fixed || e.deltaY === 0) return false;
      zoomAxis(s, primary, grid, y, wheelFactor(e.deltaY, e.deltaMode), false, true);
      return true;
    }
    if (panIntent(e)) return grid.x.fixed ? false : wheelPanX(s, grid, e);
    if (e.deltaY === 0) return pinch;
    const factor = wheelFactor(e.deltaY, e.deltaMode);
    let handled = false;
    if (!grid.x.fixed) {
      zoomAxis(s, grid.x, grid, x, factor, true, false);
      handled = true;
    }
    for (const axis of grid.ys) {
      if (axis.fixed) continue;
      zoomAxis(s, axis, grid, y, factor, true, false);
      handled = true;
    }
    return handled || pinch;
  };

  // ONE capture-phase wheel router for the plot root: chrome first, then the
  // bands, then the plot area; anything else is the page's. Handled events
  // are cancelled and stopped.
  const onWheel = (e: WheelEvent) => {
    if (isPlotChrome(e.target)) return;
    const s = getSurface();
    if (!s.chart()) return;
    const { x, y } = toLocal(e);
    let handled = false;
    const hit = s.axisAt(x, y);
    if (hit) {
      handled = hit.axis.dim === 'y' ? wheelY(s, hit, e, y) : wheelX(s, hit, e, x);
    } else {
      const grid = gridAt(s, x, y);
      if (grid) handled = wheelGrid(s, grid, e, x, y);
    }
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
  };

  // ── Double-click: back to auto-scale ──────────────────────────────────────

  // The presses before it captured but wrote nothing, so this is the
  // gesture's only write; an axis already auto-scaled writes nothing.
  const resetAxis = (s: PlotGestureSurface, axis: GestureAxis): boolean => {
    if (axis.fixed) return false;
    if (axis.dim === 'y' && axis.auto) return false;
    s.reset(axis);
    axis.auto = true;
    return true;
  };
  const onDoubleClick = (e: MouseEvent) => {
    if (isPlotChrome(e.target)) return;
    if (e.button !== 0) return;
    const s = getSurface();
    if (!s.chart()) return;
    const { x, y } = toLocal(e);
    const hit = s.axisAt(x, y);
    if (hit) {
      if (resetAxis(s, hit.axis)) e.preventDefault();
      return;
    }
    const grid = gridAt(s, x, y);
    if (!grid || onDrawing(e.target) || s.claimsPointer(e)) return;
    let any = resetAxis(s, grid.x);
    for (const axis of grid.ys) any = resetAxis(s, axis) || any;
    if (any) e.preventDefault();
  };

  wrap.addEventListener('mousedown', onMouseDown);
  wrap.addEventListener('mousemove', onHoverMove);
  wrap.addEventListener('dblclick', onDoubleClick);
  wrap.addEventListener('wheel', onWheel, { capture: true, passive: false });
  win.addEventListener('mousemove', onWindowMouseMove);
  win.addEventListener('mouseup', onWindowMouseUp);
  win.addEventListener('blur', onWindowBlur);

  return () => {
    wrap.removeEventListener('mousedown', onMouseDown);
    wrap.removeEventListener('mousemove', onHoverMove);
    wrap.removeEventListener('dblclick', onDoubleClick);
    wrap.removeEventListener('wheel', onWheel, { capture: true });
    win.removeEventListener('mousemove', onWindowMouseMove);
    win.removeEventListener('mouseup', onWindowMouseUp);
    win.removeEventListener('blur', onWindowBlur);
    endAll(false);
  };
}
