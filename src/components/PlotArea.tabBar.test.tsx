// @vitest-environment jsdom
//
// Plot tabs stay reachable at narrow widths (audit R5). The stack put the
// range chips in the tab bar's controls group, which never shrank, so at
// 800 px they took the whole bar and the tab strip collapsed to 0 px. Now the
// tab strip and the range chips share the squeeze: both shrink in proportion
// to their content and scroll sideways; the view and Add plot buttons keep
// their size.
//
// jsdom has no layout, so this pins the flex rules that guarantee it rather
// than measured widths.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PlotArea } from './PlotArea';
import type { Plot } from '../types';
import { chartStub } from '../test/chartStub';

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);
chartStub.instance = undefined;

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

afterEach(() => cleanup());

function makePlot(id: string, title: string): Plot {
  return {
    id,
    title,
    traces: [],
    axes: [
      {
        id: `${id}-ax`,
        name: 'Y',
        orientation: 'left',
        autoScale: true,
        logScale: false,
        visible: true,
      },
    ],
    showLegend: false,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
  };
}

function mount() {
  return render(
    <PlotArea
      plots={[makePlot('p1', 'Plot 1'), makePlot('p2', 'Plot 2'), makePlot('p3', 'Plot 3')]}
      activePlotId="p1"
      viewMode="tabs"
      archiveResultsByPlot={new Map()}
      liveResultsByPlot={new Map()}
      formulaResultsByPlot={new Map()}
      onSetActivePlot={vi.fn()}
      onAddPlot={vi.fn()}
      onRemovePlot={vi.fn()}
      onSetViewMode={vi.fn()}
      onPopOutPlot={vi.fn()}
      detachedPlotIds={[]}
      onDetachPlot={vi.fn()}
      onReattachPlot={vi.fn()}
      displayWindowByPlotId={new Map()}
      onApplyXAxis={vi.fn()}
    />
  );
}

describe('the plot tab bar at narrow widths', () => {
  it('the tab strip sizes from its tabs, may shrink, and scrolls sideways', () => {
    const { container } = mount();
    const strip = container.querySelector<HTMLElement>('.plot-tab-bar__tabs')!;
    expect(strip.querySelectorAll('.plot-tab')).toHaveLength(3);
    expect(strip.style.flex).toBe('1 1 auto');
    expect(strip.style.minWidth).toBe('0px');
    expect(strip.style.overflowX).toBe('auto');
  });

  it('the range chips yield instead of taking the whole bar', () => {
    const { container } = mount();
    const controls = container.querySelector<HTMLElement>('.plot-tab-bar__controls')!;
    // The class sets flex-shrink: 0; the group must be allowed to shrink.
    expect(controls.style.flexShrink).toBe('1');
    expect(controls.style.minWidth).toBe('0px');
    const site = controls.querySelector<HTMLElement>('[data-range-site="tab"]')!;
    expect(site.querySelector('[data-range-controls]')).not.toBeNull();
    expect(site.style.flex).toBe('0 1 auto');
    expect(site.style.minWidth).toBe('0px');
    expect(site.style.overflowX).toBe('auto');
  });
});
