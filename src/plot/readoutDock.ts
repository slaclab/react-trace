// The plot's data read-out (the chart tooltip) as a docked, movable box, the
// same in every plot tool.
//
// Placement. The box sits in a corner of the plot area (the grid), inset a
// little, never over the axes. It starts in the corner whose column is away
// from the cursor, and stays there while the cursor works elsewhere. When the
// cursor rests in the column under the box for {@link DODGE_DWELL} ms (the
// data being read is under it), the box moves to the free corner across:
// the other side if its column is clear of the cursor, else the other edge.
// A cursor that only crosses the column on its way, to the box's grip
// say, never moves it. A pinned read-out keeps the top-right corner.
//
// Moving. The box never takes the pointer, so it never blocks a press on
// the plot under it. Its left edge carries a grip (drawn by
// `readoutDock.css`), hit-tested by position: a press there drags the box,
// which stays where it is let go, kept inside the grid, until a double-click
// on the grip puts it back in its corner. While the cursor is on the box it
// holds still, so the grip can be reached. The place is the plot's own for
// as long as the plot is open.
//
// The tool's ECharts option takes `tooltipOption(dock)`'s keys; the plot calls
// `attachReadoutDrag(chartDom, dock)` once its chart is mounted.
//
// No colour literals here (src/plot is literal-guarded).
import './readoutDock.css';
import type { GridRect } from './geometry';

/** The class the read-out box carries (plot chrome: `isPlotChrome` matches it). */
export const READOUT_CLASS = 'plot-readout';
/** Inset of a docked box from the grid's edges, in CSS pixels. */
export const DOCK_INSET = 8;
/** How long the cursor rests in the box's column before the box moves away, in ms. */
export const DODGE_DWELL = 250;
/** Width of the grip column at the box's left edge, in CSS pixels. */
export const GRIP_COLUMN = 16;
/** Extra width either side of the box's column that still counts as under it. */
const COLUMN_MARGIN = 12;

/** A corner of the grid: top-left, top-right, bottom-left, bottom-right. */
export type DockCorner = 'tl' | 'tr' | 'bl' | 'br';

const CORNERS: readonly DockCorner[] = ['tl', 'tr', 'bl', 'br'];

/** The box's top-left when docked in `corner` of `grid`. */
export function cornerAt(corner: DockCorner, size: readonly [number, number], grid: GridRect) {
  const [w, h] = size;
  const left = corner === 'tl' || corner === 'bl';
  const top = corner === 'tl' || corner === 'tr';
  return {
    x: left ? grid.left + DOCK_INSET : grid.left + grid.width - DOCK_INSET - w,
    y: top ? grid.top + DOCK_INSET : grid.top + grid.height - DOCK_INSET - h,
  };
}

/** True when `x` lies in the column of a box at `left` of width `w` (with the margin). */
function inColumn(x: number, left: number, w: number): boolean {
  return x >= left - COLUMN_MARGIN && x <= left + w + COLUMN_MARGIN;
}

/**
 * The best corner for a cursor at (`cx`, `cy`): one whose column is clear of
 * the cursor, the current edge first; with none clear, the corner across the
 * plot from the cursor vertically.
 */
export function freeCorner(
  cx: number,
  cy: number,
  size: readonly [number, number],
  grid: GridRect,
  prefer: DockCorner = 'tl'
): DockCorner {
  const top = prefer === 'tl' || prefer === 'tr';
  const order = [...CORNERS].sort((a, b) => {
    const ta = a === 'tl' || a === 'tr';
    const tb = b === 'tl' || b === 'tr';
    return Number(tb === top) - Number(ta === top);
  });
  const clear = order.find((c) => !inColumn(cx, cornerAt(c, size, grid).x, size[0]));
  if (clear) return clear;
  const lower = cy < grid.top + grid.height / 2;
  const left = cx > grid.left + grid.width / 2;
  return lower ? (left ? 'bl' : 'br') : left ? 'tl' : 'tr';
}

/** `p` kept so a box of `size` stays inside `grid`. */
function clampInto(p: { x: number; y: number }, size: readonly [number, number], grid: GridRect) {
  return {
    x: Math.max(grid.left, Math.min(p.x, grid.left + grid.width - size[0])),
    y: Math.max(grid.top, Math.min(p.y, grid.top + grid.height - size[1])),
  };
}

/** The ECharts tooltip `position` callback's last argument. */
interface TipSize {
  contentSize: number[];
  viewSize: number[];
}

export interface ReadoutDock {
  /** The ECharts tooltip `position` callback. */
  position(point: number[], params: unknown, dom: unknown, rect: unknown, size: TipSize): number[];
  /** Where the box was dropped, relative to the grid's top-left; null while docked. */
  moved(): readonly [number, number] | null;
  /** Drops the box at (`x`, `y`) (view px, its top-left); returns the place it keeps. */
  drop(x: number, y: number, size: readonly [number, number]): { x: number; y: number };
  /** Back to its corner. */
  reset(): void;
  /** Pins the read-out to the top-right corner (until dropped elsewhere), or unpins it. */
  setPinned(on: boolean): void;
  /** The box's place now, for a box of `size` (after a reset, before the next pointer move). */
  current(size: readonly [number, number]): { x: number; y: number } | null;
}

export interface ReadoutDockOptions {
  /** The plot area (the projection's grid rect); null before the first layout. */
  grid(): GridRect | null;
  /** The clock (tests). */
  now?(): number;
}

/** A read-out dock for one plot. */
export function createReadoutDock(opts: ReadoutDockOptions): ReadoutDock {
  const now = opts.now ?? (() => Date.now());
  let corner: DockCorner | null = null;
  let since: number | null = null;
  let moved: [number, number] | null = null;
  let pinned = false;
  const fallback = (size: TipSize): GridRect => ({
    left: 0,
    top: 0,
    width: size.viewSize[0] ?? 0,
    height: size.viewSize[1] ?? 0,
  });
  return {
    position(point, _params, _dom, _rect, size) {
      const grid = opts.grid() ?? fallback(size);
      const box: [number, number] = [size.contentSize[0] ?? 0, size.contentSize[1] ?? 0];
      if (moved) {
        const p = clampInto({ x: grid.left + moved[0], y: grid.top + moved[1] }, box, grid);
        return [p.x, p.y];
      }
      if (pinned) {
        const p = cornerAt('tr', box, grid);
        return [p.x, p.y];
      }
      const [cx, cy] = point;
      if (corner === null) corner = freeCorner(cx, cy, box, grid);
      const at = cornerAt(corner, box, grid);
      const onBox =
        cx >= at.x - COLUMN_MARGIN &&
        cx <= at.x + box[0] + COLUMN_MARGIN &&
        cy >= at.y - COLUMN_MARGIN &&
        cy <= at.y + box[1] + COLUMN_MARGIN;
      if (onBox || !inColumn(cx, at.x, box[0])) {
        since = null;
      } else {
        const t = now();
        if (since === null) since = t;
        else if (t - since >= DODGE_DWELL) {
          corner = freeCorner(cx, cy, box, grid, corner);
          since = null;
        }
      }
      const p = clampInto(cornerAt(corner, box, grid), box, grid);
      return [p.x, p.y];
    },
    moved: () => moved,
    drop(x, y, size) {
      const grid = opts.grid();
      if (!grid) return { x, y };
      const p = clampInto({ x, y }, size, grid);
      moved = [p.x - grid.left, p.y - grid.top];
      return p;
    },
    reset() {
      moved = null;
      since = null;
    },
    setPinned(on) {
      pinned = on;
    },
    current(size) {
      const grid = opts.grid();
      if (!grid) return null;
      if (moved) return clampInto({ x: grid.left + moved[0], y: grid.top + moved[1] }, size, grid);
      return cornerAt(pinned ? 'tr' : (corner ?? 'tl'), size, grid);
    },
  };
}

/** The tooltip keys a plot's ECharts option takes for `dock`. */
export function tooltipOption(dock: ReadoutDock) {
  return {
    position: dock.position,
    enterable: false,
    className: READOUT_CLASS,
  };
}

/** Moves the read-out element to (`x`, `y`) in its container's px. */
function placeBox(el: HTMLElement, x: number, y: number) {
  el.style.left = '0px';
  el.style.top = '0px';
  el.style.transform = `translate3d(${x}px, ${y}px, 0px)`;
}

/** The hover events a grip drag keeps from the plot. */
const DRAG_HOVER_EVENTS = [
  'mousemove',
  'mouseover',
  'mouseout',
  'pointerover',
  'pointerout',
  'pointerleave',
  'mouseleave',
] as const;

/** True when the read-out box is on screen (ECharts hides it by fading it out). */
function showing(box: HTMLElement): boolean {
  const style = box.ownerDocument.defaultView?.getComputedStyle(box);
  return (
    !!style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
  );
}

/**
 * Wires the grip of the read-out inside `container` (the chart's dom) to
 * `dock`. The box takes no pointer events, so the grip is hit-tested by
 * position, in the capture phase on the document: a press in the grip column
 * of the box on screen drags it, a double-click there puts it back, and
 * neither reaches the plot or the drawings. Returns the cleanup.
 */
export function attachReadoutDrag(container: HTMLElement, dock: ReadoutDock): () => void {
  const doc = container.ownerDocument;
  // A chart double with no real element: nothing to wire.
  if (!doc || typeof container.querySelector !== 'function') return () => {};
  const gripBox = (e: { clientX: number; clientY: number }): HTMLElement | null => {
    const box = container.querySelector<HTMLElement>(`.${READOUT_CLASS}`);
    if (!box || !showing(box)) return null;
    const r = box.getBoundingClientRect();
    const inside =
      e.clientX >= r.left &&
      e.clientX <= r.left + GRIP_COLUMN &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom;
    return inside ? box : null;
  };
  let drag: {
    box: HTMLElement;
    pointerId: number;
    dx: number;
    dy: number;
    size: [number, number];
  } | null = null;
  const origin = () => container.getBoundingClientRect();

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const box = gripBox(e);
    if (!box) return;
    e.stopPropagation();
    e.preventDefault();
    const r = box.getBoundingClientRect();
    drag = {
      box,
      pointerId: e.pointerId,
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
      size: [r.width, r.height],
    };
    box.classList.add(`${READOUT_CLASS}--dragging`);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) {
      container.classList.toggle(`${READOUT_CLASS}-grip-hover`, gripBox(e) !== null);
      return;
    }
    if (e.pointerId !== drag.pointerId) return;
    e.stopPropagation();
    const o = origin();
    const p = dock.drop(e.clientX - o.left - drag.dx, e.clientY - o.top - drag.dy, drag.size);
    placeBox(drag.box, p.x, p.y);
  };
  const onUp = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.stopPropagation();
    drag.box.classList.remove(`${READOUT_CLASS}--dragging`);
    drag = null;
  };
  // The presses on the grip, and every move of a drag, never reach the plot:
  // its hover would re-place the box, or hide it as the pointer crosses the
  // drawings (the chart reads that as the pointer leaving it).
  const onMouse = (e: MouseEvent) => {
    if (drag || gripBox(e)) e.stopPropagation();
  };
  const onMouseMove = (e: MouseEvent) => {
    if (drag) e.stopPropagation();
  };
  const onDouble = (e: MouseEvent) => {
    const box = gripBox(e);
    if (!box) return;
    e.stopPropagation();
    e.preventDefault();
    dock.reset();
    const r = box.getBoundingClientRect();
    const p = dock.current([r.width, r.height]);
    if (p) placeBox(box, p.x, p.y);
  };
  const opts = { capture: true };
  doc.addEventListener('pointerdown', onDown, opts);
  doc.addEventListener('pointermove', onMove, opts);
  doc.addEventListener('pointerup', onUp, opts);
  doc.addEventListener('pointercancel', onUp, opts);
  doc.addEventListener('mousedown', onMouse, opts);
  for (const type of DRAG_HOVER_EVENTS) doc.addEventListener(type, onMouseMove, opts);
  doc.addEventListener('mouseup', onMouse, opts);
  doc.addEventListener('click', onMouse, opts);
  doc.addEventListener('dblclick', onDouble, opts);
  return () => {
    doc.removeEventListener('pointerdown', onDown, opts);
    doc.removeEventListener('pointermove', onMove, opts);
    doc.removeEventListener('pointerup', onUp, opts);
    doc.removeEventListener('pointercancel', onUp, opts);
    doc.removeEventListener('mousedown', onMouse, opts);
    for (const type of DRAG_HOVER_EVENTS) doc.removeEventListener(type, onMouseMove, opts);
    doc.removeEventListener('mouseup', onMouse, opts);
    doc.removeEventListener('click', onMouse, opts);
    doc.removeEventListener('dblclick', onDouble, opts);
    container.classList.remove(`${READOUT_CLASS}-grip-hover`);
  };
}

/** The plot area of `store`'s projection: every grid's rect together; null before layout. */
export function projectionArea(store: {
  get(): { gridRect: GridRect; grids?: readonly { gridRect: GridRect }[] } | null;
}): () => GridRect | null {
  return () => {
    const p = store.get();
    if (!p) return null;
    const rects = p.grids && p.grids.length > 0 ? p.grids.map((g) => g.gridRect) : [p.gridRect];
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.left + r.width));
    const bottom = Math.max(...rects.map((r) => r.top + r.height));
    return right > left && bottom > top
      ? { left, top, width: right - left, height: bottom - top }
      : null;
  };
}
