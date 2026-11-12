// @vitest-environment jsdom
//
// Interior pan: in the pan drag mode, a left-drag inside the grid that hits no
// band and that the drawing overlay does not claim pans the time window
// (panTime -> onViewWindowChange) and every visible NON-auto Y axis
// (panExtentBy in S space -> onUpdateAxis), both coalesced to one write per
// animation frame. Auto-scaled axes are left alone; `buttons === 0` ends a lost
// drag.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SinglePlot } from './PlotArea';
import type { Axis, Plot } from '../types';
import type { TimeWindowNs } from '../api/time';
import { msToNs, nsToMs } from '../api/time';

// 800x400 canvas. One left axis (manual) + one right axis (auto) gives grid
// insets top 40 / bottom 60 / left 70 / right 70: interior x 70..730 (660 px),
// y 40..340 (300 px). Every axis reports the extent [0, 100] over px 340..40.
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
    convertToPixel: (_f: unknown, value: number) => HEIGHT - BOTTOM - (value / 100) * PX_SPAN,
    convertFromPixel: (_f: unknown, px: number) => ((HEIGHT - BOTTOM - px) / PX_SPAN) * 100,
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

const GRID_WIDTH = 660;
const NOW_MS = 1_800_000_000_000;
const SPAN_MS = 600_000;
const WINDOW = { from: NOW_MS - 3_600_000 - SPAN_MS, to: NOW_MS - 3_600_000 };
const ns = (w: { from: number; to: number }): TimeWindowNs => ({
  fromNs: msToNs(w.from),
  toNs: msToNs(w.to),
});

const manual: Axis = {
  id: 'manual',
  name: 'manual',
  orientation: 'left',
  autoScale: false,
  logScale: false,
  min: 0,
  max: 100,
  visible: true,
};
const auto: Axis = {
  id: 'auto',
  name: 'auto',
  orientation: 'right',
  autoScale: true,
  logScale: false,
  visible: true,
};

function makePlot(axes: Axis[] = [manual, auto]): Plot {
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
    xAxis: { timeRange: '10m' },
    // Interior pan is the drag of the pan mode.
    dragMode: 'pan',
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

function mountPlot(plot: Plot = makePlot(), withWindowWriter = true) {
  const onUpdateAxis = vi.fn();
  const onViewWindowChange = vi.fn();
  const { container, unmount } = render(
    <SinglePlot
      plot={plot}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
      onUpdateAxis={onUpdateAxis}
      viewWindowNs={ns(WINDOW)}
      onViewWindowChange={withWindowWriter ? onViewWindowChange : undefined}
    />
  );
  const wrap = container.querySelector('[data-plot-id="p1"]')!;
  return { wrap, onUpdateAxis, onViewWindowChange, unmount };
}

function mouse(target: EventTarget, type: string, init: MouseEventInit = {}) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}
const down = (target: EventTarget, x: number, y: number) =>
  mouse(target, 'mousedown', { clientX: x, clientY: y, button: 0, buttons: 1 });
const move = (x: number, y: number, buttons = 1) =>
  mouse(window, 'mousemove', { clientX: x, clientY: y, buttons });
const up = (x: number, y: number) =>
  mouse(window, 'mouseup', { clientX: x, clientY: y, button: 0 });

function windowMs(call: unknown[]) {
  const w = call[0] as TimeWindowNs;
  return { from: nsToMs(w.fromNs), to: nsToMs(w.toNs) };
}

const DT_50 = -(50 / GRID_WIDTH) * SPAN_MS; // drag right 50 px: window moves earlier
const DV_50 = (50 / 300) * 100; // drag down 50 px: extent moves up by 50 px of value

describe('interior pan', () => {
  it('a 50 px drag pans time by the projected dt and the manual axis by the projected dv', () => {
    const { wrap, onUpdateAxis, onViewWindowChange, unmount } = mountPlot();
    const ev = down(wrap, 400, 200);
    expect(ev.defaultPrevented).toBe(true);
    move(420, 220);
    move(450, 250);
    // Nothing is written until the frame runs.
    expect(onViewWindowChange).not.toHaveBeenCalled();
    expect(onUpdateAxis).not.toHaveBeenCalled();
    flushFrames();

    expect(onViewWindowChange).toHaveBeenCalledTimes(1);
    const w = windowMs(onViewWindowChange.mock.calls[0]);
    expect(w.from).toBeCloseTo(WINDOW.from + DT_50, 0);
    expect(w.to).toBeCloseTo(WINDOW.to + DT_50, 0);
    // A pan freezes the window: no follow opt.
    expect(onViewWindowChange.mock.calls[0][1]).toBeUndefined();

    // The value under the pointer stays under the pointer.
    const v0 = fakeInstance.convertFromPixel(null, 200);
    const v1 = fakeInstance.convertFromPixel(null, 250);
    expect(v0 - v1).toBeCloseTo(DV_50, 9);

    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    const [axisId, updates] = onUpdateAxis.mock.calls[0];
    expect(axisId).toBe('manual');
    expect(updates.min).toBeCloseTo(DV_50, 9);
    expect(updates.max).toBeCloseTo(100 + DV_50, 9);
    expect(updates.autoScale).toBeUndefined();
    // The auto-scaled axis is never written.
    expect(onUpdateAxis.mock.calls.some((c) => c[0] === 'auto')).toBe(false);

    up(450, 250);
    flushFrames();
    expect(onViewWindowChange).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('applies the TOTAL drag to the captured state and flushes the pending frame on mouseup', () => {
    const { wrap, onUpdateAxis, onViewWindowChange, unmount } = mountPlot();
    down(wrap, 400, 200);
    move(425, 225);
    flushFrames();
    move(450, 250);
    up(450, 250); // delivers the pending frame now
    expect(onViewWindowChange).toHaveBeenCalledTimes(2);
    const last = windowMs(onViewWindowChange.mock.calls[1]);
    expect(last.from).toBeCloseTo(WINDOW.from + DT_50, 0);
    const updates = onUpdateAxis.mock.calls[onUpdateAxis.mock.calls.length - 1][1];
    expect(updates.min).toBeCloseTo(DV_50, 9);
    expect(updates.max).toBeCloseTo(100 + DV_50, 9);
    expect(frames.size).toBe(0);
    unmount();
  });

  it('pans a log axis in S space', () => {
    const logAxis: Axis = { ...manual, logScale: true, min: 1, max: 1000 };
    // Fake reports [0,100] live; manual log axes capture from the live scale,
    // so mock a positive extent for this test.
    const spy = vi.spyOn(fakeInstance, 'getModel').mockReturnValue({
      getComponent: () => ({ axis: { scale: { getExtent: (): [number, number] => [1, 1000] } } }),
    });
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot([logAxis, auto]));
    down(wrap, 400, 200);
    move(400, 300); // 100 px down = one third of the 3-decade S span = 1 decade
    flushFrames();
    const [, updates] = onUpdateAxis.mock.calls[0];
    expect(updates.min).toBeCloseTo(10, 6);
    expect(updates.max).toBeCloseTo(10_000, 3);
    spy.mockRestore();
    unmount();
  });

  it('a press within the click threshold writes nothing', () => {
    const { wrap, onUpdateAxis, onViewWindowChange, unmount } = mountPlot();
    down(wrap, 400, 200);
    move(402, 202);
    flushFrames();
    up(402, 202);
    flushFrames();
    expect(onViewWindowChange).not.toHaveBeenCalled();
    expect(onUpdateAxis).not.toHaveBeenCalled();
    unmount();
  });

  it('a move with no button held ends a lost drag', () => {
    const { wrap, onUpdateAxis, onViewWindowChange, unmount } = mountPlot();
    down(wrap, 400, 200);
    move(450, 250);
    move(460, 260, 0); // released elsewhere: ends, delivering the pending frame
    const calls = onViewWindowChange.mock.calls.length;
    const axisCalls = onUpdateAxis.mock.calls.length;
    move(500, 300, 0);
    move(550, 330, 1);
    flushFrames();
    expect(onViewWindowChange.mock.calls.length).toBe(calls);
    expect(onUpdateAxis.mock.calls.length).toBe(axisCalls);
    unmount();
  });

  it('leaves every auto axis alone and still pans time', () => {
    const { wrap, onUpdateAxis, onViewWindowChange, unmount } = mountPlot(
      makePlot([{ ...auto, orientation: 'left' }])
    );
    down(wrap, 400, 200);
    move(450, 250);
    flushFrames();
    up(450, 250);
    expect(onViewWindowChange).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).not.toHaveBeenCalled();
    unmount();
  });

  it('pans the manual axis without a window writer', () => {
    const { wrap, onUpdateAxis, onViewWindowChange, unmount } = mountPlot(makePlot(), false);
    down(wrap, 400, 200);
    move(450, 250);
    flushFrames();
    expect(onViewWindowChange).not.toHaveBeenCalled();
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('ignores presses on plot chrome, non-left buttons and the bands', () => {
    const { wrap, onUpdateAxis, onViewWindowChange, unmount } = mountPlot();
    const chrome = document.createElement('div');
    chrome.setAttribute('data-axis-badge', '');
    wrap.appendChild(chrome);
    down(chrome, 400, 200);
    move(450, 250);
    flushFrames();
    up(450, 250);
    mouse(wrap, 'mousedown', { clientX: 400, clientY: 200, button: 2, buttons: 2 });
    move(450, 250, 2);
    flushFrames();
    up(450, 250);
    // Outside the grid, above it: not interior.
    down(wrap, 400, 20);
    move(450, 70);
    flushFrames();
    up(450, 70);
    expect(onViewWindowChange).not.toHaveBeenCalled();
    expect(onUpdateAxis).not.toHaveBeenCalled();
    unmount();
  });

  it('cancels a pending pan frame on unmount without writing', () => {
    const { wrap, onUpdateAxis, onViewWindowChange, unmount } = mountPlot();
    down(wrap, 400, 200);
    move(450, 250);
    unmount();
    flushFrames();
    expect(onViewWindowChange).not.toHaveBeenCalled();
    expect(onUpdateAxis).not.toHaveBeenCalled();
  });
});
