// @vitest-environment jsdom
//
// Time-band drag and double-click. Dragging the tick-label strip under the grid
// stretches the time window about its RIGHT edge (`stretchTimeRightAnchored` by
// `stretchFactorX(dx)`), coalesced to one write per animation frame. A window
// that ends at now keeps following: per-frame writes carry `{ follow: true }`
// and the gesture ends with ONE relative `xAxis` through onApplyXAxis, on every
// end path. Double-click applies All.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { SinglePlot } from './PlotArea';
import type { Axis, Plot, PVTrace } from '../types';
import type { TimeWindowNs } from '../api/time';
import { msToNs, nsToMs, relativeSpanFor } from '../api/time';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import { stretchFactorX } from '../plot/geometry';

// 800x400 canvas, grid insets top 40 / bottom 60 / left 70 / right 20: the
// time band is the tick-label strip y 340..366 over x 70..780.
const { fakeInstance } = vi.hoisted(() => {
  const fakeInstance = {
    getWidth: () => 800,
    getHeight: () => 400,
    isDisposed: () => false,
    getZr: () => ({ setCursorStyle: () => {} }),
    getModel: () => ({
      getComponent: () => ({ axis: { scale: { getExtent: (): [number, number] => [0, 100] } } }),
    }),
    convertToPixel: () => 0,
    convertFromPixel: () => 0,
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

const BAND_Y = 350;
const NOW_MS = 1_800_000_000_000;
const SPAN_MS = 600_000; // 10 minutes
const LIVE = { from: NOW_MS - SPAN_MS, to: NOW_MS };
// Panned back an hour: far from now, so frozen.
const FROZEN = { from: NOW_MS - 3_600_000 - SPAN_MS, to: NOW_MS - 3_600_000 };
const ns = (w: { from: number; to: number }): TimeWindowNs => ({
  fromNs: msToNs(w.from),
  toNs: msToNs(w.to),
});

function axis(id: string): Axis {
  return { id, name: id, orientation: 'left', autoScale: true, logScale: false, visible: true };
}

function trace(id: string, visible = true): PVTrace {
  return {
    id,
    pvName: id,
    displayName: id,
    color: '#000000',
    visible,
    axisId: 'ax1',
    useLive: false,
    useArchive: true,
    data: [],
  } as unknown as PVTrace;
}

function makePlot(traces: PVTrace[] = []): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces,
    axes: [axis('ax1')],
    backgroundColor: 'default',
    showLegend: false,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '10m' },
  };
}

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
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
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

function mountPlot(
  window_: { from: number; to: number },
  plot: Plot = makePlot(),
  archiveResults: Map<string, ArchiveSeriesResult> = new Map()
) {
  const onUpdateAxis = vi.fn();
  const onViewWindowChange = vi.fn();
  const onApplyXAxis = vi.fn();
  const { container, unmount } = render(
    <SinglePlot
      plot={plot}
      archiveResults={archiveResults}
      liveResults={new Map()}
      formulaResults={new Map()}
      onUpdateAxis={onUpdateAxis}
      viewWindowNs={ns(window_)}
      onViewWindowChange={onViewWindowChange}
      onApplyXAxis={onApplyXAxis}
    />
  );
  const wrap = container.querySelector('[data-plot-id="p1"]')!;
  return { wrap, onUpdateAxis, onViewWindowChange, onApplyXAxis, unmount };
}

function mouse(target: EventTarget, type: string, init: MouseEventInit = {}) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}

const down = (wrap: Element, x: number) =>
  mouse(wrap, 'mousedown', { clientX: x, clientY: BAND_Y, button: 0, buttons: 1 });
const move = (x: number, buttons = 1) =>
  mouse(window, 'mousemove', { clientX: x, clientY: BAND_Y, buttons });
const up = (x: number) => mouse(window, 'mouseup', { clientX: x, clientY: BAND_Y, button: 0 });

function windowMs(call: unknown[]) {
  const w = call[0] as TimeWindowNs;
  return { from: nsToMs(w.fromNs), to: nsToMs(w.toNs) };
}

describe('time-band drag on a frozen window', () => {
  it('stretches about the right edge, one write per frame, and never applies an xAxis', () => {
    const { wrap, onViewWindowChange, onApplyXAxis, onUpdateAxis, unmount } = mountPlot(FROZEN);
    const ev = down(wrap, 400);
    expect(ev.defaultPrevented).toBe(true);
    move(420);
    move(450); // dx = +50: narrows
    expect(onViewWindowChange).not.toHaveBeenCalled();
    flushFrames();
    expect(onViewWindowChange).toHaveBeenCalledTimes(1);
    const call = onViewWindowChange.mock.calls[0];
    expect(call.length === 1 || call[1] === undefined || call[1]?.follow !== true).toBe(true);
    const w = windowMs(call);
    expect(w.to).toBeCloseTo(FROZEN.to, -1);
    expect(w.to - w.from).toBeCloseTo(SPAN_MS * stretchFactorX(50), -1);
    expect(w.to - w.from).toBeLessThan(SPAN_MS);
    up(450);
    expect(onApplyXAxis).not.toHaveBeenCalled();
    expect(onUpdateAxis).not.toHaveBeenCalled();
    for (const c of onViewWindowChange.mock.calls) {
      expect(windowMs(c).to).toBeCloseTo(FROZEN.to, -1);
      expect(c[1]?.follow).not.toBe(true);
    }
    unmount();
  });

  it('dragging left widens the window', () => {
    const { wrap, onViewWindowChange, unmount } = mountPlot(FROZEN);
    down(wrap, 400);
    move(300);
    up(300);
    const w = windowMs(onViewWindowChange.mock.calls.at(-1)!);
    expect(w.to).toBeCloseTo(FROZEN.to, -1);
    expect(w.to - w.from).toBeCloseTo(SPAN_MS * stretchFactorX(-100), -1);
    expect(w.to - w.from).toBeGreaterThan(SPAN_MS);
    unmount();
  });

  it('mouseup delivers the pending frame instead of a frame late', () => {
    const { wrap, onViewWindowChange, unmount } = mountPlot(FROZEN);
    down(wrap, 400);
    move(460);
    up(460);
    expect(onViewWindowChange).toHaveBeenCalledTimes(1);
    flushFrames();
    expect(onViewWindowChange).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe('time-band drag on a live window', () => {
  it('writes follow frames, then exactly one relative xAxis on mouseup', () => {
    const { wrap, onViewWindowChange, onApplyXAxis, unmount } = mountPlot(LIVE);
    down(wrap, 400);
    move(430);
    flushFrames();
    move(500);
    flushFrames();
    expect(onViewWindowChange).toHaveBeenCalledTimes(2);
    for (const c of onViewWindowChange.mock.calls) {
      expect(c[1]).toEqual({ follow: true });
      expect(windowMs(c).to).toBeCloseTo(LIVE.to, -1);
    }
    expect(onApplyXAxis).not.toHaveBeenCalled();
    up(500);
    expect(onApplyXAxis).toHaveBeenCalledTimes(1);
    const expected = relativeSpanFor({
      from: LIVE.to - SPAN_MS * stretchFactorX(100),
      to: LIVE.to,
    });
    expect(expected).not.toBeNull();
    expect(onApplyXAxis).toHaveBeenCalledWith({ timeRange: expected });
    // No trailing plain write after the apply.
    expect(onViewWindowChange).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('a drag ended by a mousemove with buttons === 0 still applies exactly one xAxis', () => {
    const { wrap, onApplyXAxis, unmount } = mountPlot(LIVE);
    down(wrap, 400);
    move(440);
    flushFrames();
    move(445, 0); // released outside the window
    expect(onApplyXAxis).toHaveBeenCalledTimes(1);
    expect(onApplyXAxis.mock.calls[0][0].timeRange).toMatch(/^-/);
    // Later moves and a stray mouseup write nothing more.
    move(600, 0);
    up(600);
    flushFrames();
    expect(onApplyXAxis).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('a window blur ends a follow drag with exactly one xAxis', () => {
    const { wrap, onApplyXAxis, unmount } = mountPlot(LIVE);
    down(wrap, 400);
    move(440);
    flushFrames();
    window.dispatchEvent(new Event('blur'));
    expect(onApplyXAxis).toHaveBeenCalledTimes(1);
    up(440);
    expect(onApplyXAxis).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('unmounting mid follow drag still performs the final xAxis write', () => {
    const { wrap, onApplyXAxis, unmount } = mountPlot(LIVE);
    down(wrap, 400);
    move(440);
    flushFrames();
    unmount();
    expect(onApplyXAxis).toHaveBeenCalledTimes(1);
  });

  it('falls back to a plain frozen window when the span is under the relative floor', () => {
    // 1.5 s live window; dragging right 200 px halves it to 750 ms (< 1 s floor).
    const tiny = { from: NOW_MS - 1500, to: NOW_MS };
    const { wrap, onViewWindowChange, onApplyXAxis, unmount } = mountPlot(tiny);
    down(wrap, 400);
    move(600);
    up(600);
    expect(onApplyXAxis).not.toHaveBeenCalled();
    const last = onViewWindowChange.mock.calls.at(-1)!;
    expect(last[1]?.follow).not.toBe(true);
    const w = windowMs(last);
    expect(w.to).toBeCloseTo(tiny.to, -1);
    expect(w.to - w.from).toBeCloseTo(750, -1);
    unmount();
  });
});

describe('time-band clicks', () => {
  it('mousedown + mouseup without movement writes nothing', () => {
    const { wrap, onViewWindowChange, onApplyXAxis, onUpdateAxis, unmount } = mountPlot(LIVE);
    down(wrap, 400);
    move(402); // under the 3 px threshold
    up(402);
    flushFrames();
    expect(onViewWindowChange).not.toHaveBeenCalled();
    expect(onApplyXAxis).not.toHaveBeenCalled();
    expect(onUpdateAxis).not.toHaveBeenCalled();
    unmount();
  });

  it('dblclick on a frozen, panned-back window applies the all-loaded span once', () => {
    const earliest = NOW_MS - 7_200_000; // 2 h of loaded data
    const archive = new Map<string, ArchiveSeriesResult>([
      [
        't1',
        {
          status: 'success',
          mean: [
            { time: earliest, value: 1 },
            { time: NOW_MS - 1000, value: 2 },
          ],
        } as unknown as ArchiveSeriesResult,
      ],
    ]);
    const { wrap, onViewWindowChange, onApplyXAxis, unmount } = mountPlot(
      FROZEN,
      makePlot([trace('t1')]),
      archive
    );
    down(wrap, 400);
    up(400);
    down(wrap, 400);
    up(400);
    mouse(wrap, 'dblclick', { clientX: 400, clientY: BAND_Y, button: 0 });
    flushFrames();
    expect(onApplyXAxis).toHaveBeenCalledTimes(1);
    expect(onApplyXAxis).toHaveBeenCalledWith({
      timeRange: relativeSpanFor({ from: earliest, to: NOW_MS }, 'up'),
    });
    expect(onViewWindowChange).not.toHaveBeenCalled();
    unmount();
  });

  it('dblclick with nothing loaded is a no-op', () => {
    const { wrap, onViewWindowChange, onApplyXAxis, unmount } = mountPlot(FROZEN);
    mouse(wrap, 'dblclick', { clientX: 400, clientY: BAND_Y, button: 0 });
    expect(onApplyXAxis).not.toHaveBeenCalled();
    expect(onViewWindowChange).not.toHaveBeenCalled();
    unmount();
  });

  it('ignores a press whose target is plot chrome', () => {
    const { wrap, onViewWindowChange, unmount } = mountPlot(FROZEN);
    const badge = document.createElement('div');
    badge.setAttribute('data-axis-badge', '');
    wrap.appendChild(badge);
    mouse(badge, 'mousedown', { clientX: 400, clientY: BAND_Y, button: 0, buttons: 1 });
    move(500);
    up(500);
    flushFrames();
    expect(onViewWindowChange).not.toHaveBeenCalled();
    unmount();
  });
});
