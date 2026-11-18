// Site defaults: the values a deployment sets for itself, without a rebuild,
// in a `config.json` next to the app and in Canopy's site settings
// (docs/site-defaults.md). They apply in two places only:
//
//   - where a tool creates something: a new plot or curve, a fresh tab's
//     first plot, a fresh Correlation or Waveform view;
//   - app-level behaviour: the mouse gestures, where the read-out sits, the
//     header and its links.
//
// They never change what a missing key means where a tool reads a link, a
// `.trc.json` file, a stored view or an embed query: that is the fixed wire
// baseline (src/embed/plotConfig.ts, src/io/serialize.ts, each tool's query
// defaults). A new object whose values differ from that baseline carries
// them explicitly.
//
// `SiteDefaults` is the resolved record every reader sees (src/site/store.ts);
// `SiteConfig` is what one source contributes, validated (validate.ts).
import type { GesturePrefs } from '../plot/gesturePrefs';
import type { DragMode } from '../plot/plotToggles';
import type { Metric } from '../statistics/model';
import type { Plot, PVTrace } from '../types';

export type ToolId = 'trace' | 'correlation' | 'waveform';
export const TOOL_IDS: readonly ToolId[] = ['trace', 'correlation', 'waveform'];

/** Where a plot's data read-out sits: following the cursor, or docked in a corner. */
export type TooltipMode = 'cursor' | 'docked';
export const TOOLTIP_MODES: readonly TooltipMode[] = ['cursor', 'docked'];

/** A tool's plot behaviour: the mouse gestures and the read-out. */
export interface PlotBehaviour extends GesturePrefs {
  tooltip: TooltipMode;
}

/** What a new Trace plot opens with. */
export interface TracePlotDefaults {
  showCrosshair: boolean;
  dragMode: DragMode;
  showLegend: boolean;
  showXGridlines: boolean;
  showYGridlines: boolean;
  gridStyle: Plot['gridStyle'];
  gridOpacity: number;
  tickFontSize: number;
  refreshIntervalS: number;
  /** A palette id; undefined = the default palette. The user's own pick wins. */
  palette: string | undefined;
  /** A relative range (`-1h`): a new plot's, and a fresh link's without `range`. */
  timeRange: string;
  /** The plot's default archiver; undefined = Canopy's default. */
  archiver: string | undefined;
  showDrawingTools: boolean;
}

/** What a new Trace curve opens with (formulas take the width and symbols only). */
export interface TraceCurveDefaults {
  lineWidth: number;
  lineType: PVTrace['lineType'];
  showSymbol: boolean;
}

export interface HeaderDefaults {
  /** Shown before the product name ("Trace"); '' for none. */
  prefix: string;
  /** The prefix and name in the shell's brand colour (canopy-shell's `brandColor`). */
  brand: boolean;
  bugReportUrl: string;
  docsUrl: string;
}

export interface TraceDefaults {
  plot: PlotBehaviour & TracePlotDefaults;
  trace: TraceCurveDefaults;
}

export interface CorrelationDefaults {
  plot: PlotBehaviour;
  /** A span in Trace's syntax, within Correlation's lookback range. */
  lookback: string;
  /** The Timer trigger's period, in seconds. */
  dt: number;
  metrics: readonly Metric[];
  drawingTools: boolean;
}

export interface WaveformDefaults {
  plot: PlotBehaviour;
  /** The Rolling mean's window, in seconds. */
  rollS: number;
  metrics: readonly Metric[];
  drawingTools: boolean;
}

/** The resolved site defaults: every value set. */
export interface SiteDefaults {
  header: HeaderDefaults;
  trace: TraceDefaults;
  correlation: CorrelationDefaults;
  waveform: WaveformDefaults;
}

/** One source's validated settings: any subset. The shared `plot` applies to every tool. */
export interface SiteConfig {
  header?: Partial<HeaderDefaults>;
  plot?: Partial<PlotBehaviour>;
  trace?: {
    plot?: Partial<PlotBehaviour & TracePlotDefaults>;
    trace?: Partial<TraceCurveDefaults>;
  };
  correlation?: Partial<Omit<CorrelationDefaults, 'plot'>> & { plot?: Partial<PlotBehaviour> };
  waveform?: Partial<Omit<WaveformDefaults, 'plot'>> & { plot?: Partial<PlotBehaviour> };
}
