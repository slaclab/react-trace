// @vitest-environment jsdom
//
// C7: Trace's data tooltip follows the cursor, as on main; docking it in a
// corner of the plot is a Display setting (Dock data tooltip, `dockReadout`),
// off by default and written to links and files only when on. A pinned
// tooltip without the dock sits at the plot's top-right. A site that docks
// it opens new plots with the setting on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SinglePlot } from './PlotArea';
import type { Plot } from '../types';
import { chartStub } from '../test/chartStub';
import { READOUT_CLASS } from '../plot/readoutDock';
import { plotConfigOf } from '../embed/plotConfig';
import { serializeTraceQuery } from '../embed/query';
import { deserializeWorkspace, serializeWorkspace } from '../io/serialize';
import { initialTracePlots, newSitePlot } from '../tools/trace/defaults';
import { resetSiteDefaults } from '../site/store';
import { setSiteConfig } from '../site/testing';

const h = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);
chartStub.onRender = (props) => {
  h.options.push(props.option as Record<string, unknown>);
};

const tooltip = () =>
  (h.options[h.options.length - 1] as { tooltip: Record<string, unknown> }).tooltip;

function makePlot(over: Partial<Plot> = {}): Plot {
  return {
    ...initialTracePlots('?pv=A')[0],
    traces: [],
    ...over,
  };
}

function renderPlot(plot: Plot) {
  return render(
    <SinglePlot
      plot={plot}
      endMs={0}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
    />
  );
}

beforeEach(() => {
  h.options.length = 0;
});

afterEach(() => {
  cleanup();
  resetSiteDefaults();
});

describe('the data tooltip', () => {
  it('follows the cursor by default: no dock, no fixed position', () => {
    renderPlot(makePlot());
    expect(tooltip().className).toBeUndefined();
    expect(tooltip().position).toBeUndefined();
  });

  it('sits at the top-right when pinned without the dock', () => {
    renderPlot(makePlot({ pinDataWindow: true }));
    expect(tooltip().className).toBeUndefined();
    expect(typeof tooltip().position).toBe('function');
  });

  it('docks in a corner with Dock data tooltip on', () => {
    renderPlot(makePlot({ dockReadout: true }));
    expect(tooltip().className).toBe(READOUT_CLASS);
    expect(typeof tooltip().position).toBe('function');
  });
});

describe('the Dock data tooltip setting', () => {
  it('is off in a new plot, and on at a site that docks the read-out', () => {
    expect(newSitePlot('p', 0).dockReadout).toBeUndefined();
    setSiteConfig({ trace: { plot: { tooltip: 'docked' } } });
    expect(newSitePlot('p', 0).dockReadout).toBe(true);
    expect(initialTracePlots('?pv=A')[0].dockReadout).toBe(true);
  });

  it('is written to a link only when on, and reads back', () => {
    const off = makePlot();
    expect(plotConfigOf(off)).toBeUndefined();
    const on = makePlot({ dockReadout: true });
    expect(plotConfigOf(on)).toEqual({ v: 1, dockReadout: true });
    const query = `?${serializeTraceQuery(on.traces, on.xAxis, plotConfigOf(on))}`;
    expect(initialTracePlots(query)[0].dockReadout).toBe(true);
    expect(initialTracePlots('?pv=A&plot=%7B%22v%22%3A1%7D')[0].dockReadout).toBeUndefined();
  });

  it('round-trips through a .trc.json file; a file without it follows the cursor', () => {
    const plots = [makePlot({ id: 'a', dockReadout: true }), makePlot({ id: 'b' })];
    const read = deserializeWorkspace(serializeWorkspace({ theme: 'dark', plots })).plots;
    expect(read.map((p) => p.dockReadout)).toEqual([true, undefined]);
  });
});
