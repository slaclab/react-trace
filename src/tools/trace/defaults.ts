// Trace's creation paths, bound to this page load's site defaults (src/site):
// Add plot, a fresh tab, and every new curve open with them. Read at call
// time, never cached, so the loader's record is the one used.
//
// The link writers go through `linkPlotConfig`: a plot whose settings are
// all at the wire baseline writes no `plot=` key, and a link without one
// opens as a new plot, with the site defaults of wherever it is opened. While
// this site's new plots differ from the baseline, such a plot's link carries
// an empty `plot={"v":1}` instead, so it reopens at the baseline, as it is.
import { buildInitialPlots } from '../../embed/initialPlots';
import {
  newFormula,
  newPlot,
  newTrace,
  plotConfigOf,
  PLOT_CONFIG_VERSION,
  type PlotConfig,
  type PlotConfigSource,
} from '../../embed/plotConfig';
import { DEFAULT_PALETTE_ID, getPalette, withPalette } from '../../palettes';
import { siteDefaults } from '../../site/store';
import { readLegacyPaletteId } from '../../state/paletteStore';
import type { Plot, PVTrace } from '../../types';
import { withCurveCreation, withPlotCreation, type TraceCreation } from './creation';

/** This page load's creation defaults for Trace. */
export function traceCreation(): TraceCreation {
  const { plot, trace } = siteDefaults().trace;
  return { plot, trace };
}

/**
 * The palette a new plot and a fresh tab open in: the user's own last pick
 * (`rememberPaletteId`), else the site's; undefined is the default palette.
 */
export function newPlotPaletteId(): string | undefined {
  return readLegacyPaletteId() ?? siteDefaults().trace.plot.palette;
}

/** The plots a page with query `search` opens with (a fresh one: the site defaults). */
export function initialTracePlots(search: string): Plot[] {
  return buildInitialPlots(
    search,
    getPalette(newPlotPaletteId() ?? DEFAULT_PALETTE_ID),
    traceCreation()
  );
}

/** A new plot at `index` (Add plot): no curves, the site defaults. */
export function newSitePlot(id: string, index: number): Plot {
  const plot = withPlotCreation(newPlot(id, index), traceCreation().plot, { timeRange: true });
  return withPalette(plot, newPlotPaletteId());
}

/** A new PV curve with the site's curve defaults. */
export function newSiteTrace(...args: Parameters<typeof newTrace>): PVTrace {
  return withCurveCreation(newTrace(...args), traceCreation().trace);
}

/** A new formula curve with the site's line width and symbols. */
export function newSiteFormula(...args: Parameters<typeof newFormula>): PVTrace {
  return withCurveCreation(newFormula(...args), traceCreation().trace);
}

// Whether a link without `plot=` opens here exactly as the baseline does;
// memoized per creation record (one per page load).
const freshIsBaseline = new WeakMap<
  TraceCreation['plot'],
  { trace: TraceCreation['trace']; baseline: boolean }
>();

function freshLinkIsBaseline(creation: TraceCreation): boolean {
  const known = freshIsBaseline.get(creation.plot);
  if (known !== undefined && known.trace === creation.trace) return known.baseline;
  const palette = getPalette(creation.plot.palette ?? DEFAULT_PALETTE_ID);
  const [probe] = buildInitialPlots('?pv=PROBE&range=-1h', palette, creation);
  const baseline = plotConfigOf(probe) === undefined;
  freshIsBaseline.set(creation.plot, { trace: creation.trace, baseline });
  return baseline;
}

/**
 * The `plot=` config a link to `plot` carries: `plotConfigOf`'s, or, when
 * that is empty but a link without one would open with this site's defaults
 * instead of the baseline, the empty config.
 */
export function linkPlotConfig(
  plot: PlotConfigSource,
  creation: TraceCreation = traceCreation()
): PlotConfig | undefined {
  const config = plotConfigOf(plot);
  if (config !== undefined || freshLinkIsBaseline(creation)) return config;
  return { v: PLOT_CONFIG_VERSION };
}
