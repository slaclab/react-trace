// @vitest-environment jsdom
//
// Mounts SinglePlot with a mocked echarts-for-react and drives REAL DOM mouse
// events through the wrapper div. This pins the wiring that broke the first
// version of issue 45: listeners must live on the wrapper (not a zrender
// instance that echarts-for-react disposes right after mount) and resolve the
// chart lazily, and a downward drag must RAISE min/max so curves follow the
// cursor.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
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
      nowMs={0}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
      onUpdateAxis={onUpdateAxis}
    />
  );
  const wrap = container.querySelector('[data-plot-id="p1"]')!;
  return { wrap, onUpdateAxis, unmount };
}

// jsdom reports a 0,0 bounding rect for the wrapper, so clientX/clientY ARE
// canvas-pixel coordinates here.
describe('per-axis drag pan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('freezes an auto-scaled axis to its extent on mousedown over the axis band', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).toHaveBeenCalledWith('ax1', { autoScale: false, min: 0, max: 100 });
    unmount();
  });

  it('dragging DOWN commits a RAISED window so curves follow the cursor', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    // +30px of the 300px span = +10 data units on window listeners (the drag
    // must keep tracking outside the wrapper). buttons:1 = button still held.
    fireEvent.mouseMove(window, { clientX: 30, clientY: 230, buttons: 1 });
    expect(onUpdateAxis).toHaveBeenLastCalledWith('ax1', {
      min: expect.closeTo(10, 6),
      max: expect.closeTo(110, 6),
    });
    unmount();
  });

  it('stops committing after mouseup', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 230, buttons: 1 });
    const calls = onUpdateAxis.mock.calls.length;
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 30, clientY: 300, buttons: 1 });
    expect(onUpdateAxis.mock.calls.length).toBe(calls);
    unmount();
  });

  it('ends the drag when the button is released off-window (no mouseup seen)', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 230, buttons: 1 });
    const calls = onUpdateAxis.mock.calls.length;
    // No mouseup reaches us (released over browser chrome/devtools); the next
    // move reports no buttons held, which must end the drag rather than keep
    // panning on every subsequent move.
    fireEvent.mouseMove(window, { clientX: 30, clientY: 260, buttons: 0 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 300, buttons: 0 });
    expect(onUpdateAxis.mock.calls.length).toBe(calls);
    unmount();
  });

  it('ignores mousedown inside the plot grid and outside the vertical band', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    // Grid interior: the whole-plot X pan/zoom owns this.
    fireEvent.mouseDown(wrap, { clientX: 400, clientY: 200, button: 0 });
    // Left margin but above the grid band.
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 20, button: 0 });
    expect(onUpdateAxis).not.toHaveBeenCalled();
    unmount();
  });

  it('does not freeze a manually-ranged axis again on mousedown', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(
      makePlot({ autoScale: false, min: 0, max: 100 })
    );
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    expect(onUpdateAxis).not.toHaveBeenCalled(); // snapshot only; commits start on move
    fireEvent.mouseMove(window, { clientX: 30, clientY: 170, buttons: 1 });
    expect(onUpdateAxis).toHaveBeenLastCalledWith('ax1', {
      min: expect.closeTo(-10, 6),
      max: expect.closeTo(90, 6),
    });
    unmount();
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

  it('leaves wheel events over the plot grid alone', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    const notPrevented = fireEvent.wheel(wrap, { clientX: 400, clientY: 200, deltaY: -100 });
    expect(notPrevented).toBe(true);
    expect(onUpdateAxis).not.toHaveBeenCalled();
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
