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
  archiveTimeRange: string;
  lineWidth: number;
  lineStyle: 'solid' | 'dashed' | 'dotted';
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
  xAxis: {
    timeRange: string;
    timeFrom?: string;
    timeTo?: string;
  };
}
