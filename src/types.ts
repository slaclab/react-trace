export interface PVTrace {
  id: string;
  pvName: string;
  displayName: string;
  color: string;
  visible: boolean;
  axisId: string;
  useLive: boolean;
  updateRate: string;
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
  showGridlines: boolean;
  gridStyle: 'solid' | 'dashed' | 'dotted';
  // Per-plot default archiver for this plot's traces; undefined means "use the
  // backend default". A trace's own `archiver` overrides this.
  archiver?: string;
  xAxis: {
    timeRange: string;
    timeFrom?: string;
    timeTo?: string;
  };
}
