// @vitest-environment jsdom
//
// The shared plot gesture layer over a fake surface: one 400 x 200 grid at
// (100, 50); x maps [0, 100] across it, y maps [0, 10] up it. Pins the rules
// every plot tool gets: the zoom box (both axes; a thin box zooms one), pan
// (X and the manual Ys), the wheel (the plot area zooms both axes about the
// cursor, a band zooms its axis only, Shift pans X), double-click back to
// auto-scale, and the drawing layer's claim.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bandAt,
  installPlotGestures,
  THIN_BOX_PX,
  type GestureAxis,
  type GestureGrid,
  type PlotGestureSurface,
} from './gestures';
import { wheelFactor, type Extent } from './geometry';
import type { DragMode } from './plotToggles';
import { fireMouse } from './testUtils';

const RECT = { left: 100, top: 50, width: 400, height: 200 };

interface Fake {
  surface: PlotGestureSurface;
  writes: { id: string; extent: Extent; freeze: boolean; wheel: boolean }[];
  resets: string[];
  x: GestureAxis;
  y: GestureAxis;
  setMode(m: DragMode): void;
  claim(on: boolean): void;
}

function fake(opts: { yAuto?: boolean } = {}): Fake {
  const x: GestureAxis = { id: 'x', dim: 'x', log: false, auto: true };
  const y: GestureAxis = { id: 'y', dim: 'y', log: false, auto: opts.yAuto ?? true };
  const grid: GestureGrid = { rect: RECT, x, ys: [y] };
  const extents: Record<string, Extent> = { x: { min: 0, max: 100 }, y: { min: 0, max: 10 } };
  let mode: DragMode = 'zoom';
  let claimed = false;
  const writes: Fake['writes'] = [];
  const resets: string[] = [];
  const surface: PlotGestureSurface = {
    chart: () => ({ getWidth: () => 600, getHeight: () => 300, setCursor: () => {} }),
    grids: () => [grid],
    axisAt: (px, py) => bandAt(px, py, grid, [{ axis: y, side: 'left', slot: 0 }], 60),
    extent: (axis) => extents[axis.id],
    valueAt: (axis, _g, px) => {
      const e = extents[axis.id];
      return axis.dim === 'x'
        ? e.min + ((px - RECT.left) / RECT.width) * (e.max - e.min)
        : e.min + ((RECT.top + RECT.height - px) / RECT.height) * (e.max - e.min);
    },
    write: (axis, extent, o) => {
      writes.push({ id: axis.id, extent, freeze: o.freeze, wheel: o.wheel });
      return true;
    },
    reset: (axis) => void resets.push(axis.id),
    dragMode: () => mode,
    claimsPointer: () => claimed,
  };
  return {
    surface,
    writes,
    resets,
    x,
    y,
    setMode: (m) => (mode = m),
    claim: (on) => (claimed = on),
  };
}

let wrap: HTMLDivElement;
let uninstall: () => void;
let frames: FrameRequestCallback[];

function mount(f: Fake) {
  uninstall = installPlotGestures(wrap, () => f.surface);
}

function drag(from: [number, number], to: [number, number]) {
  fireMouse(wrap, 'mousedown', { x: from[0], y: from[1] });
  fireMouse(window, 'mousemove', { x: (from[0] + to[0]) / 2, y: (from[1] + to[1]) / 2 });
  fireMouse(window, 'mousemove', { x: to[0], y: to[1] });
  fireMouse(window, 'mouseup', { x: to[0], y: to[1] });
}

function wheel(x: number, y: number, init: WheelEventInit = {}): WheelEvent {
  const ev = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    deltaY: -100,
    ...init,
  });
  wrap.dispatchEvent(ev);
  return ev;
}

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

describe('zoom box', () => {
  it('zooms both axes to the box on release, freezing auto-scaled axes', () => {
    const f = fake();
    mount(f);
    // x 200..300 is 25..50; y 100..200 is 7.5..2.5.
    drag([200, 100], [300, 200]);
    expect(f.writes).toEqual([
      { id: 'x', extent: { min: 25, max: 50 }, freeze: true, wheel: false },
      { id: 'y', extent: { min: 2.5, max: 7.5 }, freeze: true, wheel: false },
    ]);
    expect(f.x.auto).toBe(false);
    expect(f.y.auto).toBe(false);
    expect(wrap.querySelector('[data-zoom-box]')).toBeNull();
  });

  it('draws the box while dragging and removes it on release', () => {
    const f = fake();
    mount(f);
    fireMouse(wrap, 'mousedown', { x: 200, y: 100 });
    fireMouse(window, 'mousemove', { x: 260, y: 160 });
    const box = wrap.querySelector('[data-zoom-box]') as HTMLElement;
    expect(box).not.toBeNull();
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual([
      '200px',
      '100px',
      '60px',
      '60px',
    ]);
    fireMouse(window, 'mouseup', { x: 260, y: 160 });
    expect(wrap.querySelector('[data-zoom-box]')).toBeNull();
  });

  it('a box thinner than THIN_BOX_PX in height zooms X only', () => {
    const f = fake();
    mount(f);
    drag([200, 100], [300, 100 + THIN_BOX_PX - 1]);
    expect(f.writes.map((w) => w.id)).toEqual(['x']);
  });

  it('a box thinner than THIN_BOX_PX in width zooms Y only', () => {
    const f = fake();
    mount(f);
    drag([200, 100], [200 + THIN_BOX_PX - 1, 200]);
    expect(f.writes.map((w) => w.id)).toEqual(['y']);
  });

  it('a click (a box thin both ways) writes nothing', () => {
    const f = fake();
    mount(f);
    drag([200, 100], [202, 102]);
    expect(f.writes).toEqual([]);
  });

  it('a press the drawing layer claims draws no box', () => {
    const f = fake();
    f.claim(true);
    mount(f);
    drag([200, 100], [300, 200]);
    expect(f.writes).toEqual([]);
  });
});

describe('pan', () => {
  it('moves X by the drag and leaves an auto-scaled Y alone', () => {
    const f = fake();
    f.setMode('pan');
    mount(f);
    drag([200, 100], [240, 140]);
    frames.forEach((cb) => cb(0));
    // 40 px of 400 is 10 % of the span: the content follows the pointer.
    expect(f.writes).toEqual([
      { id: 'x', extent: { min: -10, max: 90 }, freeze: true, wheel: false },
    ]);
  });

  it('moves a manual Y too', () => {
    const f = fake({ yAuto: false });
    f.setMode('pan');
    mount(f);
    drag([200, 100], [200, 140]);
    // 40 px of 200 is 20 % of the span; a drag down shifts the extent up.
    expect(f.writes).toEqual([
      { id: 'y', extent: { min: 2, max: 12 }, freeze: false, wheel: false },
    ]);
  });
});

describe('wheel', () => {
  it('over the plot area zooms X and Y about the cursor', () => {
    const f = fake();
    mount(f);
    const ev = wheel(200, 100);
    expect(ev.defaultPrevented).toBe(true);
    const k = wheelFactor(-100);
    const [wx, wy] = f.writes;
    expect(wx.id).toBe('x');
    expect(wx.extent.min).toBeCloseTo(25 - 25 * k, 9);
    expect(wx.extent.max).toBeCloseTo(25 + 75 * k, 9);
    expect(wy.id).toBe('y');
    expect(wy.extent.min).toBeCloseTo(7.5 - 7.5 * k, 9);
    expect(wy.extent.max).toBeCloseTo(7.5 + 2.5 * k, 9);
    expect(f.writes.every((w) => w.wheel && w.freeze)).toBe(true);
  });

  it('over the Y band zooms Y only; over the X band X only', () => {
    const f = fake();
    mount(f);
    wheel(70, 100);
    expect(f.writes.map((w) => w.id)).toEqual(['y', 'y']); // freeze, then zoom
    f.writes.length = 0;
    wheel(200, 260);
    expect(f.writes.map((w) => w.id)).toEqual(['x']);
  });

  it('Shift pans X', () => {
    const f = fake();
    mount(f);
    wheel(200, 100, { shiftKey: true, deltaY: 40 });
    expect(f.writes).toEqual([
      { id: 'x', extent: { min: 10, max: 110 }, freeze: true, wheel: true },
    ]);
  });

  it('outside every grid and band is left to the page', () => {
    const f = fake();
    mount(f);
    expect(wheel(580, 290).defaultPrevented).toBe(false);
    expect(f.writes).toEqual([]);
  });
});

describe('double-click', () => {
  it('on the Y band resets a manual Y; an auto-scaled one writes nothing', () => {
    const f = fake({ yAuto: false });
    mount(f);
    fireMouse(wrap, 'dblclick', { x: 70, y: 100 });
    expect(f.resets).toEqual(['y']);
    fireMouse(wrap, 'dblclick', { x: 70, y: 100 });
    expect(f.resets).toEqual(['y']);
  });

  it('in the plot area resets every axis of the grid', () => {
    const f = fake({ yAuto: false });
    f.x.auto = false;
    mount(f);
    fireMouse(wrap, 'dblclick', { x: 200, y: 100 });
    expect(f.resets).toEqual(['x', 'y']);
  });

  it('on a drawing resets nothing', () => {
    const f = fake({ yAuto: false });
    mount(f);
    const g = document.createElement('div');
    g.setAttribute('data-annotation-id', 'a1');
    wrap.appendChild(g);
    fireMouse(g, 'dblclick', { x: 200, y: 100 });
    expect(f.resets).toEqual([]);
  });
});
