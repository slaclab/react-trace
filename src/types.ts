import type { Annotation } from './annotations/model';
import type { DragMode } from './plot/plotToggles';
import type { Metric } from './statistics/model';

export interface PVTrace {
  id: string;
  // Curve data source. 'pv' (the default when undefined, for back-compat with
  // saved workspaces) reads a live/archive PV; 'formula' evaluates an expression
  // over other curves via the Formula Engine.
  kind?: 'pv' | 'formula';
  pvName: string;
  displayName: string;
  color: string;
  visible: boolean;
  axisId: string;
  useLive: boolean;
  // Retention window for the live ring buffer in ms. Undefined = automatic:
  // derived from the time range span, non-decreasing for the
  // curve's life, capped at LIVE_RETENTION_MAX_MS (`resolveLiveRetentionMs`).
  // A value pins it; openings and new curves leave it undefined.
  liveRetentionMs?: number;
  useArchive: boolean;
  // Per-curve override for the binned-mode `maxPoints` (Mole `optimized_<N>`).
  // Falls back to the plot's default when undefined.
  optimizedDataBins?: number;
  // When binned archive data is loaded, also draw the min/max band behind the
  // mean line. Defaults to true when undefined.
  showArchiveBand?: boolean;
  // Per-curve archiver override; undefined means "use the global selection".
  archiver?: string;
  // ── Formula curves (kind === 'formula') ──────────────────────────────────
  // Formula Engine expression with {var} placeholders, e.g. "{x1} + {x2}".
  expression?: string;
  // Variable name -> referenced trace id (a curve on the same plot). Resolved to
  // that trace's pvName when building the Formula Engine request. Only PV-backed curves may
  // be referenced for now (formula-to-formula references are deferred).
  bindings?: Record<string, string>;
  lineWidth: number;
  // Connect points directly ('direct') or as a step function ('step', the
  // default — ECharts `step: 'end'`, matching the Python trace's stepMode="right").
  lineType: 'direct' | 'step';
  lineStyle: 'none' | 'solid' | 'dashed' | 'dotted' | 'dashDot' | 'dashDotDot';
  // Defaults to true when undefined.
  showExtensionLine?: boolean;
  // ✚ Alarm colouring: tint the segments of the live curve by the alarm
  // severity each live sample carries (MINOR, MAJOR, INVALID). Off when
  // undefined; only "on" is stored. Archive points carry no severity and keep
  // the curve colour; formula curves never tint.
  alarmColoring?: boolean;
  // Symbol (data-point marker) appearance.
  showSymbol: boolean;
  symbolShape:
    | 'none'
    | 'circle'
    | 'square'
    | 'triangle'
    | 'star'
    | 'pentagon'
    | 'hexagon'
    | 'x'
    | 'diamond'
    | 'plus';
  symbolSize: number;
  data: { time: number; value: number }[];
}

export interface Axis {
  id: string;
  name: string;
  orientation: 'left' | 'right';
  min?: number;
  max?: number;
  autoScale: boolean;
  logScale: boolean;
  visible: boolean;
  // Engineering units (EGU) this axis represents, used to auto-assign new
  // curves to a matching axis. Undefined for axes created before units were
  // tracked or for manually named axes with no unit.
  units?: string;
  // The ✚ Unit override: the unit text the axis shows in place of
  // `units`. Undefined = automatic (the stamped EGU). Display only: routing
  // and the Label's automatic value keep reading `units`.
  unitLabel?: string;
}

export interface Plot {
  id: string;
  title: string;
  traces: PVTrace[];
  axes: Axis[];
  // Chart background. Undefined = automatic: the theme's default
  // background (`effectiveBackground`). A value pins it; openings and new
  // plots leave it undefined.
  backgroundColor?: string;
  showLegend: boolean;
  // ✚ Live value in the legend: append each live curve's latest value,
  // at its precision and with its units, to its legend entry. Off when
  // undefined; only "on" is stored. Formula and archive-only curves, and a
  // disconnected PV, show no value.
  showLegendValue?: boolean;
  // ✚ Pin data window: the hover readout sits fixed at the plot's top-right
  // instead of following the cursor. Off when undefined; only "on" is stored.
  pinDataWindow?: boolean;
  // ✚ Status line under the plot. On when undefined; only "off" (false) is
  // stored.
  showStatusLine?: boolean;
  // The hover read-out (the chart tooltip). On when undefined; only "off"
  // (false) is stored.
  showTooltip?: boolean;
  // What a left-drag in the plot area does. Pan when undefined; only "zoom"
  // is stored.
  dragMode?: DragMode;
  // X (vertical, time) gridlines.
  showXGridlines: boolean;
  // Y (horizontal) gridlines. Drawn from the primary (first visible) axis only,
  // so a multi-axis plot never stacks mismatched grids from differing scales.
  showYGridlines: boolean;
  showCrosshair: boolean;
  gridStyle: 'solid' | 'dashed' | 'dotted';
  // Opacity applied to all gridlines (X and Y), 0..1. Defaults to 1.
  gridOpacity: number;
  // Axis tick label font size in px. Defaults to 11.
  tickFontSize: number;
  // Per-plot default archiver for this plot's traces; undefined means "use the
  // backend default". A trace's own `archiver` overrides this.
  archiver?: string;
  xAxis: {
    timeRange: string;
    timeFrom?: string;
    timeTo?: string;
  };
  // Autoscroll keeps "now" pinned to the right edge by advancing the plot's
  // clock every `refreshIntervalS` seconds, or more often on a short span (see
  // refreshIntervalMs). With it off the clock holds still, freezing the axis
  // and the fetch windows.
  // Undefined autoScroll is treated as on, so plots created before this field
  // still track.
  autoScroll?: boolean;
  refreshIntervalS?: number;
  // The palette id this plot's curves follow. Undefined means the default
  // palette; a stored id is always a known, non-default palette.
  palette?: string;
  // Show statistics (the shared panel under the chart). Off when
  // undefined; only "on" is stored.
  showStats?: boolean;
  // Show distribution (the density block of the panel). Off when
  // undefined; only "on" is stored.
  showDist?: boolean;
  // The plot's statistics metric list (tools/trace/metrics.ts). Undefined is
  // the default list; a stored list is always off the default.
  metrics?: Metric[];
  // Drawings on this plot. Absent = none: `withAnnotations` deletes
  // the key when the list empties and rehydrate maps [] to absent.
  annotations?: Annotation[];
}
