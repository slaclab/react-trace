// @vitest-environment jsdom
//
// An embedded Trace tile saves only its first plot. The status line of every
// other plot says "Drawings on this plot are not saved in the tile", in the
// tab view and the grid view; the first plot's, and any plot's outside a
// tile, says nothing of the kind.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PlotArea } from './PlotArea';
import type { Plot } from '../types';
import { EMBEDDED_UNSAVED_HINT } from '../annotations/statusHints';
import { chartStub } from '../test/chartStub';

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

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);
chartStub.instance = fakeInstance;

function makePlot(id: string): Plot {
  return {
    id,
    title: id,
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
    xAxis: { timeRange: '-1h' },
  };
}

const PLOTS = [makePlot('p1'), makePlot('p2')];

function mount(viewMode: 'tabs' | 'grid', activePlotId = 'p1') {
  const { container } = render(
    <PlotArea
      plots={PLOTS}
      activePlotId={activePlotId}
      viewMode={viewMode}
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
      axisEndFor={() => 0}
    />
  );
  return container;
}

/** Each mounted plot's embedded notice, by plot id. */
function notices(container: HTMLElement): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const plot of container.querySelectorAll<HTMLElement>('[data-plot-id]')) {
    const line = plot.parentElement?.querySelector('[data-status-embedded-hint]');
    out[plot.getAttribute('data-plot-id')!] = line?.textContent ?? null;
  }
  return out;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/?embedded=true');
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('the embedded notice', () => {
  it('marks every plot but the first, in the grid view', () => {
    expect(notices(mount('grid'))).toEqual({ p1: null, p2: EMBEDDED_UNSAVED_HINT });
  });

  it('marks the second plot in the tab view, not the first', () => {
    expect(notices(mount('tabs', 'p2'))).toEqual({ p2: EMBEDDED_UNSAVED_HINT });
    cleanup();
    expect(notices(mount('tabs', 'p1'))).toEqual({ p1: null });
  });

  it('says nothing outside a tile', () => {
    window.history.replaceState(null, '', '/');
    expect(notices(mount('grid'))).toEqual({ p1: null, p2: null });
  });
});
