export interface PVTrace {
  id: string;
  // Curve data source. 'pv' (the default when undefined, for back-compat with
  // saved workspaces) reads a live/archive PV; 'formula' evaluates an expression
  // over other curves via Fox.
  kind?: 'pv' | 'formula';
  pvName: string;
  displayName: string;
  color: string;
  visible: boolean;
  axisId: string;
  useLive: boolean;
  updateRate: string;
  // Retention window for the live ring buffer in ms. Falls back to
  // `LIVE_RETENTION_DEFAULT_MS` (see useLiveSeries) when undefined.
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
  // Fox expression with {var} placeholders, e.g. "{x1} + {x2}".
  expression?: string;
  // Variable name -> referenced trace id (a curve on the same plot). Resolved to
  // that trace's pvName when building the Fox request. Only PV-backed curves may
  // be referenced for now (formula-to-formula references are deferred).
  bindings?: Record<string, string>;
  lineWidth: number;
  // Connect points directly ('direct') or as a step function ('step', the
  // default — ECharts `step: 'end'`, matching the Python trace's stepMode="right").
  lineType: 'direct' | 'step';
  lineStyle: 'none' | 'solid' | 'dashed' | 'dotted' | 'dashDot' | 'dashDotDot';
  // Defaults to true when undefined.
  showExtensionLine?: boolean;
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
}

export interface Plot {
  id: string;
  title: string;
  traces: PVTrace[];
  axes: Axis[];
  backgroundColor: string;
  showLegend: boolean;
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
  // clock every `refreshIntervalS` seconds (see useAutoScrollTimers). With it
  // off the clock holds still, freezing the axis and the fetch windows.
  // Undefined autoScroll is treated as on, so plots created before this field
  // still track.
  autoScroll?: boolean;
  refreshIntervalS?: number;
}
