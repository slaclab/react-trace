// @vitest-environment jsdom
//
// Trace's drag mode (the strip's Zoom box / Pan toggle): a
// left-drag draws a box by default (as with `dragMode: 'zoom'`) and the
// release zooms the time window and every Y axis to it; with `dragMode:
// 'pan'` the same drag pans. A double-click in the plot area brings both back
// (All, auto-scale).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SinglePlot } from './PlotArea';
import type { Axis, Plot } from '../types';
import { msToNs, nsToMs, type TimeWindowNs } from '../api/time';
import { fireMouse } from '../plot/testUtils';

// 800x400 canvas, grid x 70..780 (710 px), y 40..340 (300 px); every Y axis
// maps [0, 100] up the grid.
const { fakeInstance } = vi.hoisted(() => {
  const fakeInstance = {
    getWidth: () => 800,
    getHeight: () => 400,
    isDisposed: () => false,
    getZr: () => ({ setCursorStyle: () => {} }),
    getModel: () => ({
      getComponent: () => ({ axis: { scale: { getExtent: (): [number, number] => [0, 100] } } }),
    }),
    convertToPixel: (_f: unknown, v: number) => 340 - (v / 100) * 300,
    convertFromPixel: (_f: unknown, px: number) => ((340 - px) / 300) * 100,
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

const FROM_MS = 1_000_000;
const TO_MS = FROM_MS + 710 * 1000; // 1 px = 1 s
const WINDOW: TimeWindowNs = { fromNs: msToNs(FROM_MS), toNs: msToNs(TO_MS) };

const axis: Axis = {
  id: 'ax1',
  name: 'ax1',
  orientation: 'left',
  autoScale: true,
  logScale: false,
  visible: true,
};

function makePlot(over: Partial<Plot> = {}): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [],
    axes: [axis],
    backgroundColor: 'default',
    showLegend: false,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '1h' },
    ...over,
  };
}

let frames: FrameRequestCallback[];
beforeEach(() => {
  frames = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function mount(plot: Plot) {
  const onUpdateAxis = vi.fn();
  const onViewWindowChange = vi.fn();
  const onApplyXAxis = vi.fn();
  const { container, unmount } = render(
    <SinglePlot
      plot={plot}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
      onUpdateAxis={onUpdateAxis}
      viewWindowNs={WINDOW}
      onViewWindowChange={onViewWindowChange}
      onApplyXAxis={onApplyXAxis}
    />
  );
  const wrap = container.querySelector('[data-plot-id="p1"]')!;
  return { wrap, onUpdateAxis, onViewWindowChange, onApplyXAxis, unmount };
}

function drag(wrap: Element, from: [number, number], to: [number, number]) {
  fireMouse(wrap, 'mousedown', { x: from[0], y: from[1] });
  fireMouse(window, 'mousemove', { x: to[0], y: to[1] });
  fireMouse(window, 'mouseup', { x: to[0], y: to[1] });
  frames.splice(0).forEach((cb) => cb(0));
}

describe('Trace drag mode', () => {
  it('pan mode: the window follows the drag, no box', () => {
    const p = mount(makePlot({ dragMode: 'pan' }));
    drag(p.wrap, [200, 100], [300, 100]);
    expect(p.onViewWindowChange).toHaveBeenCalledTimes(1);
    const w = p.onViewWindowChange.mock.calls[0][0] as TimeWindowNs;
    expect(nsToMs(w.fromNs)).toBeCloseTo(FROM_MS - 100_000, -1);
    expect(p.onUpdateAxis).not.toHaveBeenCalled();
    p.unmount();
  });

  it.each([
    ['by default', {}],
    ['with a stored zoom', { dragMode: 'zoom' as const }],
  ])('zooms %s: the box zooms the window and the Y axis to it', (_name, over) => {
    const p = mount(makePlot(over));
    // x 170..370 is 100 s..300 s into the window; y 100..250 is 80..30.
    drag(p.wrap, [170, 100], [370, 250]);
    expect(p.wrap.querySelector('[data-zoom-box]')).toBeNull();
    expect(p.onViewWindowChange).toHaveBeenCalledTimes(1);
    const w = p.onViewWindowChange.mock.calls[0][0] as TimeWindowNs;
    expect(nsToMs(w.fromNs)).toBeCloseTo(FROM_MS + 100_000, -1);
    expect(nsToMs(w.toNs)).toBeCloseTo(FROM_MS + 300_000, -1);
    expect(p.onUpdateAxis).toHaveBeenCalledWith('ax1', {
      autoScale: false,
      min: expect.closeTo(30, 6),
      max: expect.closeTo(80, 6),
    });
    p.unmount();
  });

  it('a double-click in the plot area returns a manual Y to auto-scale', () => {
    const p = mount(makePlot({ axes: [{ ...axis, autoScale: false, min: 10, max: 20 }] }));
    fireMouse(p.wrap, 'dblclick', { x: 400, y: 200 });
    expect(p.onUpdateAxis).toHaveBeenCalledWith('ax1', { autoScale: true });
    p.unmount();
  });
});
