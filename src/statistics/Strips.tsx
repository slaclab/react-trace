// The strip charts: one chart per metric with `strip`, in list order, each
// row a line over time on the tool's clock. The history is built by
// strips.ts `appendStrips` and records every metric, so a strip turned on
// shows the past; undefined values break the line rather than drawing a
// confident zero. A preset with a natural range (r, R²) gets a fixed axis.

import { useMemo, useRef } from 'react';
import ReactECharts from 'echarts-for-react';
import { useChartFont } from '@slaclab/canopy-shell';
import type { EChartsOption } from 'echarts';
import { CHART_THEMES, type ChartTheme } from '@slaclab/canopy-charts';
import { presetOf, type Metric, type MetricCatalog } from './model';
import type { StripHistory } from './history';

/** A line of a strip: a frame row. */
export interface StripRow {
  id: string;
  label: string;
  color?: string;
}

export interface StripsProps {
  catalog: MetricCatalog;
  history: StripHistory;
  /** The rows, in colour order. */
  rows: readonly StripRow[];
  /** The metric list; its `strip` entries are the charts. */
  metrics: readonly Metric[];
  /** Chart colours; the dark (g100) chart theme by default. */
  chartTheme?: ChartTheme;
}

export const STRIP_HEIGHT = 110;

function stripOption(
  history: StripHistory,
  rows: readonly StripRow[],
  id: string,
  label: string,
  theme: ChartTheme,
  fontFamily: string | undefined,
  range?: [number, number]
): EChartsOption {
  const axisStyle = {
    axisLabel: { color: theme.axisLabel },
    axisLine: { lineStyle: { color: theme.axisLine } },
    splitLine: { lineStyle: { color: theme.splitLine } },
  };
  return {
    animation: false,
    textStyle: { fontFamily },
    grid: { left: 64, right: 12, top: 18, bottom: 22 },
    title: { text: label, left: 4, top: 0, textStyle: { fontSize: 11, color: theme.axisLabel } },
    tooltip: {
      trigger: 'axis',
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.tooltipText },
    },
    xAxis: { type: 'time', ...axisStyle },
    yAxis: {
      type: 'value',
      scale: range === undefined,
      min: range?.[0],
      max: range?.[1],
      ...axisStyle,
    },
    series: rows.map((row) => ({
      type: 'line',
      name: row.label,
      showSymbol: false,
      connectNulls: false,
      color: row.color,
      data: history.points.map((p) => [p.timeMs, p.values[row.id]?.[id] ?? null]),
    })),
  };
}

/** The strips, or nothing when no metric has `strip`. */
export function Strips({ metrics, ...rest }: StripsProps) {
  const strips = metrics.filter((m) => m.strip);
  return strips.length === 0 ? null : <StripCharts {...rest} strips={strips} />;
}

// Mounted only with at least one strip, so the chart-font hook below sees its
// section from the first effect on.
function StripCharts({
  catalog,
  history,
  rows,
  strips,
  chartTheme = CHART_THEMES.dark,
}: Omit<StripsProps, 'metrics'> & { strips: readonly Metric[] }) {
  // Canvas text does not inherit CSS: the strips draw in the family the
  // section computes, named only once it has loaded so the options change
  // then and ECharts redraws with the real face.
  const sectionRef = useRef<HTMLElement>(null);
  const chartFont = useChartFont(sectionRef);
  const fontFamily = chartFont.ready ? chartFont.fontFamily : undefined;
  return (
    <section ref={sectionRef} className="stats-strips" aria-label="Strip charts">
      {strips.map(({ id, label }) => (
        <StripChart
          key={id}
          history={history}
          rows={rows}
          id={id}
          label={label}
          theme={chartTheme}
          fontFamily={fontFamily}
          range={presetOf(catalog, id)?.range}
        />
      ))}
    </section>
  );
}

const STRIP_STYLE = { height: STRIP_HEIGHT };

// One strip; its option is rebuilt only when what it draws changed, so a
// parent render with the same history (the common case: a frame that did
// not advance the clock) costs no setOption.
function StripChart({
  history,
  rows,
  id,
  label,
  theme,
  fontFamily,
  range,
}: {
  history: StripHistory;
  rows: readonly StripRow[];
  id: string;
  label: string;
  theme: ChartTheme;
  fontFamily: string | undefined;
  range: [number, number] | undefined;
}) {
  const option = useMemo(
    () => stripOption(history, rows, id, label, theme, fontFamily, range),
    [history, rows, id, label, theme, fontFamily, range]
  );
  return (
    <ReactECharts className="stats-strips__chart" style={STRIP_STYLE} notMerge option={option} />
  );
}
