export interface PVTrace {
  id: string;
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
}
