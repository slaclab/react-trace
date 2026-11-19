// @vitest-environment jsdom
//
// Trace's plot takes the site's gesture choices (src/site): with the wheel
// set to X alone, a wheel over the plot zooms the time window and leaves an
// auto-scaled Y axis alone; with a Y-axis drag set to pan, dragging the Y axis
// moves it with the pointer; with the double-click set to none, a double-click
// in the plot leaves every axis alone. (The harness is
// PlotArea.wheelRouter.test.tsx's: interior x 70..780, y 40..340, Y 0..100.)
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { resetSiteDefaults } from '../site/store';
import { setSiteConfig } from '../site/testing';
import { fireMouse } from '../plot/testUtils';
import { render } from '@testing-library/react';
import { SinglePlot } from './PlotArea';
import type { Axis, Plot } from '../types';
import type { TimeWindowNs } from '../api/time';
import { msToNs } from '../api/time';
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
  resetSiteDefaults();
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

describe('Trace plot with site gesture choices', () => {
  it('wheel x: zooms the time window, never the Y axis', () => {
    setSiteConfig({ trace: { plot: { wheel: 'x' } } });
    const { wrap, onUpdateAxis, onViewWindowChange } = mountPlot();
    wheel(wrap, { clientX: 400, clientY: 200, deltaY: -100 });
    flushFrames();
    expect(onViewWindowChange).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).not.toHaveBeenCalled();
  });

  it('wheel xy: zooms the Y axis too', () => {
    setSiteConfig({ trace: { plot: { wheel: 'xy' } } });
    const { wrap, onUpdateAxis } = mountPlot();
    wheel(wrap, { clientX: 400, clientY: 200, deltaY: -100 });
    flushFrames();
    expect(onUpdateAxis).toHaveBeenCalled();
  });

  it('yAxisDrag pan: dragging the Y axis moves it with the pointer', () => {
    setSiteConfig({ trace: { plot: { yAxisDrag: 'pan' } } });
    const { wrap, onUpdateAxis } = mountPlot();
    fireMouse(wrap, 'mousedown', { x: 40, y: 200 });
    // 60 px down a 300 px grid: the range moves up by a fifth of its span.
    fireMouse(window, 'mousemove', { x: 40, y: 260 });
    flushFrames();
    fireMouse(window, 'mouseup', { x: 40, y: 260 });
    const [id, patch] = onUpdateAxis.mock.calls.at(-1)!;
    expect(id).toBe('ax1');
    expect(patch.autoScale).toBe(false);
    expect(patch.min).toBeCloseTo(20, 9);
    expect(patch.max).toBeCloseTo(120, 9);
  });

  it('doubleClick none: a double-click in the plot leaves every axis alone', () => {
    setSiteConfig({ trace: { plot: { doubleClick: 'none' } } });
    const manual = {
      ...makePlot(),
      axes: [{ ...axis('ax1', 'left'), autoScale: false, min: 0, max: 100 }],
    };
    const { wrap, onUpdateAxis, onViewWindowChange } = mountPlot(manual);
    wrap.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 400, clientY: 200 })
    );
    expect(onUpdateAxis).not.toHaveBeenCalled();
    expect(onViewWindowChange).not.toHaveBeenCalled();
  });
});
