// What a new Trace plot or curve opens with, from a site's creation defaults
// (src/site): pure, so the link reader (embed/initialPlots.ts) applies them to
// a fresh link without reading the site store. Fields stored only off their
// wire baseline (the drag mode, the drawing rail) are stored the same way, so
// a value at the baseline stays absent and one off it is explicit.
import type { TraceCurveDefaults, TracePlotDefaults } from '../../site/types';
import type { Plot, PVTrace } from '../../types';
import { TRACE_DEFAULT_DRAG } from './plotView';

/** A site's creation defaults for Trace: a new plot's and a new curve's. */
export interface TraceCreation {
  plot: TracePlotDefaults;
  trace: TraceCurveDefaults;
}

/**
 * `plot` with the plot-level creation defaults; the palette is the caller's
 * (a user's own pick wins over the site's). `timeRange`: also take the
 * site's time range (a new plot; a fresh link without `range`).
 */
export function withPlotCreation<P extends Plot>(
  plot: P,
  d: TracePlotDefaults,
  opts: { timeRange: boolean }
): P {
  const out: P = {
    ...plot,
    showCrosshair: d.showCrosshair,
    showLegend: d.showLegend,
    showXGridlines: d.showXGridlines,
    showYGridlines: d.showYGridlines,
    gridStyle: d.gridStyle,
    gridOpacity: d.gridOpacity,
    tickFontSize: d.tickFontSize,
    refreshIntervalS: d.refreshIntervalS,
  };
  if (d.dragMode === TRACE_DEFAULT_DRAG) delete out.dragMode;
  else out.dragMode = d.dragMode;
  if (d.showDrawingTools) delete out.showDrawingTools;
  else out.showDrawingTools = false;
  if (d.archiver !== undefined) out.archiver = d.archiver;
  if (opts.timeRange) out.xAxis = { timeRange: d.timeRange };
  return out;
}

/** `trace` with the curve creation defaults; a formula keeps its line type (direct). */
export function withCurveCreation<T extends PVTrace>(trace: T, d: TraceCurveDefaults): T {
  return trace.kind === 'formula'
    ? { ...trace, lineWidth: d.lineWidth, showSymbol: d.showSymbol }
    : { ...trace, lineWidth: d.lineWidth, lineType: d.lineType, showSymbol: d.showSymbol };
}
