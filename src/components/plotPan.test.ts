// @vitest-environment jsdom
//
// Main's `panExtent` cases (hitTestAxis.test.ts), ported onto the shared
// gesture layer, where a Y extent's pixel-delta pan now lives: the interior
// pan, which moves manual Y axes with the time axis. (Dragging a Y band now
// stretches the axis, a decided change; the case main had for dragging DOWN
// is covered by src/plot/gestures.test.ts "moves a manual Y too", and the log
// case by src/plot/geometry.test.ts.) A drag UP lowers the extent, the value
// grabbed at press stays under the pointer, and a zero-height grid never
// pans: main returned null for a degenerate mapping, here nothing is written.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bandAt,
  installPlotGestures,
  type GestureAxis,
  type GestureGrid,
  type PlotGestureSurface,
} from '../plot/gestures';
import type { Extent, GridRect } from '../plot/geometry';
import { fireMouse } from '../plot/testUtils';

// Main's mapping: y [0, 100] over a 300 px grid, min at px 340, max at px 40.
const RECT: GridRect = { left: 70, top: 40, width: 660, height: 300 };
const PX_MIN = RECT.top + RECT.height;

function fake(rect: GridRect = RECT) {
  const x: GestureAxis = { id: 'x', dim: 'x', log: false, auto: true };
  // Manual: the interior pan leaves auto-scaled Y axes alone.
  const y: GestureAxis = { id: 'y', dim: 'y', log: false, auto: false };
  const grid: GestureGrid = { rect, x, ys: [y] };
  const extents: Record<string, Extent> = { x: { min: 0, max: 1000 }, y: { min: 0, max: 100 } };
  const writes: { id: string; extent: Extent }[] = [];
  const surface: PlotGestureSurface = {
    chart: () => ({ getWidth: () => 800, getHeight: () => 400, setCursor: () => {} }),
    grids: () => [grid],
    axisAt: (px, py) => bandAt(px, py, grid, [{ axis: y, side: 'left', slot: 0 }], 70),
    extent: (axis) => extents[axis.id],
    valueAt: (axis, g, px) => {
      const e = extents[axis.id];
      const r = g.rect;
      return axis.dim === 'x'
        ? e.min + ((px - r.left) / r.width) * (e.max - e.min)
        : e.min + ((r.top + r.height - px) / r.height) * (e.max - e.min);
    },
    write: (axis, extent) => {
      writes.push({ id: axis.id, extent });
      return true;
    },
    reset: () => {},
    dragMode: () => 'pan',
    claimsPointer: () => false,
  };
  return { surface, grid, writes };
}

let wrap: HTMLDivElement;
let uninstall: (() => void) | undefined;

beforeEach(() => {
  wrap = document.createElement('div');
  document.body.appendChild(wrap);
  // Frames never run on their own: the release flushes the pending one.
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  wrap.remove();
  vi.restoreAllMocks();
});

function mount(f: ReturnType<typeof fake>) {
  uninstall = installPlotGestures(wrap, () => f.surface);
}

/** Press at (x, from), drag vertically to `to`, release; returns the press. */
function dragY(x: number, from: number, to: number): MouseEvent {
  const down = fireMouse(wrap, 'mousedown', { x, y: from });
  fireMouse(window, 'mousemove', { x, y: to });
  fireMouse(window, 'mouseup', { x, y: to });
  return down;
}

const yWrites = (f: ReturnType<typeof fake>) =>
  f.writes.filter((w) => w.id === 'y').map((w) => w.extent);

/** The value at pixel `p` under extent `e` over the grid's pixel span. */
const valueAt = (e: Extent, p: number) => e.min + (e.max - e.min) * ((PX_MIN - p) / RECT.height);

describe('pan of a Y extent by a pixel drag (main: panExtent)', () => {
  it('dragging UP lowers min/max so the curves follow the cursor up', () => {
    const f = fake();
    mount(f);
    dragY(400, 200, 170);
    expect(yWrites(f)).toHaveLength(1);
    const [ext] = yWrites(f);
    // -30 px of a 300 px span shifts the window by -10 data units.
    expect(ext.min).toBeCloseTo(-10, 10);
    expect(ext.max).toBeCloseTo(90, 10);
  });

  it('keeps the grabbed value glued to the cursor', () => {
    const f = fake();
    mount(f);
    // Grab pixel 190 (value 50 under the press-time extent), drag +45 px.
    expect(valueAt({ min: 0, max: 100 }, 190)).toBeCloseTo(50, 10);
    dragY(400, 190, 235);
    const [ext] = yWrites(f);
    // Under the written extent, value 50 sits at the pointer's new pixel.
    expect(valueAt(ext, 235)).toBeCloseTo(50, 10);
  });

  it('a zero-height grid never pans', () => {
    // The same press and drag pans a grid with a height...
    const live = fake();
    mount(live);
    dragY(400, RECT.top, RECT.top + 30);
    expect(yWrites(live)).toHaveLength(1);
    uninstall?.();
    // ...and writes nothing once the grid has none.
    const f = fake({ ...RECT, height: 0 });
    mount(f);
    dragY(400, RECT.top, RECT.top + 30);
    expect(f.writes).toEqual([]);
  });
});
