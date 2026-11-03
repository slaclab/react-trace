// Pure window/extent maths for the plot gestures, and the projection that
// maps data to pixels on a laid-out plot.
//
// Value extents `{ min, max }` in axis units (each y axis) live here. Trace's
// time windows (the x axis), its sample snap and its all-loaded span live in
// `tools/trace/drawing/`.
//
// Value extents are manipulated in "S space": the axis's own linear space, or
// log10 of it for a logarithmic axis. Doing every stretch/zoom/pan in S space
// means a log axis keeps its ratios (a stretch about the centre of 1..100 is a
// stretch about 10, not about 50.5), and a linear axis behaves as before.
//
// The maths needs no React and no ECharts: callers convert pixels to factors
// with the pointer and wheel laws below and feed the results to their own
// commit path. The projection section at the end adds the one React hook the
// overlay layers need (`useSyncExternalStore`) and reaches ECharts only through
// a structural instance type, never an import.

import { useSyncExternalStore } from 'react';

/** A value extent in axis units. */
export interface Extent {
  min: number;
  max: number;
}

/** Axis value → S space (log10 for a logarithmic axis, identity otherwise). */
export function toS(v: number, log = false): number {
  return log ? Math.log10(v) : v;
}

/** S space → axis value; inverse of {@link toS}. */
export function fromS(s: number, log = false): number {
  return log ? 10 ** s : s;
}

function extentFromS(lo: number, hi: number, log: boolean): Extent {
  return { min: fromS(lo, log), max: fromS(hi, log) };
}

/**
 * Scale an extent's span by `factor` about its centre (in S space).
 * `factor > 1` widens (zooms out), `factor < 1` narrows (zooms in).
 */
export function stretchExtent(extent: Extent, factor: number, log = false): Extent {
  return zoomExtentAt(extent, (toS(extent.min, log) + toS(extent.max, log)) / 2, factor, log);
}

/**
 * Scale an extent's span by `factor` about the S-space point `atS`, which keeps
 * its relative position inside the extent (the value under the cursor stays put).
 */
export function zoomExtentAt(extent: Extent, atS: number, factor: number, log = false): Extent {
  const lo = toS(extent.min, log);
  const hi = toS(extent.max, log);
  return extentFromS(atS + (lo - atS) * factor, atS + (hi - atS) * factor, log);
}

/** Shift an extent by `dS` in S space (a multiplicative shift on a log axis). */
export function panExtentBy(extent: Extent, dS: number, log = false): Extent {
  return extentFromS(toS(extent.min, log) + dS, toS(extent.max, log) + dS, log);
}

/**
 * `extent` with each bound rounded to four significant digits of its span, so
 * a zoom writes readable bounds (an axis label, a link, the Inspector) and
 * stays within a hundredth of a percent of where the gesture put it. On a log
 * axis the rounding is relative to each bound.
 */
export function roundExtent(extent: Extent, log = false): Extent {
  const round = (v: number, step: number) =>
    Number.isFinite(step) && step > 0 ? Number((Math.round(v / step) * step).toPrecision(12)) : v;
  if (log) {
    const sig = (v: number) => (v > 0 ? Number(v.toPrecision(4)) : v);
    return { min: sig(extent.min), max: sig(extent.max) };
  }
  const span = Math.abs(extent.max - extent.min);
  if (!(span > 0)) return extent;
  const step = 10 ** (Math.floor(Math.log10(span)) - 3);
  return { min: round(extent.min, step), max: round(extent.max, step) };
}

/** Pixels of drag that double (or halve) a span. */
const STRETCH_PX_PER_OCTAVE = 200;

/**
 * Y-band drag law: dragging down (`dy > 0`) widens the extent,
 * dragging up narrows it; 200 px is one factor of two.
 */
export function stretchFactorY(dyPx: number): number {
  return 2 ** (dyPx / STRETCH_PX_PER_OCTAVE);
}

/**
 * Time-band drag law: dragging right (`dx > 0`) narrows the window,
 * dragging left widens it; 200 px is one factor of two.
 */
export function stretchFactorX(dxPx: number): number {
  return 2 ** (-dxPx / STRETCH_PX_PER_OCTAVE);
}

/** WheelEvent.deltaMode values (DOM_DELTA_PIXEL / LINE / PAGE). */
export const DELTA_PIXEL = 0;
export const DELTA_LINE = 1;
export const DELTA_PAGE = 2;

/** Pixel equivalents used to normalize line- and page-mode wheel deltas. */
export const WHEEL_LINE_PX = 40;
export const WHEEL_PAGE_PX = 800;

/** Normalized wheel pixels that double (or halve) a span. */
const WHEEL_PX_PER_OCTAVE = 300;

/** Per-event clamp on the wheel exponent: at most half an octave per event. */
const WHEEL_MAX_OCTAVES = 0.5;

/** Convert a wheel delta to pixels whatever its `deltaMode`. */
export function normalizeWheelDelta(delta: number, deltaMode: number): number {
  if (deltaMode === DELTA_LINE) return delta * WHEEL_LINE_PX;
  if (deltaMode === DELTA_PAGE) return delta * WHEEL_PAGE_PX;
  return delta;
}

/**
 * Wheel zoom law: `2 ** (normalizedDeltaY / 300)`, clamped per
 * event to `[2^-0.5, 2^0.5]`. Scrolling down (`deltaY > 0`) zooms out. Pixel
 * deltas from a trackpad are small and zoom smoothly; a mouse notch reported in
 * lines or pages is normalized to pixels first and then capped by the clamp.
 */
export function wheelFactor(deltaY: number, deltaMode: number = DELTA_PIXEL): number {
  const octaves = normalizeWheelDelta(deltaY, deltaMode) / WHEEL_PX_PER_OCTAVE;
  if (!Number.isFinite(octaves)) return 1;
  return 2 ** Math.min(WHEEL_MAX_OCTAVES, Math.max(-WHEEL_MAX_OCTAVES, octaves));
}

/** Selectors of the plot-root chrome that every wrapper listener must ignore. */
export const PLOT_CHROME_SELECTOR =
  '[data-axis-badge], [data-drawing-rail], [data-status-line], [data-drawing-style], .plot-readout';

/**
 * True when an event target sits inside plot chrome — an axis badge, the
 * drawing rail, the status line, a drawing's style panel or the plot's data
 * read-out.
 * Every wrapper handler consults this first and returns when it is true.
 * Accepts any event target: null, text nodes and windows are not chrome.
 */
export function isPlotChrome(target: EventTarget | null | undefined): boolean {
  if (target == null) return false;
  const el = target as { closest?: unknown };
  if (typeof el.closest !== 'function') return false;
  return (el as Element).closest(PLOT_CHROME_SELECTOR) != null;
}

const stopEvent = (e: Event) => e.stopPropagation();

/**
 * A ref callback that stops the native `types` at its element, so a press on
 * plot chrome never reaches the wrapper's native gesture listeners (React's
 * synthetic stopPropagation runs too late). Build it once, at module level.
 */
export function stopNativeEvents(...types: string[]): (el: Element | null) => void {
  return (el) => {
    if (!el) return;
    for (const type of types) el.addEventListener(type, stopEvent);
  };
}

/** {@link stopNativeEvents} for the presses that start plot gestures. */
export const stopPressPropagation = stopNativeEvents('pointerdown', 'mousedown');

// ---------------------------------------------------------------------------
// Projection

/** One grid's plot area in wrapper-local CSS pixels. */
export interface GridRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Wrapper-local px inside `r`, edges included. */
export function inRect(r: GridRect, x: number, y: number): boolean {
  return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
}

/** Total movement (px) a press must exceed before it is a drag. */
export const DRAG_THRESHOLD_PX = 3;

/**
 * One sample of a series: x, then y (`null` is a gap marker). Structurally the
 * same as `components/traceGaps` `LinePoint`.
 */
export type SamplePoint = [x: number, y: number | null];

/** Where a snap landed: the sample's x and y, and its series and that series' axis. */
export interface SnapHit {
  t: number;
  v: number;
  axisId: string;
  traceId: string;
}

/**
 * The slice of a projection a sample snap needs (Trace's `snapToSample`).
 * Structural, so the full plot projection satisfies it and tests can pass a
 * plain fake.
 */
export interface SnapProjection {
  tToX(t: number): number;
  xToT(x: number): number;
  vToY(v: number, axisId: string): number;
}

/**
 * Data <-> pixel mapping of one grid, plus the y axes the grid draws. Times
 * (x) are in the x axis's units, values in the named axis's units, pixels are
 * wrapper-local. An unknown axis id (or a disposed chart) maps to NaN.
 */
export interface GridProjection extends SnapProjection {
  yToV(y: number, axisId: string): number;
  gridRect: GridRect;
  /** The ids of the y axes drawn in this grid. */
  axisIds: readonly string[];
}

/**
 * Data <-> pixel mapping of one plot as ECharts last laid it out: every grid,
 * with grid 0's converters, rect and axis ids spread at the top level.
 */
export interface Projection extends GridProjection {
  /** Every grid, in ascending grid index. */
  grids: readonly GridProjection[];
  /** The grid that draws `axisId`. */
  gridOf(axisId: string): GridProjection | undefined;
  /** The grid whose rect contains the wrapper-local pixel, edges included. */
  gridAt(px: number, py: number): GridProjection | undefined;
}

/**
 * The slice of an ECharts instance {@link buildProjection} reads. Structural so
 * this module never imports ECharts and tests can pass a plain fake.
 */
export interface ProjectionInstance {
  convertToPixel(finder: { xAxisIndex: number } | { yAxisIndex: number }, value: number): unknown;
  convertFromPixel(finder: { xAxisIndex: number } | { yAxisIndex: number }, px: number): unknown;
  getWidth(): number;
  getHeight(): number;
  isDisposed?(): boolean;
  /**
   * ECharts' global model, read only (duck-typed) for a grid's laid-out rect,
   * `getComponent('grid', i).coordinateSystem.getRect()`, when the layout
   * gives no `gridRects`.
   */
  getModel?(): unknown;
}

/** The slice of `plotLayout()` (components/PlotArea) a projection needs. */
export interface ProjectionLayout {
  axisIndexMap: ReadonlyMap<string, number>;
  gridTop: number;
  gridBottom: number;
  gridLeft: number;
  gridRight: number;
  /**
   * Each grid's rect by grid index, for a multi-grid plot (e.g. Correlation's
   * split view, whose grids are explicit pixel boxes). Read only with a
   * resolver; a missing entry falls back to the instance model, then to the
   * single-grid insets above.
   */
  gridRects?: readonly (GridRect | undefined)[];
}

/** Where one y axis lives in a multi-grid chart. */
export interface AxisPlacement {
  gridIndex: number;
  xAxisIndex: number;
  yAxisIndex: number;
}

/** Maps a y-axis id to its grid and ECharts axis indices; null when it is not drawn. */
export type AxisResolver = (axisId: string) => AxisPlacement | null | undefined;

function toNumber(v: unknown): number {
  return typeof v === 'number' ? v : NaN;
}

/**
 * `f()` as a number, NaN when it throws: an instance that has not laid out an
 * option yet (no components, e.g. a reload restoring drawings before the first
 * paint) throws from `convertToPixel` instead of answering.
 */
function safely(f: () => unknown): number {
  try {
    return toNumber(f());
  } catch {
    return NaN;
  }
}

function isRect(r: unknown): r is GridRect {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  return ['left', 'top', 'width', 'height'].every((k) => typeof o[k] === 'number');
}

/** Grid `index`'s laid-out rect from the instance model (duck-typed), or null. */
function modelGridRect(instance: ProjectionInstance, index: number): GridRect | null {
  try {
    const model = instance.getModel?.() as
      | { getComponent?(type: string, idx: number): unknown }
      | null
      | undefined;
    const grid = model?.getComponent?.('grid', index) as
      | { coordinateSystem?: { getRect?(): unknown } }
      | null
      | undefined;
    const r = grid?.coordinateSystem?.getRect?.() as
      | { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
      | null
      | undefined;
    if (!r) return null;
    const rect = { left: r.x, top: r.y, width: r.width, height: r.height };
    return isRect(rect) ? { ...rect } : null;
  } catch {
    return null;
  }
}

/**
 * Build a projection over `instance`. Only the axes in `axes` (the plot's
 * visible axes) resolve; any other id maps to NaN. The converters ask the
 * instance on every call, so the projection reflects the layout ECharts holds;
 * the store rebuilds it on each `finished` and resize, resolving the instance
 * live, because echarts-for-react disposes and recreates its instance (never
 * cache one).
 *
 * Without `resolve` there is one grid: x axis 0, each axis's y index from
 * `layout.axisIndexMap`, the rect from the layout insets — today's result.
 * With `resolve`, each visible axis is placed in the grid it names, a grid
 * takes the x index of its first axis, and its rect comes from
 * `layout.gridRects`, else the instance model, else the insets. Either way
 * grid 0's (the lowest grid index's) fields are spread at the top level.
 */
export function buildProjection(
  instance: ProjectionInstance,
  layout: ProjectionLayout,
  axes: readonly { id: string }[],
  resolve?: AxisResolver
): Projection {
  const alive = () => !instance.isDisposed?.();
  const width = instance.getWidth();
  const height = instance.getHeight();
  const insetRect: GridRect = {
    left: layout.gridLeft,
    top: layout.gridTop,
    width: Math.max(0, width - layout.gridLeft - layout.gridRight),
    height: Math.max(0, height - layout.gridTop - layout.gridBottom),
  };

  // gridIndex -> { xAxisIndex, axis id -> yAxisIndex }, in axis order.
  const placed = new Map<number, { xAxisIndex: number; slots: Map<string, number> }>();
  const place = (axisId: string, p: AxisPlacement) => {
    let g = placed.get(p.gridIndex);
    if (!g) {
      g = { xAxisIndex: p.xAxisIndex, slots: new Map() };
      placed.set(p.gridIndex, g);
    }
    if (!g.slots.has(axisId)) g.slots.set(axisId, p.yAxisIndex);
  };
  for (const axis of axes) {
    if (resolve) {
      const p = resolve(axis.id);
      if (p) place(axis.id, p);
    } else {
      const idx = layout.axisIndexMap.get(axis.id);
      if (idx !== undefined) place(axis.id, { gridIndex: 0, xAxisIndex: 0, yAxisIndex: idx });
    }
  }
  if (placed.size === 0) placed.set(0, { xAxisIndex: 0, slots: new Map() });

  const rectOf = (gridIndex: number): GridRect => {
    if (!resolve) return insetRect;
    const given = layout.gridRects?.[gridIndex];
    if (given) return { ...given };
    return modelGridRect(instance, gridIndex) ?? insetRect;
  };

  const makeGrid = (
    gridIndex: number,
    xAxisIndex: number,
    slots: ReadonlyMap<string, number>
  ): GridProjection => {
    const yConvert = (axisId: string, f: (idx: number) => unknown): number => {
      const idx = slots.get(axisId);
      if (idx === undefined || !alive()) return NaN;
      return safely(() => f(idx));
    };
    return {
      tToX: (t) => (alive() ? safely(() => instance.convertToPixel({ xAxisIndex }, t)) : NaN),
      xToT: (x) => (alive() ? safely(() => instance.convertFromPixel({ xAxisIndex }, x)) : NaN),
      vToY: (v, axisId) =>
        yConvert(axisId, (yAxisIndex) => instance.convertToPixel({ yAxisIndex }, v)),
      yToV: (y, axisId) =>
        yConvert(axisId, (yAxisIndex) => instance.convertFromPixel({ yAxisIndex }, y)),
      gridRect: rectOf(gridIndex),
      axisIds: [...slots.keys()],
    };
  };

  const grids = [...placed.entries()]
    .sort(([a], [b]) => a - b)
    .map(([gridIndex, g]) => makeGrid(gridIndex, g.xAxisIndex, g.slots));
  const byAxis = new Map<string, GridProjection>();
  for (const grid of grids) {
    for (const id of grid.axisIds) if (!byAxis.has(id)) byAxis.set(id, grid);
  }
  const first = grids[0];
  return {
    tToX: first.tToX,
    xToT: first.xToT,
    vToY: first.vToY,
    yToV: first.yToV,
    gridRect: first.gridRect,
    axisIds: first.axisIds,
    grids,
    gridOf: (axisId) => byAxis.get(axisId),
    gridAt: (px, py) => grids.find((g) => inRect(g.gridRect, px, py)),
  };
}

/** A tiny external store of the current {@link Projection}. */
export interface ProjectionStore {
  /** The projection built at the last bump; the same object until the next one. */
  get(): Projection | null;
  subscribe(cb: () => void): () => void;
  /** Rebuild from the source and notify. Call from events, never during render. */
  bump(): void;
}

function createListeners() {
  const listeners = new Set<() => void>();
  return {
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    notify() {
      for (const cb of [...listeners]) cb();
    },
  };
}

/** The owner's side of a projection store: it also installs the source. */
export interface OwnedProjectionStore extends ProjectionStore {
  /**
   * Replace what `bump()` builds from. The owner installs a fresh source after
   * each render (current layout, live instance lookup); this does not notify.
   */
  setSource(source: () => Projection | null): void;
}

/**
 * A projection store whose `bump()` asks its source for a fresh projection
 * (null while no live chart exists) and notifies subscribers. `get()` returns
 * the object cached at the last bump, so `useSyncExternalStore` sees a stable
 * snapshot between bumps and never loops.
 */
export function createProjectionStore(
  initialSource: () => Projection | null = () => null
): OwnedProjectionStore {
  let source = initialSource;
  let current: Projection | null = null;
  const { subscribe, notify } = createListeners();
  return {
    get: () => current,
    subscribe,
    setSource(next) {
      source = next;
    },
    bump() {
      current = source();
      notify();
    },
  };
}

/** Subscribe a component to a projection store (re-renders on each bump). */
export function useProjection(store: ProjectionStore): Projection | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** The pointer over a plot in wrapper-local CSS pixels. */
export interface CursorPoint {
  x: number;
  y: number;
}

/**
 * The {@link ProjectionStore} shape over the pointer position: the wrapper's
 * mousemove `set`s it and only its subscribers (the status line) re-render, so
 * a pointer move never re-renders the plot.
 */
export interface CursorStore {
  get(): CursorPoint | null;
  subscribe(cb: () => void): () => void;
  /** Re-notify subscribers with the current point (e.g. after the projection moved). */
  bump(): void;
  set(pt: CursorPoint | null): void;
}

export function createCursorStore(): CursorStore {
  let current: CursorPoint | null = null;
  const { subscribe, notify } = createListeners();
  return {
    get: () => current,
    subscribe,
    bump: notify,
    set(pt) {
      if (pt === current) return;
      if (pt && current && pt.x === current.x && pt.y === current.y) return;
      current = pt ? { x: pt.x, y: pt.y } : null;
      notify();
    },
  };
}
