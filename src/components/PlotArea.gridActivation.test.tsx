// @vitest-environment jsdom
//
// In grid view a pointer-down anywhere in a cell makes that plot active
// without stopping the event, so the per-axis drag pan, zoom and the cell
// buttons keep working; the active cell carries the accent-outline modifier.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { PlotArea } from './PlotArea';
import type { Plot } from '../types';

// Same fake chart geometry as PlotArea.axisInteractions.test.tsx: the left
// y-axis band spans pixels 340 (value 0) to 40 (value 100).
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
    getOption: () => ({}),
    setOption: () => {},
    dispatchAction: () => {},
    on: () => {},
    off: () => {},
    resize: () => {},
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

function makePlot(id: string): Plot {
  return {
    id,
    title: `Plot ${id}`,
    traces: [],
    axes: [
      {
        id: 'ax1',
        name: 'Y',
        orientation: 'left',
        autoScale: true,
        logScale: false,
        visible: true,
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

function mountArea(viewMode: 'tabs' | 'grid', activePlotId = 'p1') {
  const onSetActivePlot = vi.fn();
  const onUpdateAxis = vi.fn();
  const onPopOutPlot = vi.fn();
  const plots = [makePlot('p1'), makePlot('p2')];
  const utils = render(
    <PlotArea
      plots={plots}
      activePlotId={activePlotId}
      viewMode={viewMode}
      archiveResultsByPlot={new Map()}
      liveResultsByPlot={new Map()}
      formulaResultsByPlot={new Map()}
      onSetActivePlot={onSetActivePlot}
      onAddPlot={vi.fn()}
      onRemovePlot={vi.fn()}
      onSetViewMode={vi.fn()}
      onPopOutPlot={onPopOutPlot}
      detachedPlotIds={[]}
      onDetachPlot={vi.fn()}
      onReattachPlot={vi.fn()}
      displayWindowByPlotId={new Map()}
      onUpdateAxis={onUpdateAxis}
    />
  );
  return { ...utils, onSetActivePlot, onUpdateAxis, onPopOutPlot };
}

describe('grid cell activation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pointer-down on the second cell chart makes it active and the axis drag still stretches', () => {
    // The stretch is coalesced to animation frames: run them by hand.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { container, onSetActivePlot, onUpdateAxis, unmount } = mountArea('grid');
    const wrap = container.querySelector('[data-plot-id="p2"]')!;
    expect(wrap).not.toBeNull();

    // The event must not be stopped: a document listener still sees it.
    const seen = vi.fn();
    document.addEventListener('pointerdown', seen);
    fireEvent.pointerDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    document.removeEventListener('pointerdown', seen);
    expect(onSetActivePlot).toHaveBeenCalledWith('p2');
    expect(seen).toHaveBeenCalledTimes(1);

    // The axis drag in that same cell keeps working: dragging the Y band down
    // 30 px stretches [0, 100] about its centre by 2^(30/200), freezing
    // the auto-scaled axis in the same write.
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 230, buttons: 1 });
    act(() => frames.splice(0).forEach((cb) => cb(performance.now())));
    const half = 50 * 2 ** (30 / 200);
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).toHaveBeenCalledWith('p2', 'ax1', {
      autoScale: false,
      min: expect.closeTo(50 - half, 6),
      max: expect.closeTo(50 + half, 6),
    });
    fireEvent.mouseUp(window);
    unmount();
    vi.unstubAllGlobals();
  });

  it('cell buttons still act after the activating pointer-down', () => {
    const { container, onSetActivePlot, onPopOutPlot, unmount } = mountArea('grid');
    const cells = container.querySelectorAll('.plot-grid__cell');
    const btn = cells[1].querySelector('.plot-grid__cell-btn--maximize')!;
    fireEvent.pointerDown(btn, { button: 0 });
    fireEvent.click(btn);
    expect(onSetActivePlot).toHaveBeenCalledWith('p2');
    expect(onPopOutPlot).toHaveBeenCalledWith('p2');
    unmount();
  });

  it('puts the active outline class on the active cell only', () => {
    const { container, unmount } = mountArea('grid', 'p1');
    let cells = container.querySelectorAll('.plot-grid__cell');
    expect(cells).toHaveLength(2);
    expect(cells[0].classList.contains('plot-grid__cell--active')).toBe(true);
    expect(cells[1].classList.contains('plot-grid__cell--active')).toBe(false);
    expect(container.querySelectorAll('.plot-grid__cell--active')).toHaveLength(1);
    unmount();

    const second = mountArea('grid', 'p2');
    cells = second.container.querySelectorAll('.plot-grid__cell');
    expect(cells[0].classList.contains('plot-grid__cell--active')).toBe(false);
    expect(cells[1].classList.contains('plot-grid__cell--active')).toBe(true);
    second.unmount();
  });

  it('tab view keeps its plot tabs and has no grid cells', () => {
    const { container, onSetActivePlot, unmount } = mountArea('tabs');
    expect(container.querySelectorAll('.plot-grid__cell')).toHaveLength(0);
    const tabs = container.querySelectorAll('.plot-tab');
    expect(tabs.length).toBe(2);
    fireEvent.click(tabs[1]);
    expect(onSetActivePlot).toHaveBeenCalledWith('p2');
    unmount();
  });
});
