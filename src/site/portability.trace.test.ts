// @vitest-environment jsdom
//
// Trace's links and files stay portable under any site defaults. A plot
// created at a site, encoded as a link (`plot=`) and as a `.trc.json`, opens
// the same with no site defaults and at another site. A link that carries no
// plot settings (PVs and a range only) is a new plot wherever it opens, with
// that site's defaults. A plot back at the baseline while its site's new
// plots are not still reopens at the baseline, through the empty `plot=`.
import { afterEach, describe, expect, it } from 'vitest';
import { serializeTraceQuery } from '../embed/query';
import { traceQueryFor } from '../tools/contextMenu';
import { deserializeWorkspace, serializeWorkspace } from '../io/serialize';
import {
  initialTracePlots,
  linkPlotConfig,
  newSitePlot,
  newSiteTrace,
} from '../tools/trace/defaults';
import { colorForIndex, paletteOf } from '../palettes';
import type { Plot } from '../types';
import { resetSiteDefaults } from './store';
import { setSiteConfig } from './testing';

/** Every key a site can set for a new plot or curve, off its baseline. */
const EVERY_KEY = {
  trace: {
    plot: {
      showCrosshair: false,
      dragMode: 'pan',
      showLegend: false,
      showXGridlines: false,
      showYGridlines: false,
      gridStyle: 'dotted',
      gridOpacity: 0.4,
      tickFontSize: 14,
      refreshIntervalS: 10,
      palette: 'viridis',
      timeRange: '-30m',
      archiver: 'arch-b',
      showDrawingTools: false,
    },
    trace: { lineWidth: 3, lineType: 'direct', showSymbol: true },
  },
};
const ONE_KEY = { trace: { plot: { showCrosshair: false } } };
const OTHER_SITE = {
  trace: {
    plot: { showLegend: false, dragMode: 'pan', tickFontSize: 9, palette: 'rainbow' },
    trace: { lineWidth: 5, showSymbol: true },
  },
};

const SITES: [string, unknown][] = [
  ['the built-ins', undefined],
  ['one key set', ONE_KEY],
  ['every key set', EVERY_KEY],
];
const READERS: [string, unknown][] = [
  ['no site defaults', undefined],
  ['another site', OTHER_SITE],
];

function atSite(config: unknown): void {
  resetSiteDefaults();
  if (config !== undefined) setSiteConfig(config);
}

/** What a link or file says about a plot: its settings and its curves' looks. */
function settingsOf(plot: Plot) {
  return {
    showCrosshair: plot.showCrosshair,
    dragMode: plot.dragMode ?? 'zoom',
    showLegend: plot.showLegend,
    showXGridlines: plot.showXGridlines,
    showYGridlines: plot.showYGridlines,
    gridStyle: plot.gridStyle,
    gridOpacity: plot.gridOpacity,
    tickFontSize: plot.tickFontSize,
    refreshIntervalS: plot.refreshIntervalS,
    palette: plot.palette,
    archiver: plot.archiver,
    showDrawingTools: plot.showDrawingTools !== false,
    xAxis: plot.xAxis,
    traces: plot.traces.map((t) => ({
      pvName: t.pvName,
      color: t.color,
      lineWidth: t.lineWidth,
      lineType: t.lineType,
      showSymbol: t.showSymbol,
    })),
  };
}

/** The plots a site creates: a fresh link's, and an added plot with two curves. */
function createdPlots(): Plot[] {
  const [fresh] = initialTracePlots('?pv=A&pv=B&range=-1h');
  const added = newSitePlot('plot-2', 1);
  const palette = paletteOf(added);
  added.traces = ['C', 'D'].map((pv, i) =>
    newSiteTrace(`t${i}`, pv, added.axes[0].id, colorForIndex(palette, i), [])
  );
  return [fresh, added];
}

const link = (plot: Plot) =>
  `?${serializeTraceQuery(plot.traces, plot.xAxis, linkPlotConfig(plot))}`;

afterEach(() => {
  resetSiteDefaults();
  window.localStorage.clear();
});

describe.each(SITES)('a plot created with %s', (_site, config) => {
  it('opens the same from its link with no site defaults', () => {
    atSite(config);
    const plots = createdPlots();
    const links = plots.map(link);
    atSite(undefined);
    links.forEach((query, i) => {
      expect(settingsOf(initialTracePlots(query)[0])).toEqual(settingsOf(plots[i]));
    });
  });

  it.each(READERS)('opens the same from its file with %s', (_reader, readerConfig) => {
    atSite(config);
    const plots = createdPlots();
    const file = serializeWorkspace({ theme: 'dark', plots });
    atSite(readerConfig);
    const read = deserializeWorkspace(file).plots;
    expect(read.map(settingsOf)).toEqual(plots.map(settingsOf));
  });

  it('reopens from its link at its own site after every setting went back to the baseline', () => {
    atSite(config);
    const [fresh] = initialTracePlots('?pv=A&range=-1h');
    atSite(undefined);
    const [baseline] = initialTracePlots('?pv=A&range=-1h');
    const back = { ...fresh, ...settingsAt(baseline) };
    atSite(config);
    expect(settingsOf(initialTracePlots(link(back))[0])).toEqual(settingsOf(baseline));
  });
});

describe.each(SITES.slice(1))('a plot created with %s', (_site, config) => {
  it('carries its settings in its link, so it opens the same at another site', () => {
    atSite(config);
    const plots = createdPlots();
    const links = plots.map(link);
    for (const query of links) expect(query).toContain('plot=');
    atSite(OTHER_SITE);
    links.forEach((query, i) => {
      expect(settingsOf(initialTracePlots(query)[0])).toEqual(settingsOf(plots[i]));
    });
  });
});

/** The plot-level settings of `plot`, as a patch (its curves included). */
function settingsAt(plot: Plot): Partial<Plot> {
  const { id: _id, axes: _axes, title: _title, ...rest } = plot;
  void _id;
  void _axes;
  void _title;
  return {
    ...rest,
    dragMode: plot.dragMode,
    showDrawingTools: plot.showDrawingTools,
    palette: plot.palette,
    archiver: plot.archiver,
  };
}

describe('a link with PVs and no plot settings', () => {
  it('opens as a new plot, with the defaults of the site that opens it', () => {
    const query = '?pv=A&range=-2h';
    atSite(undefined);
    const [baseline] = initialTracePlots(query);
    expect(link(baseline)).toBe(query);
    atSite(EVERY_KEY);
    const [here] = initialTracePlots(query);
    expect(settingsOf(here)).toMatchObject({
      showCrosshair: false,
      dragMode: 'pan',
      palette: 'viridis',
      archiver: 'arch-b',
      showDrawingTools: false,
      xAxis: { timeRange: '-2h' },
      traces: [{ pvName: 'A', lineWidth: 3, lineType: 'direct', showSymbol: true }],
    });
    // Without a range, the site's time range.
    expect(initialTracePlots('?pv=A')[0].xAxis).toEqual({ timeRange: '-30m' });
  });
});

describe('another tool’s Open in Trace', () => {
  it('opens a new plot with the site’s defaults and the range it carries', () => {
    atSite(EVERY_KEY);
    const [plot] = initialTracePlots(`?${traceQueryFor('A', '-2h')}`);
    expect(settingsOf(plot)).toMatchObject({
      showCrosshair: false,
      dragMode: 'pan',
      xAxis: { timeRange: '-2h' },
      traces: [{ pvName: 'A', lineWidth: 3, lineType: 'direct', showSymbol: true }],
    });
  });
});
