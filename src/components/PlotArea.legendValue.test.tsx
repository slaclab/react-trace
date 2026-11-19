// ✚ Live value in the legend: an optional plot-level Display toggle, off by
// default, that appends each live curve's latest value, with its precision and
// units, to its legend entry. Formula and archive-only curves show no value,
// and neither does a disconnected PV: its last value is stale. The key
// round-trips through `plot=` only when on.
import { describe, expect, it } from 'vitest';
import type { Axis, Plot, PVTrace } from '../types';
import { AlarmSeverity, type PVData } from '@slaclab/canopy-client';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';
import { drawingThemeFor } from '../annotationTheme';
import { buildPlotOption } from './plotOption';
import {
  applyPlotConfig,
  newFormula,
  newPlot,
  newTrace,
  parsePlotConfig,
  plotConfigOf,
} from '../embed/plotConfig';
import { DEFAULT_PALETTE_ID, getPalette } from '../palettes';
import { plotSchema, type TracePlotModel } from '../tools/trace/schema/plot';
import type { TraceDotState } from '../tools/trace/dots';
import type { FieldDef, ToolContext } from '../workbench/types';
import { TRACE_FIELD_TABLE } from '../tools/trace/fieldTable';

const AXIS: Axis = {
  id: 'axis-1',
  name: 'Y-Axis 1',
  orientation: 'left',
  autoScale: true,
  logScale: false,
  visible: true,
};
const PV = 'TEST:BEAM:I';
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

function plotWith(traces: PVTrace[], over: Partial<Plot> = {}): Plot {
  return {
    id: 'plot-1',
    title: 'Plot 1',
    traces,
    axes: [AXIS],
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: 'custom', timeFrom: '2026-10-14T11:00', timeTo: '2026-10-14T13:00' },
    ...over,
  };
}

function liveCurve(id = 't1', pv = PV, over: Partial<PVTrace> = {}): PVTrace {
  return { ...newTrace(id, pv, AXIS.id, '#0f62fe', []), useLive: true, ...over };
}

// The SDK's live value; `displayValue` is the SDK's formatting of it (the
// PV's precision and units when Hare reported them).
function latest(over: Partial<PVData> = {}): PVData {
  return {
    value: 1.23456,
    displayValue: '1.235 mA',
    severity: AlarmSeverity.NO_ALARM,
    connected: true,
    timestamp: T0,
    units: 'mA',
    precision: 3,
    lowerLimit: 0,
    upperLimit: 0,
    ...over,
  };
}

function live(value: PVData | null, connected = true): LiveSeriesResult {
  return {
    status: 'connected',
    connected,
    severity: value ? 'NO_ALARM' : null,
    latest: value,
    error: null,
    points:
      value && typeof value.value === 'number'
        ? [{ time: T0, value: value.value, severity: 'NO_ALARM' }]
        : [],
    breaks: [],
  };
}

/** The legend text ECharts draws for each legend entry of `plot`. */
function legendTexts(plot: Plot, liveResults: Map<string, LiveSeriesResult>): string[] {
  const option = buildPlotOption({
    plot,
    archiveResults: new Map(),
    liveResults,
    formulaResults: new Map(),
    theme: drawingThemeFor('dark'),
  });
  const legend = option.legend as { data: string[]; formatter?: (name: string) => string };
  return legend.data.map((name) => (legend.formatter ? legend.formatter(name) : name));
}

describe('live value in the legend: off by default', () => {
  it('a new plot has it off, and the legend shows names only', () => {
    expect(newPlot('p', 0).showLegendValue).toBeUndefined();
    const plot = plotWith([liveCurve()]);
    expect(legendTexts(plot, new Map([['t1', live(latest())]]))).toEqual([PV]);
  });

  it('the Display toggle reads off, at L1, and is classed as a plot key', () => {
    const field = plotSchema.tabs
      .find((t) => t.id === 'display')
      ?.fields.find((f) => f.id === 'show-legend-value') as
      | FieldDef<TraceDotState, TracePlotModel>
      | undefined;
    expect(field).toBeDefined();
    expect(field?.kind).toBe('toggle');
    expect(field?.level).toBe('L1');
    const plot = plotWith([liveCurve()]);
    let state: TraceDotState = { plots: [plot], activePlotId: plot.id };
    const ctx = {
      get state() {
        return state;
      },
      model: {} as TracePlotModel,
      update: (fn: (s: TraceDotState) => TraceDotState) => {
        state = fn(state);
      },
      selection: null,
      target: { level: 'tool', kind: 'trace', id: plot.id },
      capabilities: {},
      ui: {},
    } as unknown as ToolContext<TraceDotState, TracePlotModel>;
    const toggle = field as unknown as {
      get: (c: typeof ctx) => boolean;
      set: (c: typeof ctx, v: boolean) => void;
    };
    expect(toggle.get(ctx)).toBe(false);
    toggle.set(ctx, true);
    expect(state.plots[0].showLegendValue).toBe(true);
    expect(toggle.get(ctx)).toBe(true);
    toggle.set(ctx, false);
    expect(state.plots[0].showLegendValue).toBeUndefined();
  });

  it('the completeness table lists the field', () => {
    expect(TRACE_FIELD_TABLE['show-legend-value']).toEqual({
      class: 'plot',
      scope: 'plot',
      key: 'showLegendValue',
    });
  });
});

describe('live value in the legend: on', () => {
  it("appends the latest value at the PV's precision, with its units", () => {
    const plot = plotWith([liveCurve()], { showLegendValue: true });
    expect(legendTexts(plot, new Map([['t1', live(latest())]]))).toEqual([`${PV}: 1.235 mA`]);
  });

  it('follows the live stream: a newer value replaces the old one', () => {
    const plot = plotWith([liveCurve()], { showLegendValue: true });
    const next = live(latest({ value: 2, displayValue: '2.000 mA', timestamp: T0 + 1000 }));
    expect(legendTexts(plot, new Map([['t1', next]]))).toEqual([`${PV}: 2.000 mA`]);
  });

  it('omits the units when the PV has none, and formats without a precision', () => {
    const plot = plotWith([liveCurve()], { showLegendValue: true });
    const bare = live(latest({ units: '', precision: 0, value: 0.5, displayValue: '0.5' }));
    expect(legendTexts(plot, new Map([['t1', bare]]))).toEqual([`${PV}: 0.5`]);
  });

  it('shows no stale value for a disconnected PV', () => {
    const plot = plotWith([liveCurve()], { showLegendValue: true });
    expect(legendTexts(plot, new Map([['t1', live(latest({ connected: false }))]]))).toEqual([PV]);
    expect(legendTexts(plot, new Map([['t1', live(latest(), false)]]))).toEqual([PV]);
    expect(legendTexts(plot, new Map([['t1', live(null)]]))).toEqual([PV]);
    expect(legendTexts(plot, new Map())).toEqual([PV]);
  });

  it('shows no value on formula and archive-only curves', () => {
    const formula = { ...newFormula('f1', AXIS.id, '#abcdef'), displayName: 'Sum' };
    const archiveOnly = liveCurve('t2', 'TEST:ARCH', { useLive: false, useArchive: true });
    const plot = plotWith([liveCurve(), formula, archiveOnly], { showLegendValue: true });
    const results = new Map([
      ['t1', live(latest())],
      ['f1', live(latest())],
      ['t2', live(latest())],
    ]);
    expect(legendTexts(plot, results)).toEqual([`${PV}: 1.235 mA`, 'Sum', 'TEST:ARCH']);
  });

  it('turning it off again drops the value (the formatter stays, so a merge clears it)', () => {
    const plot = plotWith([liveCurve()], { showLegendValue: false });
    const option = buildPlotOption({
      plot,
      archiveResults: new Map(),
      liveResults: new Map([['t1', live(latest())]]),
      formulaResults: new Map(),
      theme: drawingThemeFor('dark'),
    });
    const legend = option.legend as { formatter?: (name: string) => string };
    expect(typeof legend.formatter).toBe('function');
    expect(legend.formatter?.(PV)).toBe(PV);
  });
});

describe('live value in the legend: round trip', () => {
  const palette = getPalette(DEFAULT_PALETTE_ID);

  it('writes the key only when on, and reads it back', () => {
    const off = plotWith([liveCurve()]);
    expect(plotConfigOf(off, palette)?.showLegendValue).toBeUndefined();
    expect(plotConfigOf({ ...off, showLegendValue: false }, palette)?.showLegendValue).toBe(
      undefined
    );

    const config = plotConfigOf({ ...off, showLegendValue: true }, palette);
    expect(config?.showLegendValue).toBe(true);
    const parsed = parsePlotConfig(JSON.stringify(config));
    expect(parsed?.showLegendValue).toBe(true);
    expect(applyPlotConfig(off, parsed!).showLegendValue).toBe(true);
  });
});
