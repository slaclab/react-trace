// The distribution block of the statistics panel: one small
// chart per shown row, the row's `y` values as a probability density (a step
// area in the row's colour) with the mean and mean ± σ as guide lines. Rows
// have their own value ranges (a Trace plot may mix axes), so each is its own
// chart rather than one shared axis.

import { useMemo, useRef } from 'react';
import ReactECharts from 'echarts-for-react';
import { useChartFont } from '@slaclab/canopy-shell';
import type { EChartsOption } from 'echarts';
import { CHART_THEMES, type ChartTheme } from '@slaclab/canopy-charts';
import { formatSig, type StatFrame, type StatRow } from './evaluate';
import { densitySteps, histogram, type Histogram } from './histogram';

export interface DistributionProps {
  frame: StatFrame | null;
  /** The unit text of a row's value ('' for none). */
  unitOf: (rowId: string) => string;
  chartTheme?: ChartTheme;
}

export const DIST_HEIGHT = 110;
const AREA_OPACITY = 0.35;

function distributionOption(
  h: Histogram,
  label: string,
  color: string | undefined,
  unit: string,
  theme: ChartTheme,
  fontFamily: string | undefined
): EChartsOption {
  const axisStyle = {
    // The axis ends are the data's exact extremes: print them at 4 digits.
    axisLabel: { color: theme.axisLabel, formatter: (v: number) => formatSig(v) },
    axisLine: { lineStyle: { color: theme.axisLine } },
    splitLine: { lineStyle: { color: theme.splitLine } },
  };
  const guides: { xAxis: number; name: string; lineStyle?: { type: 'dashed' | 'dotted' } }[] = [
    { xAxis: h.mean, name: 'mean', lineStyle: { type: 'dashed' } },
  ];
  if (Number.isFinite(h.std) && h.std > 0) {
    guides.push({ xAxis: h.mean - h.std, name: '−σ', lineStyle: { type: 'dotted' } });
    guides.push({ xAxis: h.mean + h.std, name: '+σ', lineStyle: { type: 'dotted' } });
  }
  const suffix = unit === '' ? '' : ` ${unit}`;
  const title = `${label} — n ${h.n}, mean ${formatSig(h.mean)}${suffix}, σ ${formatSig(h.std)}${suffix}`;
  return {
    animation: false,
    textStyle: { fontFamily },
    grid: { left: 56, right: 12, top: 18, bottom: 22 },
    title: { text: title, left: 4, top: 0, textStyle: { fontSize: 11, color: theme.axisLabel } },
    tooltip: {
      trigger: 'axis',
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.tooltipText },
      valueFormatter: (v) => (typeof v === 'number' ? formatSig(v) : String(v)),
    },
    xAxis: {
      type: 'value',
      // The guides (mean ± σ) can lie outside the data range at small n.
      min: Math.min(h.edges[0], ...guides.map((g) => g.xAxis)),
      max: Math.max(h.edges[h.edges.length - 1], ...guides.map((g) => g.xAxis)),
      ...axisStyle,
    },
    // No axis name: the title carries the numbers, and "density" would sit on it.
    yAxis: { type: 'value', ...axisStyle },
    series: [
      {
        type: 'line',
        name: 'density',
        step: 'end',
        showSymbol: false,
        color,
        lineStyle: { width: 1 },
        areaStyle: { opacity: AREA_OPACITY },
        data: densitySteps(h),
        markLine: {
          symbol: 'none',
          silent: true,
          animation: false,
          lineStyle: { color: theme.axisLabel, width: 1 },
          // The guide's name, not its value (the title already has mean and σ).
          label: {
            show: true,
            position: 'insideEndTop',
            formatter: '{b}',
            fontSize: 10,
            color: theme.axisLabel,
          },
          data: guides,
        },
      },
    ],
  };
}

/** The block, or nothing when the frame shows no row. */
export function Distribution({ frame, unitOf, chartTheme = CHART_THEMES.dark }: DistributionProps) {
  const rows = useMemo(() => (frame?.rows ?? []).filter((r) => r.hidden !== true), [frame]);
  const sectionRef = useRef<HTMLElement>(null);
  const chartFont = useChartFont(sectionRef);
  const fontFamily = chartFont.ready ? chartFont.fontFamily : undefined;
  if (rows.length === 0) return null;
  return (
    <section
      ref={sectionRef}
      className="stats-dist"
      aria-label="Distribution"
      data-testid="stats-distribution"
    >
      {rows.map((row) => (
        <DistributionChart
          key={row.id}
          row={row}
          color={row.color}
          unit={unitOf(row.id)}
          theme={chartTheme}
          fontFamily={fontFamily}
        />
      ))}
    </section>
  );
}

const DIST_STYLE = { height: DIST_HEIGHT };

function DistributionChart({
  row,
  color,
  unit,
  theme,
  fontFamily,
}: {
  row: StatRow;
  color: string | undefined;
  unit: string;
  theme: ChartTheme;
  fontFamily: string | undefined;
}) {
  // Keyed on the values, not the row object: a frame rebuilt with the same
  // column (a publish that moved nothing here) recomputes nothing.
  const y = row.columns.y;
  const h = useMemo(() => histogram(y), [y]);
  const option = useMemo(
    () => (h === null ? null : distributionOption(h, row.label, color, unit, theme, fontFamily)),
    [h, row.label, color, unit, theme, fontFamily]
  );
  if (option === null) {
    return (
      <p className="stats-dist__empty" data-testid={`dist-empty-${row.id}`}>
        {row.label}: no values
      </p>
    );
  }
  // Merge mode: one series of a stable shape, so a new option updates the
  // chart in place rather than tearing it down on every publish.
  return (
    <ReactECharts
      className="stats-dist__chart"
      style={DIST_STYLE}
      option={option}
      data-testid={`dist-${row.id}`}
    />
  );
}
