import ReactECharts from 'echarts-for-react';
import { Add, Close, ColumnDependency, Grid, Maximize } from '@carbon/icons-react';
import type { Plot, PVTrace } from '../types';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';

interface PlotAreaProps {
  plots: Plot[];
  activePlotId: string;
  viewMode: 'tabs' | 'grid';
  archiveResultsByPlot: Map<string, Map<string, ArchiveSeriesResult>>;
  onSetActivePlot: (id: string) => void;
  onAddPlot: () => void;
  onRemovePlot: (id: string) => void;
  onSetViewMode: (mode: 'tabs' | 'grid') => void;
  onPopOutPlot: (id: string) => void;
}

interface SinglePlotProps {
  plot: Plot;
  archiveResults: Map<string, ArchiveSeriesResult>;
}

function traceLineData(
  trace: PVTrace,
  archive: ArchiveSeriesResult | undefined
): [number, number][] {
  if (trace.useArchive && archive && archive.status === 'ready') {
    return archive.mean.map((p) => [p.time, p.value]);
  }
  return trace.data.map((p) => [p.time, p.value]);
}

export function SinglePlot({ plot, archiveResults }: SinglePlotProps) {
  const visibleAxes = plot.axes.filter((a) => a.visible);
  const visibleTraces = plot.traces.filter((t) => t.visible);

  // Build yAxis array; ECharts links series to axes by index, so we track index per axis id
  const axisIndexMap = new Map<string, number>();
  visibleAxes.forEach((axis, idx) => {
    axisIndexMap.set(axis.id, idx);
  });

  const rightAxesCount = visibleAxes.filter((a) => a.orientation === 'right').length;

  const option = {
    backgroundColor: plot.backgroundColor,
    animation: false,
    grid: {
      top: 40,
      right: rightAxesCount > 0 ? 70 : 20,
      bottom: 60,
      left: 70,
    },
    xAxis: {
      type: 'time',
      axisLabel: { color: '#c6c6c6', fontSize: 11 },
      axisLine: { lineStyle: { color: '#525252' } },
      splitLine: {
        show: plot.showGridlines,
        lineStyle: { color: '#393939' },
      },
    },
    yAxis: visibleAxes.map((axis) => ({
      id: axis.id,
      type: axis.logScale ? 'log' : 'value',
      name: axis.name,
      nameTextStyle: { color: '#8d8d8d', fontSize: 11 },
      position: axis.orientation,
      min: axis.autoScale ? undefined : axis.min,
      max: axis.autoScale ? undefined : axis.max,
      scale: axis.autoScale,
      axisLabel: { color: '#c6c6c6', fontSize: 11 },
      axisLine: { lineStyle: { color: '#525252' } },
      splitLine: {
        show: plot.showGridlines,
        lineStyle: { color: '#393939' },
      },
    })),
    series: visibleTraces.flatMap((trace) => {
      const yAxisIndex = axisIndexMap.get(trace.axisId) ?? 0;
      const archive = archiveResults.get(trace.id);
      const series: Record<string, unknown>[] = [];

      // Min/max band, drawn as two stacked area series so ECharts fills between them.
      if (
        trace.useArchive &&
        archive &&
        archive.status === 'ready' &&
        archive.mode === 'binned' &&
        archive.band.length > 0
      ) {
        const stackId = `band-${trace.id}`;
        series.push({
          id: `${trace.id}-band-min`,
          name: `${trace.displayName} (min)`,
          type: 'line',
          yAxisIndex,
          data: archive.band.map((p) => [p.time, p.min]),
          stack: stackId,
          lineStyle: { opacity: 0 },
          areaStyle: { opacity: 0 },
          symbol: 'none',
          showInLegend: false,
          tooltip: { show: false },
          silent: true,
          animation: false,
        });
        series.push({
          id: `${trace.id}-band-max`,
          name: `${trace.displayName} (max)`,
          type: 'line',
          yAxisIndex,
          data: archive.band.map((p) => [p.time, p.max - p.min]),
          stack: stackId,
          lineStyle: { opacity: 0 },
          areaStyle: { color: trace.color, opacity: 0.18 },
          symbol: 'none',
          showInLegend: false,
          tooltip: { show: false },
          silent: true,
          animation: false,
        });
      }

      series.push({
        id: trace.id,
        name: trace.displayName,
        type: 'line',
        yAxisIndex,
        data: traceLineData(trace, archive),
        lineStyle: {
          color: trace.color,
          width: trace.lineWidth,
          type: trace.lineStyle,
        },
        itemStyle: { color: trace.color },
        symbol: 'none',
        sampling: 'lttb',
        animation: false,
      });

      return series;
    }),
    dataZoom: [
      {
        type: 'inside',
        zoomOnMouseWheel: true,
        moveOnMouseMove: false,
        moveOnMouseWheel: false,
      },
    ],
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#262626',
      borderColor: '#393939',
      textStyle: { color: '#f4f4f4', fontSize: 11 },
      formatter: (
        params: { axisValueLabel: string; seriesName: string; value: [number, number] }[]
      ) => {
        if (!Array.isArray(params) || params.length === 0) return '';
        const time = new Date(params[0].axisValueLabel).toLocaleTimeString();
        const lines = params
          .map(
            (p) =>
              `<span style="color:${(p as { color?: string }).color ?? '#f4f4f4'}">${p.seriesName}</span>: ${typeof p.value[1] === 'number' ? p.value[1].toFixed(3) : p.value[1]}`
          )
          .join('<br/>');
        return `<div style="font-size:11px"><div style="color:#8d8d8d;margin-bottom:4px">${time}</div>${lines}</div>`;
      },
    },
    legend: {
      bottom: 8,
      textStyle: { color: '#c6c6c6', fontSize: 11 },
      inactiveColor: '#6f6f6f',
      data: visibleTraces.map((t) => t.displayName),
    },
  };

  return (
    <ReactECharts
      option={option}
      style={{ height: '100%', width: '100%' }}
      opts={{ renderer: 'canvas' }}
    />
  );
}

const EMPTY_RESULTS: Map<string, ArchiveSeriesResult> = new Map();

export function PlotArea({
  plots,
  activePlotId,
  viewMode,
  archiveResultsByPlot,
  onSetActivePlot,
  onAddPlot,
  onRemovePlot,
  onSetViewMode,
  onPopOutPlot,
}: PlotAreaProps) {
  const activePlot = plots.find((p) => p.id === activePlotId) ?? plots[0];

  const gridCols =
    plots.length === 1
      ? 'grid-cols-1'
      : plots.length === 2
        ? 'grid-cols-2'
        : plots.length === 3
          ? 'grid-cols-3'
          : 'grid-cols-2';

  const gridRows = plots.length >= 4 ? 'grid-rows-2' : 'grid-rows-1';

  return (
    <div className="plot-area">
      {/* Tab bar */}
      <div className="plot-tab-bar">
        <div className="plot-tab-bar__tabs">
          {viewMode === 'tabs' &&
            plots.map((plot) => (
              <div
                key={plot.id}
                className={`plot-tab ${plot.id === activePlotId ? 'plot-tab--active' : 'plot-tab--inactive'}`}
                onClick={() => onSetActivePlot(plot.id)}
              >
                <span>{plot.title}</span>
                <button
                  className="plot-tab__action-btn"
                  title="Fullscreen"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPopOutPlot(plot.id);
                  }}
                >
                  <Maximize size={12} />
                </button>
                {plots.length > 1 && (
                  <button
                    className="plot-tab__action-btn plot-tab__action-btn--close"
                    title="Close plot"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemovePlot(plot.id);
                    }}
                  >
                    <Close size={12} />
                  </button>
                )}
              </div>
            ))}
          {viewMode === 'grid' && (
            <span style={{ fontSize: 12, color: '#c6c6c6', padding: '0 8px' }}>
              Grid View ({plots.length} plots)
            </span>
          )}
        </div>

        <div className="plot-tab-bar__controls">
          <button
            className={`view-mode-btn${viewMode === 'tabs' ? ' view-mode-btn--active' : ''}`}
            title="Tab view"
            onClick={() => onSetViewMode('tabs')}
          >
            <ColumnDependency size={16} />
          </button>
          <button
            className={`view-mode-btn${viewMode === 'grid' ? ' view-mode-btn--active' : ''}`}
            title="Grid view"
            onClick={() => onSetViewMode('grid')}
          >
            <Grid size={16} />
          </button>
          <button
            className="view-mode-btn"
            title="Add plot"
            onClick={onAddPlot}
            style={{ marginLeft: 4 }}
          >
            <Add size={16} />
          </button>
        </div>
      </div>

      {/* Plot content */}
      <div className="plot-content">
        {viewMode === 'tabs' ? (
          <SinglePlot
            key={activePlotId}
            plot={activePlot}
            archiveResults={archiveResultsByPlot.get(activePlot.id) ?? EMPTY_RESULTS}
          />
        ) : (
          <div
            className={`plot-grid ${gridCols} ${gridRows}`}
            style={{
              gridTemplateColumns: `repeat(${plots.length <= 2 ? plots.length : 2}, 1fr)`,
              gridTemplateRows: plots.length >= 4 ? '1fr 1fr' : '1fr',
            }}
          >
            {plots.map((plot) => (
              <div key={plot.id} className="plot-grid__cell">
                <button
                  className="plot-grid__cell-btn plot-grid__cell-btn--maximize"
                  title="Fullscreen"
                  onClick={() => onPopOutPlot(plot.id)}
                >
                  <Maximize size={14} />
                </button>
                {plots.length > 1 && (
                  <button
                    className="plot-grid__cell-btn plot-grid__cell-btn--close"
                    title="Remove plot"
                    onClick={() => onRemovePlot(plot.id)}
                  >
                    <Close size={14} />
                  </button>
                )}
                <SinglePlot
                  plot={plot}
                  archiveResults={archiveResultsByPlot.get(plot.id) ?? EMPTY_RESULTS}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
