// @vitest-environment jsdom
//
// Mounts SinglePlot with a mocked echarts-for-react and drives REAL DOM mouse
// events through the wrapper div. This pins the wiring that broke the first
// version of issue 45: listeners must live on the wrapper (not a zrender
// instance that echarts-for-react disposes right after mount) and resolve the
// chart lazily. A Y-band drag stretches the axis about its centre, one write
// per animation frame.
import { wheelFactor } from '../plot/geometry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { SinglePlot } from './PlotArea';
import type { Axis, Plot } from '../types';

// Chart geometry the fake instance reports: 800x400 canvas, grid insets
// top 40 / bottom 60 / left 70 / right 20 (one left axis), so the y-axis spans
// pixels 340 (min, bottom) to 40 (max, top) and the extent is [0, 100].
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

function makePlot(axis: Partial<Axis> = {}): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [],
    axes: [
      {
        id: 'ax1',
        name: 'Y',
        orientation: 'left',
        autoScale: true,
        logScale: false,
        visible: true,
        ...axis,
      },
    ],
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

function mountPlot(plot: Plot) {
  const onUpdateAxis = vi.fn();
  const { container, unmount } = render(
    <SinglePlot
      plot={plot}
      endMs={0}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
      onUpdateAxis={onUpdateAxis}
    />
  );
  const wrap = container.querySelector('[data-plot-id="p1"]')!;
  return { wrap, onUpdateAxis, unmount };
}

// --- animation frames, flushed by hand (as in Sidebar.resize.test.tsx) -------

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;

function flushFrames() {
  act(() => {
    for (let round = 0; round < 5 && frames.size > 0; round++) {
      const due = [...frames.values()];
      frames = new Map();
      due.forEach((cb) => cb(performance.now()));
    }
  });
}

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Stretch law: 200 px of drag is one factor of two about
// the extent's centre, so +/-100 px scales the [0, 100] span by 2^+/-0.5.
const UP_100 = { min: 50 - 50 / Math.SQRT2, max: 50 + 50 / Math.SQRT2 };
const DOWN_100 = { min: 50 - 50 * Math.SQRT2, max: 50 + 50 * Math.SQRT2 };

// jsdom reports a 0,0 bounding rect for the wrapper, so clientX/clientY ARE
// canvas-pixel coordinates here.
describe('per-axis drag stretch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a plain click (mousedown + mouseup, no movement) writes nothing', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    fireEvent.mouseUp(window);
    flushFrames();
    expect(onUpdateAxis).not.toHaveBeenCalled();
    unmount();
  });

  it('a double-click on the axis band writes nothing', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    for (let i = 0; i < 2; i++) {
      fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
      fireEvent.mouseUp(window);
    }
    flushFrames();
    expect(onUpdateAxis).not.toHaveBeenCalled();
    unmount();
  });

  it('movement of 3 px or less does not start a stretch', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 203, buttons: 1 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 197, buttons: 1 });
    flushFrames();
    fireEvent.mouseUp(window);
    flushFrames();
    expect(onUpdateAxis).not.toHaveBeenCalled();
    unmount();
  });

  it('dragging UP 100 px narrows the span by 2^0.5 about the centre, freezing in the same write', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    // Window listeners: the drag must keep tracking outside the wrapper.
    // buttons:1 = button still held.
    fireEvent.mouseMove(window, { clientX: 30, clientY: 100, buttons: 1 });
    // Coalesced: nothing is written until the frame runs.
    expect(onUpdateAxis).not.toHaveBeenCalled();
    flushFrames();
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).toHaveBeenCalledWith('ax1', {
      autoScale: false,
      min: expect.closeTo(UP_100.min, 6),
      max: expect.closeTo(UP_100.max, 6),
    });
    const { min, max } = onUpdateAxis.mock.calls[0][1] as { min: number; max: number };
    expect((min + max) / 2).toBeCloseTo(50, 9);
    expect(max - min).toBeCloseTo(100 / Math.SQRT2, 9);
    unmount();
  });

  it('dragging DOWN 100 px widens the span by 2^0.5 about the centre', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(
      makePlot({ autoScale: false, min: 0, max: 100 })
    );
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 300, buttons: 1 });
    flushFrames();
    // A manually-ranged axis is never re-frozen: plain min/max only.
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).toHaveBeenCalledWith('ax1', {
      min: expect.closeTo(DOWN_100.min, 6),
      max: expect.closeTo(DOWN_100.max, 6),
    });
    unmount();
  });

  it('writes exactly once per flushed frame, from the captured extent (no compounding)', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 150, buttons: 1 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 120, buttons: 1 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 100, buttons: 1 });
    flushFrames();
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).toHaveBeenLastCalledWith('ax1', {
      autoScale: false,
      min: expect.closeTo(UP_100.min, 6),
      max: expect.closeTo(UP_100.max, 6),
    });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 250, buttons: 1 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 300, buttons: 1 });
    flushFrames();
    expect(onUpdateAxis).toHaveBeenCalledTimes(2);
    // The freeze went out with the first frame only; later frames are plain.
    expect(onUpdateAxis).toHaveBeenLastCalledWith('ax1', {
      min: expect.closeTo(DOWN_100.min, 6),
      max: expect.closeTo(DOWN_100.max, 6),
    });
    fireEvent.mouseUp(window);
    flushFrames();
    expect(onUpdateAxis).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('mouseup flushes the pending frame and cancels it', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 100, buttons: 1 });
    expect(onUpdateAxis).not.toHaveBeenCalled();
    fireEvent.mouseUp(window);
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).toHaveBeenCalledWith('ax1', {
      autoScale: false,
      min: expect.closeTo(UP_100.min, 6),
      max: expect.closeTo(UP_100.max, 6),
    });
    expect(frames.size).toBe(0);
    flushFrames();
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('never writes a factor-1 frame', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    // Past the threshold, then back to the start before the frame runs.
    fireEvent.mouseMove(window, { clientX: 30, clientY: 150, buttons: 1 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 200, buttons: 1 });
    flushFrames();
    fireEvent.mouseUp(window);
    flushFrames();
    expect(onUpdateAxis).not.toHaveBeenCalled();
    unmount();
  });

  it('stops committing after mouseup', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 230, buttons: 1 });
    flushFrames();
    const calls = onUpdateAxis.mock.calls.length;
    expect(calls).toBe(1);
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 30, clientY: 300, buttons: 1 });
    flushFrames();
    expect(onUpdateAxis.mock.calls.length).toBe(calls);
    unmount();
  });

  it('ends the drag when the button is released off-window (no mouseup seen)', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 230, buttons: 1 });
    flushFrames();
    const calls = onUpdateAxis.mock.calls.length;
    // No mouseup reaches us (released over browser chrome/devtools); the next
    // move reports no buttons held, which must end the drag rather than keep
    // stretching on every subsequent move.
    fireEvent.mouseMove(window, { clientX: 30, clientY: 260, buttons: 0 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 300, buttons: 0 });
    flushFrames();
    expect(onUpdateAxis.mock.calls.length).toBe(calls);
    unmount();
  });

  it('ignores mousedown inside the plot grid and outside the vertical band', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    // Grid interior: the whole-plot X pan/zoom owns this.
    fireEvent.mouseDown(wrap, { clientX: 400, clientY: 200, button: 0 });
    // Left margin but above the grid band.
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 20, button: 0 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 100, buttons: 1 });
    flushFrames();
    expect(onUpdateAxis).not.toHaveBeenCalled();
    unmount();
  });

  it('cancels a pending stretch frame on unmount', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 100, buttons: 1 });
    unmount();
    flushFrames();
    expect(onUpdateAxis).not.toHaveBeenCalled();
  });
});

describe('per-axis wheel zoom', () => {
  beforeEach(() => vi.clearAllMocks());

  it('zooms in about the value under the cursor and cancels page scroll', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    // y=190 -> anchor value 50; deltaY < 0 zooms in by 1/1.1.
    const notPrevented = fireEvent.wheel(wrap, { clientX: 30, clientY: 190, deltaY: -100 });
    expect(notPrevented).toBe(false); // preventDefault was called
    // Auto-scaled axis freezes first, then the zoom commit lands.
    expect(onUpdateAxis).toHaveBeenNthCalledWith(1, 'ax1', { autoScale: false, min: 0, max: 100 });
    expect(onUpdateAxis).toHaveBeenLastCalledWith('ax1', {
      min: expect.closeTo(50 - 50 / 1.1, 6),
      max: expect.closeTo(50 + 50 / 1.1, 6),
    });
    unmount();
  });

  it('a wheel over the plot area zooms the Y axis too, about the value under the cursor', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    const notPrevented = fireEvent.wheel(wrap, { clientX: 400, clientY: 200, deltaY: -100 });
    expect(notPrevented).toBe(false);
    // y 200 is the value 140/300 of [0, 100]; the auto axis freezes with this one write.
    const anchor = (140 / 300) * 100;
    const f = wheelFactor(-100);
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).toHaveBeenCalledWith('ax1', {
      autoScale: false,
      min: expect.closeTo(anchor - anchor * f, 6),
      max: expect.closeTo(anchor + (100 - anchor) * f, 6),
    });
    unmount();
  });

  it('ignores a horizontal-only scroll over an axis (deltaY 0)', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    // Shift+wheel / sideways trackpad: deltaX only. Must neither zoom the axis
    // nor swallow the scroll via preventDefault.
    const notPrevented = fireEvent.wheel(wrap, {
      clientX: 30,
      clientY: 190,
      deltaX: -100,
      deltaY: 0,
    });
    expect(notPrevented).toBe(true); // preventDefault NOT called
    expect(onUpdateAxis).not.toHaveBeenCalled();
    unmount();
  });
});
