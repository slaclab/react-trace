// @vitest-environment jsdom
//
// Trace's creation paths read the site defaults: a new plot, a new curve or
// formula, a fresh tab and a fresh link (PVs or a range, no `plot=`). A link
// with `plot=` reads what it leaves out at the baseline. A plot whose
// settings are at the baseline while the site's new plots are not reports the
// empty config, so its link does not reopen with the site's values.
import { afterEach, describe, expect, it } from 'vitest';
import { PLOT_DEFAULTS, plotConfigOf, TRACE_DEFAULTS } from '../../embed/plotConfig';
import { colorForIndex, getPalette } from '../../palettes';
import { resetSiteDefaults } from '../../site/store';
import { setSiteConfig } from '../../site/testing';
import { LEGACY_PALETTE_KEY } from '../../state/paletteStore';
import {
  initialTracePlots,
  linkPlotConfig,
  newSiteFormula,
  newSitePlot,
  newSiteTrace,
  traceCreation,
} from './defaults';

const SITE = {
  trace: {
    plot: {
      showCrosshair: true,
      dragMode: 'pan',
      showLegend: false,
      gridStyle: 'dotted',
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

afterEach(() => {
  resetSiteDefaults();
  window.localStorage.clear();
});

describe('with the built-in defaults', () => {
  it('creates what the baseline tables say', () => {
    const plot = newSitePlot('p', 0);
    expect(plot).toMatchObject({ ...PLOT_DEFAULTS, xAxis: { timeRange: '-1h' } });
    expect(plot.dragMode).toBeUndefined();
    expect(plot.showDrawingTools).toBeUndefined();
    expect(plot.archiver).toBeUndefined();
    expect(plot.palette).toBeUndefined();
    expect(newSiteTrace('t', 'A', 'ax', '#123456', [])).toMatchObject(TRACE_DEFAULTS);
    expect(plotConfigOf(initialTracePlots('?pv=A&range=-1h')[0])).toBeUndefined();
  });

  it('writes no plot= for a plot at the baseline', () => {
    expect(linkPlotConfig(initialTracePlots('?pv=A')[0])).toBeUndefined();
  });
});

describe('with a site’s defaults', () => {
  it('opens Add plot with them, off-baseline fields stored explicitly', () => {
    setSiteConfig(SITE);
    const plot = newSitePlot('p', 1);
    expect(plot).toMatchObject({
      title: 'Plot 2',
      showCrosshair: true,
      dragMode: 'pan',
      showLegend: false,
      gridStyle: 'dotted',
      tickFontSize: 14,
      refreshIntervalS: 10,
      palette: 'viridis',
      archiver: 'arch-b',
      showDrawingTools: false,
      xAxis: { timeRange: '-30m' },
    });
  });

  it('opens a new plot in the user’s own palette over the site’s', () => {
    setSiteConfig(SITE);
    window.localStorage.setItem(LEGACY_PALETTE_KEY, 'rainbow');
    expect(newSitePlot('p', 0).palette).toBe('rainbow');
    expect(initialTracePlots('')[0].palette).toBe('rainbow');
  });

  it('gives a new curve the site’s look, and a formula its width and symbols', () => {
    setSiteConfig(SITE);
    expect(newSiteTrace('t', 'A', 'ax', '#123456', [])).toMatchObject({
      lineWidth: 3,
      lineType: 'direct',
      showSymbol: true,
    });
    setSiteConfig({ trace: { trace: { lineWidth: 4, lineType: 'direct', showSymbol: true } } });
    expect(newSiteFormula('f', 'ax', '#123456')).toMatchObject({
      kind: 'formula',
      lineWidth: 4,
      lineType: 'direct',
      showSymbol: true,
    });
    setSiteConfig({ trace: { trace: { lineType: 'step' } } });
    expect(newSiteFormula('f', 'ax', '#123456').lineType).toBe('direct');
  });

  it('opens a fresh tab and a fresh link with them; a link’s range wins', () => {
    setSiteConfig(SITE);
    const [tab] = initialTracePlots('');
    expect(tab).toMatchObject({ showCrosshair: true, xAxis: { timeRange: '-30m' } });
    const [link] = initialTracePlots('?pv=A&pv=B&range=-2h&embedded=true');
    expect(link).toMatchObject({
      showCrosshair: true,
      dragMode: 'pan',
      archiver: 'arch-b',
      palette: 'viridis',
      xAxis: { timeRange: '-2h' },
    });
    const viridis = getPalette('viridis');
    expect(link.traces.map((t) => [t.color, t.lineWidth, t.lineType, t.showSymbol])).toEqual([
      [colorForIndex(viridis, 0), 3, 'direct', true],
      [colorForIndex(viridis, 1), 3, 'direct', true],
    ]);
  });

  it('opens a link with plot= at the baseline for every key it leaves out', () => {
    setSiteConfig(SITE);
    const [plot] = initialTracePlots(
      '?pv=A&range=-1h&plot=%7B%22v%22%3A1%2C%22tickFontSize%22%3A20%7D'
    );
    expect(plot).toMatchObject({ ...PLOT_DEFAULTS, tickFontSize: 20 });
    expect(plot.dragMode).toBeUndefined();
    expect(plot.archiver).toBeUndefined();
    expect(plot.palette).toBeUndefined();
    expect(plot.traces[0]).toMatchObject(TRACE_DEFAULTS);
  });

  it('writes the empty plot= for a plot at the baseline, and nothing extra otherwise', () => {
    setSiteConfig({ trace: { plot: { showCrosshair: true } } });
    const [fresh] = initialTracePlots('?pv=A');
    expect(linkPlotConfig(fresh)).toEqual({ v: 1, showCrosshair: true });
    const atBaseline = { ...fresh, showCrosshair: false };
    expect(plotConfigOf(atBaseline)).toBeUndefined();
    expect(linkPlotConfig(atBaseline)).toEqual({ v: 1 });
    // A site palette or archiver makes a fresh link differ too.
    setSiteConfig({ trace: { plot: { palette: 'viridis' } } });
    expect(linkPlotConfig(initialTracePlots('?pv=A&plot=%7B%22v%22%3A1%7D')[0])).toEqual({ v: 1 });
    setSiteConfig({ trace: { plot: { archiver: 'arch-b' } } });
    expect(linkPlotConfig(initialTracePlots('?pv=A&plot=%7B%22v%22%3A1%7D')[0])).toEqual({ v: 1 });
  });

  it('reads the defaults at call time', () => {
    expect(traceCreation().plot.showCrosshair).toBe(false);
    setSiteConfig(SITE);
    expect(traceCreation().plot.showCrosshair).toBe(true);
  });
});
