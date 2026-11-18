// @vitest-environment jsdom
//
// Trace's shipped plot gestures (src/site/builtins.ts, C1-C4), on a whole
// plot with no site defaults. The harness is PlotArea.wheelRouter.test.tsx's:
// interior x 70..780 (1 px = 1 s), y 40..340 with Y 0..100 up it; the Y
// axis band is left of x 70.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireMouse } from '../plot/testUtils';
import { render } from '@testing-library/react';
import { SinglePlot } from './PlotArea';
import type { Axis, Plot } from '../types';
import type { TimeWindowNs } from '../api/time';
import { msToNs, nsToMs } from '../api/time';
import { chartStub } from '../test/chartStub';

// 800x400 canvas, grid insets top 40 / bottom 60 / left 70 / right 20 (one
// left axis): the interior spans x 70..780 (710 px) and y 40..340; the time
// band is the tick-label strip y 340..366.
const { fakeInstance } = vi.hoisted(() => {
  const HEIGHT = 400;
  const BOTTOM = 60;
  const PX_SPAN = 300;
  const fakeInstance = {
    getWidth: () => 800,
    getHeight: () => HEIGHT,
    isDisposed: () => false,
    getZr: () => ({ setCursorStyle: () => {} }),
    getModel: () => ({
      getComponent: () => ({ axis: { scale: { getExtent: (): [number, number] => [0, 100] } } }),
    }),
    convertToPixel: (_finder: unknown, value: number) => HEIGHT - BOTTOM - (value / 100) * PX_SPAN,
    convertFromPixel: (_finder: unknown, px: number) => ((HEIGHT - BOTTOM - px) / PX_SPAN) * 100,
  };
  return { fakeInstance };
});

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);
chartStub.instance = fakeInstance;

const GRID_WIDTH = 710;
// 1 px of grid = 1000 ms; small epoch values keep the ns conversion exact.
const FROM_MS = 1_000_000;
const TO_MS = FROM_MS + GRID_WIDTH * 1000;
const WINDOW: TimeWindowNs = { fromNs: msToNs(FROM_MS), toNs: msToNs(TO_MS) };

function axis(id: string, orientation: 'left' | 'right'): Axis {
  return { id, name: id, orientation, autoScale: true, logScale: false, visible: true };
}

function makePlot(axes: Axis[] = [axis('ax1', 'left')]): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [],
    axes,
    backgroundColor: 'default',
    showLegend: false,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '1h' },
  };
}

// rAF is driven by hand so a test decides when the frame flushes.
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
function flushFrames() {
  const pending = [...frames.values()];
  frames.clear();
  for (const cb of pending) cb(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  frames = new Map();
  nextFrame = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mountPlot(plot: Plot = makePlot(), viewWindowNs: TimeWindowNs = WINDOW) {
  const onUpdateAxis = vi.fn();
  const onViewWindowChange = vi.fn();
  const element = (w: TimeWindowNs) => (
    <SinglePlot
      plot={plot}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
      onUpdateAxis={onUpdateAxis}
      viewWindowNs={w}
      onViewWindowChange={onViewWindowChange}
    />
  );
  const { container, unmount, rerender } = render(element(viewWindowNs));
  const wrap = container.querySelector('[data-plot-id="p1"]')!;
  return {
    wrap,
    onUpdateAxis,
    onViewWindowChange,
    unmount,
    rerender: (w: TimeWindowNs) => rerender(element(w)),
  };
}

function wheel(target: Element, init: WheelEventInit & { clientX: number; clientY: number }) {
  const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}

describe('C1: the left-drag and the time pans', () => {
  it('a left-drag in the plot draws a zoom box: the window and the Y axis zoom to it', () => {
    const { wrap, onUpdateAxis, onViewWindowChange } = mountPlot();
    fireMouse(wrap, 'mousedown', { x: 170, y: 100 });
    fireMouse(window, 'mousemove', { x: 370, y: 250 });
    fireMouse(window, 'mouseup', { x: 370, y: 250 });
    flushFrames();
    const w = onViewWindowChange.mock.calls.at(-1)![0] as TimeWindowNs;
    expect(nsToMs(w.fromNs)).toBeCloseTo(FROM_MS + 100_000, -1);
    expect(nsToMs(w.toNs)).toBeCloseTo(FROM_MS + 300_000, -1);
    expect(onUpdateAxis).toHaveBeenCalledWith('ax1', expect.objectContaining({ autoScale: false }));
  });

  it('Shift+wheel pans time and keeps its span', () => {
    const { wrap, onUpdateAxis, onViewWindowChange } = mountPlot();
    wheel(wrap, { clientX: 400, clientY: 200, deltaY: 100, shiftKey: true });
    flushFrames();
    const w = onViewWindowChange.mock.calls.at(-1)![0] as TimeWindowNs;
    expect(nsToMs(w.toNs) - nsToMs(w.fromNs)).toBeCloseTo(TO_MS - FROM_MS, -1);
    expect(nsToMs(w.fromNs)).toBeGreaterThan(FROM_MS);
    expect(onUpdateAxis).not.toHaveBeenCalled();
  });
});

describe('C2: the wheel over the plot zooms time only', () => {
  it('zooms the time window and leaves an auto-scaled Y axis alone', () => {
    const { wrap, onUpdateAxis, onViewWindowChange } = mountPlot();
    wheel(wrap, { clientX: 400, clientY: 200, deltaY: -100 });
    flushFrames();
    const w = onViewWindowChange.mock.calls.at(-1)![0] as TimeWindowNs;
    expect(nsToMs(w.toNs) - nsToMs(w.fromNs)).toBeLessThan(TO_MS - FROM_MS);
    expect(onUpdateAxis).not.toHaveBeenCalled();
  });

  it('Alt+wheel zooms the Y axes too', () => {
    const { wrap, onUpdateAxis, onViewWindowChange } = mountPlot();
    wheel(wrap, { clientX: 400, clientY: 200, deltaY: -100, altKey: true });
    flushFrames();
    expect(onViewWindowChange).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).toHaveBeenCalledWith('ax1', expect.objectContaining({ autoScale: false }));
  });

  it('the wheel over a Y axis still zooms that axis alone', () => {
    const { wrap, onUpdateAxis, onViewWindowChange } = mountPlot();
    wheel(wrap, { clientX: 40, clientY: 200, deltaY: -100 });
    flushFrames();
    expect(onUpdateAxis).toHaveBeenCalled();
    for (const call of onUpdateAxis.mock.calls) expect(call[0]).toBe('ax1');
    expect(onViewWindowChange).not.toHaveBeenCalled();
  });
});

describe('C3: dragging a Y axis pans that axis', () => {
  it('a plain drag moves the axis with the pointer', () => {
    const { wrap, onUpdateAxis } = mountPlot();
    // 60 px down a 300 px grid: the range moves up by a fifth of its span.
    fireMouse(wrap, 'mousedown', { x: 40, y: 200 });
    fireMouse(window, 'mousemove', { x: 40, y: 260 });
    flushFrames();
    fireMouse(window, 'mouseup', { x: 40, y: 260 });
    expect(onUpdateAxis).toHaveBeenLastCalledWith('ax1', {
      autoScale: false,
      min: expect.closeTo(20, 9),
      max: expect.closeTo(120, 9),
    });
  });

  it.each([
    ['Shift', { shiftKey: true }],
    ['Alt', { altKey: true }],
  ])('%s+drag stretches it about its centre', (_key, mods) => {
    const { wrap, onUpdateAxis } = mountPlot();
    fireMouse(wrap, 'mousedown', { x: 40, y: 200, ...mods });
    fireMouse(window, 'mousemove', { x: 40, y: 300 });
    flushFrames();
    fireMouse(window, 'mouseup', { x: 40, y: 300 });
    const { min, max } = onUpdateAxis.mock.calls.at(-1)![1] as { min: number; max: number };
    expect((min + max) / 2).toBeCloseTo(50, 9);
    expect(max - min).toBeGreaterThan(100);
  });
});
