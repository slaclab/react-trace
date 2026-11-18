// @vitest-environment jsdom
//
// The gesture choices a surface passes (`prefs`, gesturePrefs.ts) over the
// fake surface of gestures.test.ts: one 400 x 200 grid at (100, 50); x maps
// [0, 100] across it, y maps [0, 10] up it. Without `prefs` the layer keeps
// its own (gestures.test.ts pins those); here each choice's other value:
// the wheel zooming X alone (Alt: X and every Y), a Y-band drag panning that
// axis (Shift or Alt: stretching it), and a plot-area double-click doing
// nothing (a band's still resets its axis).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bandAt,
  installPlotGestures,
  type GestureAxis,
  type GestureGrid,
  type PlotGestureSurface,
} from './gestures';
import { DEFAULT_GESTURE_PREFS, type GesturePrefs } from './gesturePrefs';
import type { Extent } from './geometry';
import { fireMouse } from './testUtils';

const RECT = { left: 100, top: 50, width: 400, height: 200 };

interface Fake {
  surface: PlotGestureSurface;
  writes: { id: string; extent: Extent; freeze: boolean }[];
  resets: string[];
}

function fake(prefs: Partial<GesturePrefs> | undefined, opts: { yAuto?: boolean } = {}): Fake {
  const x: GestureAxis = { id: 'x', dim: 'x', log: false, auto: true };
  const y: GestureAxis = { id: 'y', dim: 'y', log: false, auto: opts.yAuto ?? true };
  const y2: GestureAxis = { id: 'y2', dim: 'y', log: false, auto: true };
  const grid: GestureGrid = { rect: RECT, x, ys: [y, y2] };
  const extents: Record<string, Extent> = {
    x: { min: 0, max: 100 },
    y: { min: 0, max: 10 },
    y2: { min: 0, max: 10 },
  };
  const writes: Fake['writes'] = [];
  const resets: string[] = [];
  const surface: PlotGestureSurface = {
    chart: () => ({ getWidth: () => 600, getHeight: () => 300, setCursor: () => {} }),
    grids: () => [grid],
    axisAt: (px, py) =>
      bandAt(
        px,
        py,
        grid,
        [
          { axis: y, side: 'left', slot: 0 },
          { axis: y2, side: 'right', slot: 0 },
        ],
        60
      ),
    extent: (axis) => extents[axis.id],
    valueAt: (axis, _g, px) => {
      const e = extents[axis.id];
      return axis.dim === 'x'
        ? e.min + ((px - RECT.left) / RECT.width) * (e.max - e.min)
        : e.min + ((RECT.top + RECT.height - px) / RECT.height) * (e.max - e.min);
    },
    write: (axis, extent, o) => {
      writes.push({ id: axis.id, extent, freeze: o.freeze });
      return true;
    },
    reset: (axis) => void resets.push(axis.id),
    dragMode: () => 'zoom',
    claimsPointer: () => false,
    ...(prefs === undefined ? {} : { prefs: () => prefs }),
  };
  return { surface, writes, resets };
}

let wrap: HTMLDivElement;
let uninstall: () => void;
let frames: FrameRequestCallback[];

function mount(f: Fake) {
  uninstall = installPlotGestures(wrap, () => f.surface);
}

function flush() {
  const pending = frames;
  frames = [];
  for (const cb of pending) cb(0);
}

function wheel(x: number, y: number, init: WheelEventInit = {}) {
  wrap.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      deltaY: -100,
      ...init,
    })
  );
  flush();
}

const ids = (f: Fake) => [...new Set(f.writes.map((w) => w.id))].sort();

beforeEach(() => {
  wrap = document.createElement('div');
  document.body.appendChild(wrap);
  frames = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  uninstall?.();
  wrap.remove();
  vi.restoreAllMocks();
});

describe('wheel: x', () => {
  it('zooms the X axis alone over the plot area, leaving auto-scaled Ys alone', () => {
    const f = fake({ wheel: 'x' });
    mount(f);
    wheel(300, 150);
    expect(ids(f)).toEqual(['x']);
  });

  it('zooms X and every Y with Alt', () => {
    const f = fake({ wheel: 'x' });
    mount(f);
    wheel(300, 150, { altKey: true });
    expect(ids(f)).toEqual(['x', 'y', 'y2']);
  });

  it('still zooms a Y band’s own axis, and Shift still pans X', () => {
    const f = fake({ wheel: 'x' });
    mount(f);
    wheel(70, 150);
    expect(ids(f)).toEqual(['y']);
    f.writes.length = 0;
    wheel(300, 150, { shiftKey: true });
    expect(ids(f)).toEqual(['x']);
  });
});

describe('wheel: xy (the layer’s own)', () => {
  it('zooms X and every Y; Alt the primary Y alone', () => {
    expect(DEFAULT_GESTURE_PREFS.wheel).toBe('xy');
    const f = fake({ wheel: 'xy' });
    mount(f);
    wheel(300, 150);
    expect(ids(f)).toEqual(['x', 'y', 'y2']);
    f.writes.length = 0;
    wheel(300, 150, { altKey: true });
    expect(ids(f)).toEqual(['y']);
  });
});

function dragBand(from: [number, number], to: [number, number], mods = {}) {
  fireMouse(wrap, 'mousedown', { x: from[0], y: from[1], ...mods });
  fireMouse(window, 'mousemove', { x: to[0], y: to[1], ...mods });
  flush();
  fireMouse(window, 'mouseup', { x: to[0], y: to[1] });
}

describe('yAxisDrag: pan', () => {
  it('moves the axis with the pointer, freezing an auto-scaled one', () => {
    const f = fake({ yAxisDrag: 'pan' });
    mount(f);
    // 50 px down a 200 px tall grid: the extent moves up by a quarter of its span.
    dragBand([70, 100], [70, 150]);
    expect(f.writes).toEqual([{ id: 'y', extent: { min: 2.5, max: 12.5 }, freeze: true }]);
  });

  it('stretches with Shift or Alt', () => {
    for (const mods of [{ shiftKey: true }, { altKey: true }]) {
      const f = fake({ yAxisDrag: 'pan' });
      mount(f);
      dragBand([70, 100], [70, 200], mods);
      const [w] = f.writes;
      expect(w.id).toBe('y');
      // About its centre (5): wider, not shifted.
      expect((w.extent.min + w.extent.max) / 2).toBeCloseTo(5);
      expect(w.extent.max - w.extent.min).toBeGreaterThan(10);
      uninstall();
    }
  });

  it('puts the axis back on Escape', () => {
    const f = fake({ yAxisDrag: 'pan' }, { yAuto: false });
    mount(f);
    fireMouse(wrap, 'mousedown', { x: 70, y: 100 });
    fireMouse(window, 'mousemove', { x: 70, y: 150 });
    flush();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(f.writes.at(-1)).toEqual({ id: 'y', extent: { min: 0, max: 10 }, freeze: false });
  });
});

describe('yAxisDrag: stretch (the layer’s own)', () => {
  it('pans with Shift', () => {
    expect(DEFAULT_GESTURE_PREFS.yAxisDrag).toBe('stretch');
    const f = fake(undefined);
    mount(f);
    dragBand([70, 100], [70, 150], { shiftKey: true });
    expect(f.writes).toEqual([{ id: 'y', extent: { min: 2.5, max: 12.5 }, freeze: true }]);
  });
});

describe('doubleClick: none', () => {
  function dblclick(x: number, y: number) {
    const ev = new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    });
    wrap.dispatchEvent(ev);
    return ev;
  }

  it('leaves the plot area’s axes as they are; a band still resets its axis', () => {
    const f = fake({ doubleClick: 'none' }, { yAuto: false });
    mount(f);
    const ev = dblclick(300, 150);
    expect(f.resets).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
    dblclick(70, 150);
    expect(f.resets).toEqual(['y']);
  });

  it('resets every axis with the layer’s own choice', () => {
    expect(DEFAULT_GESTURE_PREFS.doubleClick).toBe('reset');
    const f = fake(undefined, { yAuto: false });
    mount(f);
    dblclick(300, 150);
    expect(f.resets).toEqual(['x', 'y']);
  });
});
