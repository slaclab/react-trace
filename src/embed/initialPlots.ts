// The plots Trace opens with. A host page (the CANOPY workspace) names PVs and
// a time range in the URL query (see query.ts); Trace opens one plot whose
// traces show those PVs from the archive and live. A `plot` config in the
// query (plotConfig.ts) restores the axes, the traces' axes and looks, and the
// plot's display options. Without a query, or with no PVs, Trace opens one
// empty plot with one default axis.
//
// Live retention and background are automatic on open: no trace
// stamps `liveRetentionMs` (the live path derives one range's worth of
// samples, at most LIVE_RETENTION_MAX_MS, and never lowers it), and the plot
// stamps no `backgroundColor` (the theme's default).
//
// Opening palette: the one the `plot` config states; else, when the query
// has no `plot` key at all (a fresh tab), the caller's `freshPalette` (Trace
// passes the legacy per-user key's palette when it names a valid one); else
// the default. The traces take their colors from it before the config's own
// colors apply.
//
// The ids are fixed (`plot-1`, `y-axis-1`, `trace-N`) so the app's initial
// `activePlotId` and selection are valid without looking at the plots.

import type { Axis, Plot, PVTrace } from '../types';
import { nsToMs, relativeRangeMs, resolveTimeWindow } from '../api/time';
import {
  colorForIndex,
  getPalette,
  storedPaletteId,
  DEFAULT_PALETTE_ID,
  type Palette,
} from '../palettes';
import { PAGE_KEYS } from './pageKeys';
import { parseTraceQuery, type TraceQuery, type TraceQueryXAxis } from './query';
import { applyPlotConfig, axisDefaults, PLOT_DEFAULTS, TRACE_DEFAULTS } from './plotConfig';

export const INITIAL_PLOT_ID = 'plot-1';
export const INITIAL_AXIS_ID = 'y-axis-1';

export interface InitialSelection {
  type: 'trace' | 'plot';
  id: string;
  plotId: string;
}

// The plot part of a page query: `location.search` without its page keys.
export function plotQuery(search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const key of PAGE_KEYS) params.delete(key);
  return params.toString();
}

// The span of the x-axis range: what an automatic live retention derives from,
// up to LIVE_RETENTION_MAX_MS (`resolveLiveRetentionMs`).
export function rangeSpanMs(xAxis: TraceQueryXAxis): number {
  if (xAxis.timeRange !== 'custom') {
    const span = relativeRangeMs(xAxis.timeRange);
    if (span !== null) return span;
  }
  const { window } = resolveTimeWindow(xAxis, Date.now());
  return nsToMs(window.toNs - window.fromNs);
}

function defaultAxis(): Axis {
  return { id: INITIAL_AXIS_ID, ...axisDefaults(0) };
}

function pvTrace(pvName: string, index: number, palette: Palette): PVTrace {
  return {
    ...TRACE_DEFAULTS,
    id: `trace-${index + 1}`,
    pvName,
    color: colorForIndex(palette, index),
    axisId: INITIAL_AXIS_ID,
    data: [],
  };
}

// Build the opening plots from a page query (`location.search`, with or
// without the leading "?"). `freshPalette` is the palette a query with no
// `plot` key opens in.
export function buildInitialPlots(
  search: string,
  freshPalette: Palette = getPalette(DEFAULT_PALETTE_ID)
): Plot[] {
  const query = plotQuery(search);
  const hasPlotKey = new URLSearchParams(query).has('plot');
  const {
    pvs,
    xAxis,
    plot: config,
  }: TraceQuery = query === '' ? { pvs: [], xAxis: { timeRange: '-1h' } } : parseTraceQuery(query);
  const paletteId = storedPaletteId(
    config?.palette ?? (hasPlotKey ? DEFAULT_PALETTE_ID : freshPalette.id)
  );
  const palette = getPalette(paletteId ?? DEFAULT_PALETTE_ID);
  const plot: Plot = {
    // The plot and trace defaults are plotConfig.ts's sparse baseline.
    ...PLOT_DEFAULTS,
    id: INITIAL_PLOT_ID,
    xAxis: { ...xAxis },
    autoScroll: true,
    axes: [defaultAxis()],
    traces: pvs.map((pv, i) => pvTrace(pv, i, palette)),
    ...(paletteId === undefined ? {} : { palette: paletteId }),
  };
  return [config === undefined ? plot : applyPlotConfig(plot, config)];
}

// The opening selection: the first trace, else the plot itself.
export function initialSelection(plots: readonly Plot[]): InitialSelection | null {
  const plot = plots[0];
  if (!plot) return null;
  const first = plot.traces[0];
  return first
    ? { type: 'trace', id: first.id, plotId: plot.id }
    : { type: 'plot', id: plot.id, plotId: plot.id };
}
