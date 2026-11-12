// @vitest-environment jsdom
//
// The plot-root wheel router: ONE capture-phase wheel listener routes by hit
// test — a Y band zooms that axis, the time band and the grid interior zoom (or
// pan) the time window about the cursor, alt+wheel zooms the primary Y axis,
// and anything else is left alone. Window results accumulate in a pending
// window and flush once per animation frame, and the cursor time comes from the
// window being zoomed, never from convertFromPixel, which lags until the next
// `finished`.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { SinglePlot } from './PlotArea';
import type { Axis, Plot } from '../types';
import type { TimeWindowNs } from '../api/time';
import { msToNs, nsToMs } from '../api/time';
import { wheelFactor } from '../plot/geometry';

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

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

const GRID_LEFT = 70;
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

function lastWindowMs(fn: ReturnType<typeof vi.fn>) {
  const w = fn.mock.calls.at(-1)![0] as TimeWindowNs;
  return { from: nsToMs(w.fromNs), to: nsToMs(w.toNs) };
}

// msToNs/nsToMs truncate to whole milliseconds at the ns boundary, so window
// comparisons below use toBeCloseTo(_, -1): within 5 ms of spans near 10^6 ms.

// Data time under canvas x for a window.
const timeAt = (w: { from: number; to: number }, x: number) =>
  w.from + ((x - GRID_LEFT) / GRID_WIDTH) * (w.to - w.from);

describe('grid-interior wheel', () => {
  it('flushes exactly one onViewWindowChange with a narrower window around the cursor', () => {
    const { wrap, onViewWindowChange, onUpdateAxis, unmount } = mountPlot();
    const x = 141; // 71 px into the grid
    const ev = wheel(wrap, { clientX: x, clientY: 200, deltaY: -100 });
    expect(ev.defaultPrevented).toBe(true);
    // Nothing until the frame flushes.
    expect(onViewWindowChange).not.toHaveBeenCalled();
    flushFrames();
    expect(onViewWindowChange).toHaveBeenCalledTimes(1);
    const w = lastWindowMs(onViewWindowChange);
    const f = wheelFactor(-100);
    expect(w.to - w.from).toBeCloseTo((TO_MS - FROM_MS) * f, -1);
    expect(w.to - w.from).toBeLessThan(TO_MS - FROM_MS);
    const tCursor = timeAt({ from: FROM_MS, to: TO_MS }, x);
    expect(timeAt(w, x)).toBeCloseTo(tCursor, -1);
    expect(w.from).toBeLessThan(tCursor);
    expect(w.to).toBeGreaterThan(tCursor);
    // Both axes zoom: the Y axis about the value under the cursor, at once.
    const anchor = ((340 - 200) / 300) * 100;
    expect(onUpdateAxis).toHaveBeenCalledWith('ax1', {
      autoScale: false,
      min: expect.closeTo(anchor - anchor * f, 6),
      max: expect.closeTo(anchor + (100 - anchor) * f, 6),
    });
    unmount();
  });

  it('compounds three events without a re-render to factor^3 in one call', () => {
    const { wrap, onViewWindowChange, unmount } = mountPlot();
    const x = 500;
    for (let i = 0; i < 3; i++) wheel(wrap, { clientX: x, clientY: 200, deltaY: -60 });
    flushFrames();
    expect(onViewWindowChange).toHaveBeenCalledTimes(1);
    const w = lastWindowMs(onViewWindowChange);
    const f = wheelFactor(-60);
    expect(w.to - w.from).toBeCloseTo((TO_MS - FROM_MS) * f ** 3, -1);
    expect(timeAt(w, x)).toBeCloseTo(timeAt({ from: FROM_MS, to: TO_MS }, x), -1);
    unmount();
  });

  it('keeps compounding from the pending window until the prop catches up', () => {
    const { wrap, onViewWindowChange, rerender, unmount } = mountPlot();
    const x = 300;
    wheel(wrap, { clientX: x, clientY: 200, deltaY: -60 });
    flushFrames();
    const first = lastWindowMs(onViewWindowChange);
    // A second event before the parent re-renders zooms from the sent window.
    wheel(wrap, { clientX: x, clientY: 200, deltaY: -60 });
    flushFrames();
    const second = lastWindowMs(onViewWindowChange);
    expect(second.to - second.from).toBeCloseTo((first.to - first.from) * wheelFactor(-60), -1);
    // Someone else moves the window: the next event starts from the new prop.
    const moved = { from: 5_000_000, to: 5_000_000 + GRID_WIDTH * 2000 };
    rerender({ fromNs: msToNs(moved.from), toNs: msToNs(moved.to) });
    wheel(wrap, { clientX: x, clientY: 200, deltaY: -60 });
    flushFrames();
    const third = lastWindowMs(onViewWindowChange);
    expect(third.to - third.from).toBeCloseTo((moved.to - moved.from) * wheelFactor(-60), -1);
    expect(timeAt(third, x)).toBeCloseTo(timeAt(moved, x), -1);
    unmount();
  });

  it('a ctrlKey (trackpad pinch) wheel zooms once and never scrolls the page', () => {
    const { wrap, onViewWindowChange, unmount } = mountPlot();
    const ev = wheel(wrap, { clientX: 400, clientY: 200, deltaY: 8, ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    flushFrames();
    expect(onViewWindowChange).toHaveBeenCalledTimes(1);
    const w = lastWindowMs(onViewWindowChange);
    expect(w.to - w.from).toBeCloseTo((TO_MS - FROM_MS) * wheelFactor(8), -1);
    unmount();
  });

  it('a ctrlKey wheel over the time band zooms even with a horizontal delta', () => {
    const { wrap, onViewWindowChange, unmount } = mountPlot();
    const ev = wheel(wrap, { clientX: 400, clientY: 350, deltaX: 50, deltaY: -5, metaKey: true });
    expect(ev.defaultPrevented).toBe(true);
    flushFrames();
    const w = lastWindowMs(onViewWindowChange);
    expect(w.to - w.from).toBeCloseTo((TO_MS - FROM_MS) * wheelFactor(-5), -1);
    unmount();
  });

  it('shift+wheel pans the window by the scrolled pixels, keeping its span', () => {
    const { wrap, onViewWindowChange, unmount } = mountPlot();
    const ev = wheel(wrap, { clientX: 400, clientY: 200, deltaY: 71, shiftKey: true });
    expect(ev.defaultPrevented).toBe(true);
    flushFrames();
    const w = lastWindowMs(onViewWindowChange);
    expect(w.to - w.from).toBeCloseTo(TO_MS - FROM_MS, -1);
    expect(w.from - FROM_MS).toBeCloseTo(71_000, -1);
    unmount();
  });

  it('a mostly-horizontal scroll pans instead of zooming', () => {
    const { wrap, onViewWindowChange, unmount } = mountPlot();
    wheel(wrap, { clientX: 400, clientY: 200, deltaX: -142, deltaY: 3 });
    flushFrames();
    const w = lastWindowMs(onViewWindowChange);
    expect(w.to - w.from).toBeCloseTo(TO_MS - FROM_MS, -1);
    expect(w.from - FROM_MS).toBeCloseTo(-142_000, -1);
    unmount();
  });

  it('alt+wheel zooms the primary Y axis only and leaves the window alone', () => {
    const { wrap, onUpdateAxis, onViewWindowChange, unmount } = mountPlot(
      makePlot([axis('ax1', 'left'), axis('ax2', 'right')])
    );
    // y=190 -> value 50 on the fake axis; the auto-scaled axis freezes first.
    const ev = wheel(wrap, { clientX: 400, clientY: 190, deltaY: -100, altKey: true });
    expect(ev.defaultPrevented).toBe(true);
    flushFrames();
    expect(onViewWindowChange).not.toHaveBeenCalled();
    expect(onUpdateAxis).toHaveBeenCalled();
    for (const call of onUpdateAxis.mock.calls) expect(call[0]).toBe('ax1');
    expect(onUpdateAxis).toHaveBeenNthCalledWith(1, 'ax1', { autoScale: false, min: 0, max: 100 });
    const f = wheelFactor(-100);
    expect(onUpdateAxis).toHaveBeenLastCalledWith('ax1', {
      min: expect.closeTo(50 - 50 * f, 6),
      max: expect.closeTo(50 + 50 * f, 6),
    });
    unmount();
  });
});

describe('time band wheel', () => {
  it('zooms the time window about the cursor', () => {
    const { wrap, onViewWindowChange, unmount } = mountPlot();
    const x = 600;
    const ev = wheel(wrap, { clientX: x, clientY: 350, deltaY: 100 });
    expect(ev.defaultPrevented).toBe(true);
    flushFrames();
    expect(onViewWindowChange).toHaveBeenCalledTimes(1);
    const w = lastWindowMs(onViewWindowChange);
    expect(w.to - w.from).toBeCloseTo((TO_MS - FROM_MS) * wheelFactor(100), -1);
    expect(w.to - w.from).toBeGreaterThan(TO_MS - FROM_MS);
    expect(timeAt(w, x)).toBeCloseTo(timeAt({ from: FROM_MS, to: TO_MS }, x), -1);
    unmount();
  });
});

describe('Y band and elsewhere', () => {
  it('a Y-band wheel zooms that axis and leaves the window unchanged', () => {
    const { wrap, onUpdateAxis, onViewWindowChange, unmount } = mountPlot();
    const ev = wheel(wrap, { clientX: 30, clientY: 190, deltaY: -100 });
    expect(ev.defaultPrevented).toBe(true);
    flushFrames();
    expect(onViewWindowChange).not.toHaveBeenCalled();
    expect(onUpdateAxis).toHaveBeenLastCalledWith('ax1', {
      min: expect.closeTo(50 - 50 / 1.1, 6),
      max: expect.closeTo(50 + 50 / 1.1, 6),
    });
    unmount();
  });

  it('ignores wheels over the legend row below the time band', () => {
    const { wrap, onViewWindowChange, onUpdateAxis, unmount } = mountPlot();
    const ev = wheel(wrap, { clientX: 400, clientY: 390, deltaY: -100 });
    expect(ev.defaultPrevented).toBe(false);
    flushFrames();
    expect(onViewWindowChange).not.toHaveBeenCalled();
    expect(onUpdateAxis).not.toHaveBeenCalled();
    unmount();
  });

  it('ignores wheels whose target is plot chrome', () => {
    const { wrap, onViewWindowChange, unmount } = mountPlot();
    const badge = document.createElement('div');
    badge.setAttribute('data-axis-badge', '');
    wrap.appendChild(badge);
    const ev = wheel(badge, { clientX: 400, clientY: 200, deltaY: -100 });
    expect(ev.defaultPrevented).toBe(false);
    flushFrames();
    expect(onViewWindowChange).not.toHaveBeenCalled();
    unmount();
  });

  it('stops a handled wheel before it reaches the chart (capture phase)', () => {
    const { wrap, unmount } = mountPlot();
    const inner = document.createElement('div');
    wrap.appendChild(inner);
    const seen = vi.fn();
    inner.addEventListener('wheel', seen);
    wheel(inner, { clientX: 400, clientY: 200, deltaY: -100 });
    expect(seen).not.toHaveBeenCalled();
    unmount();
  });

  it('cancels a pending frame on unmount', () => {
    const { wrap, onViewWindowChange, unmount } = mountPlot();
    wheel(wrap, { clientX: 400, clientY: 200, deltaY: -100 });
    unmount();
    flushFrames();
    expect(onViewWindowChange).not.toHaveBeenCalled();
  });
});
