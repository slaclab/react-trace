// ✚ Alarm colouring: an optional per-curve Style-block toggle, off by default,
// that tints the live segments of a curve by the alarm severity each live
// sample carries. Off: no dot and the curve keeps its colour. On: a MAJOR
// sample's segment is drawn in the major tint, archive points (no severity)
// keep the curve colour. The key round-trips through the `plot=` config only
// when on.
import { describe, expect, it } from 'vitest';
import type { Axis, Plot, PVTrace } from '../types';
import type { WireAlarmSeverity as AlarmSeverity } from '@slaclab/canopy-client';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import { drawingThemeFor } from '../annotationTheme';
import { ALARM_TINTS, buildPlotOption } from './plotOption';
import { newFormula, newTrace, parsePlotConfig, plotConfigOf } from '../embed/plotConfig';
import { DEFAULT_PALETTE_ID, getPalette } from '../palettes';
import { pvCurveSchema, type TraceCurveModel } from '../tools/trace/schema/curve';
import { formulaCurveSchema } from '../tools/trace/schema/formula';
import type { TraceDotState } from '../tools/trace/dots';
import type { FieldDef, ObjectSchema, ToolContext } from '../workbench/types';
import { TRACE_FIELD_TABLE } from '../tools/trace/fieldTable';

type Series = {
  id?: string;
  data: [number, number | null][];
  lineStyle?: { color?: string };
};

const AXIS: Axis = {
  id: 'axis-1',
  name: 'Y-Axis 1',
  orientation: 'left',
  autoScale: true,
  logScale: false,
  visible: true,
};
const COLOR = '#0f62fe';
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

function plotWith(trace: PVTrace): Plot {
  return {
    id: 'plot-1',
    title: 'Plot 1',
    traces: [trace],
    axes: [AXIS],
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: 'custom', timeFrom: '2026-10-14T11:00', timeTo: '2026-10-14T13:00' },
  };
}

function liveCurve(over: Partial<PVTrace> = {}): PVTrace {
  return {
    ...newTrace('t1', 'TEST:BEAM:I', AXIS.id, COLOR, []),
    useLive: true,
    useArchive: false,
    ...over,
  };
}

function live(severities: AlarmSeverity[]): LiveSeriesResult {
  return {
    status: 'connected',
    connected: true,
    severity: severities[severities.length - 1] ?? null,
    latest: null,
    error: null,
    points: severities.map((severity, i) => ({ time: T0 + i * 1000, value: i, severity })),
    breaks: [],
  };
}

function seriesOf(
  trace: PVTrace,
  liveResult: LiveSeriesResult | undefined,
  archive?: ArchiveSeriesResult
): Series[] {
  const option = buildPlotOption({
    plot: plotWith(trace),
    archiveResults: new Map(archive ? [[trace.id, archive]] : []),
    liveResults: new Map(liveResult ? [[trace.id, liveResult]] : []),
    formulaResults: new Map(),
    theme: drawingThemeFor('dark'),
  });
  return option.series as Series[];
}

const tinted = (series: Series[]) => series.filter((s) => s.id?.includes('-alarm-'));

// ── The field ─────────────────────────────────────────────────────────────

type Model = TraceCurveModel;
type Field = FieldDef<TraceDotState, Model>;
const palette = getPalette(DEFAULT_PALETTE_ID);

function fieldIn(schema: ObjectSchema<TraceDotState, Model>, id: string): Field | undefined {
  return schema.tabs.flatMap((t) => t.fields).find((f) => f.id === id) as Field | undefined;
}

function ctxFor(
  trace: PVTrace,
  onUpdate: (next: TraceDotState) => void = () => {}
): ToolContext<TraceDotState, Model> {
  const state: TraceDotState = { plots: [plotWith(trace)], activePlotId: 'plot-1' };
  const target = { level: 'item' as const, kind: 'curve', id: trace.id };
  return {
    state,
    model: {
      palette,
      fragmentInput: () => {
        throw new Error('no fragment input in this test');
      },
      inspect: () => {},
      createFormula: () => {},
    },
    update: (fn: (s: TraceDotState) => TraceDotState) => onUpdate(fn(state)),
    selection: target,
    target,
    capabilities: { elog: true },
    ui: {},
  } as unknown as ToolContext<TraceDotState, Model>;
}

type Toggle = Field & {
  get(ctx: ToolContext<TraceDotState, Model>): boolean;
  set(ctx: ToolContext<TraceDotState, Model>, on: boolean): void;
  when?(ctx: ToolContext<TraceDotState, Model>): boolean;
  modified?(ctx: ToolContext<TraceDotState, Model>): boolean;
};

describe('Alarm colouring: the Style-block field', () => {
  const field = fieldIn(pvCurveSchema, 'alarm-coloring') as Toggle;

  it('is a Style-block toggle at L2, off by default with no dot', () => {
    expect(field).toBeDefined();
    expect(field.kind).toBe('toggle');
    expect(field.tab).toBe('style');
    expect(field.level).toBe('L2');
    const ctx = ctxFor(liveCurve());
    expect(field.get(ctx)).toBe(false);
    expect(field.modified?.(ctx)).toBe(false);
  });

  it('turning it on stores true and shows the dot; turning it off stores nothing', () => {
    let next: TraceDotState | undefined;
    field.set(
      ctxFor(liveCurve(), (s) => (next = s)),
      true
    );
    const on = next!.plots[0].traces[0];
    expect(on.alarmColoring).toBe(true);
    expect(field.modified?.(ctxFor(on))).toBe(true);

    field.set(
      ctxFor(on, (s) => (next = s)),
      false
    );
    expect(next!.plots[0].traces[0].alarmColoring).toBeUndefined();
  });

  it('is hidden on formula curves, which carry no severity', () => {
    const shared = fieldIn(formulaCurveSchema, 'alarm-coloring') as Toggle | undefined;
    if (shared === undefined) return; // not part of the formula schema at all
    expect(shared.when?.(ctxFor(newFormula('f1', AXIS.id, COLOR)))).toBe(false);
  });

  it('the completeness table lists the field as the trace key alarmColoring', () => {
    expect(TRACE_FIELD_TABLE['alarm-coloring']).toEqual({
      class: 'plot',
      scope: 'trace',
      key: 'alarmColoring',
    });
  });
});

// ── The chart ─────────────────────────────────────────────────────────────

describe('Alarm colouring: the chart', () => {
  const severities: AlarmSeverity[] = ['NO_ALARM', 'MAJOR', 'NO_ALARM', 'NO_ALARM'];

  it('off: no tint series, the curve draws in its own colour', () => {
    const series = seriesOf(liveCurve(), live(severities));
    expect(tinted(series)).toEqual([]);
    expect(series.find((s) => s.id === 't1')?.lineStyle?.color).toBe(COLOR);
  });

  it("on: a MAJOR sample's segment uses the major tint, and only that segment", () => {
    const series = seriesOf(liveCurve({ alarmColoring: true }), live(severities));
    const overlays = tinted(series);
    expect(overlays.map((s) => s.id)).toEqual(['t1-alarm-MAJOR']);
    const major = overlays[0];
    expect(major.lineStyle?.color).toBe(ALARM_TINTS.MAJOR);
    // Segment 1 → 2 holds the MAJOR sample's value; the other segments are not tinted.
    const drawn = major.data.filter((p) => p[1] !== null);
    expect(drawn).toEqual([
      [T0 + 1000, 1],
      [T0 + 2000, 2],
    ]);
    // The curve itself keeps its colour underneath.
    expect(series.find((s) => s.id === 't1')?.lineStyle?.color).toBe(COLOR);
  });

  it('tints each severity with its own colour and breaks between separate runs', () => {
    const series = seriesOf(
      liveCurve({ alarmColoring: true }),
      live(['MINOR', 'MINOR', 'NO_ALARM', 'MINOR', 'MAJOR', 'NO_ALARM'])
    );
    const byId = new Map(tinted(series).map((s) => [s.id, s]));
    expect([...byId.keys()]).toEqual(['t1-alarm-MINOR', 't1-alarm-MAJOR']);
    expect(byId.get('t1-alarm-MINOR')!.lineStyle?.color).toBe(ALARM_TINTS.MINOR);
    expect(byId.get('t1-alarm-MAJOR')!.lineStyle?.color).toBe(ALARM_TINTS.MAJOR);
    // MINOR runs 0→2 and 3→4, each closed by a null at its end so 2→3 is not drawn tinted.
    const minor = byId.get('t1-alarm-MINOR')!.data;
    expect(minor).toEqual([
      [T0, 0],
      [T0 + 1000, 1],
      [T0 + 2000, 2],
      [T0 + 2000, null],
      [T0 + 3000, 3],
      [T0 + 4000, 4],
      [T0 + 4000, null],
    ]);
  });

  it('leaves INVALID samples untinted: the line breaks there instead', () => {
    const series = seriesOf(
      liveCurve({ alarmColoring: true }),
      live(['NO_ALARM', 'INVALID', 'INVALID', 'NO_ALARM'])
    );
    expect(tinted(series)).toEqual([]);
    // A step line holds its last value up to the break.
    const line = series.find((s) => s.id === 't1')!.data;
    expect(line).toEqual([
      [T0, 0],
      { value: [T0 + 1000, 0], symbol: 'none' },
      [T0 + 1000, null],
      [T0 + 3000, 3],
    ]);
  });

  it('turning it off again restores the curve colour', () => {
    const on = seriesOf(liveCurve({ alarmColoring: true }), live(severities));
    expect(tinted(on)).toHaveLength(1);
    const off = seriesOf(liveCurve({ alarmColoring: undefined }), live(severities));
    expect(tinted(off)).toEqual([]);
    expect(off.find((s) => s.id === 't1')?.lineStyle?.color).toBe(COLOR);
  });

  it('archive points carry no severity and keep the curve colour', () => {
    const archive = {
      mode: 'raw',
      status: 'ready',
      mean: [
        { time: T0 - 3000, value: 10 },
        { time: T0 - 2000, value: 11 },
      ],
      band: [],
    } as unknown as ArchiveSeriesResult;
    const series = seriesOf(
      liveCurve({ alarmColoring: true, useArchive: true }),
      live(['NO_ALARM', 'NO_ALARM']),
      archive
    );
    expect(tinted(series)).toEqual([]);
  });
});

// ── The query ─────────────────────────────────────────────────────────────

describe('Alarm colouring: round trip', () => {
  it('is written only when on and read back', () => {
    const off = plotConfigOf(plotWith(liveCurve()), palette);
    expect(JSON.stringify(off ?? {})).not.toContain('alarmColoring');
    const on = plotConfigOf(plotWith(liveCurve({ alarmColoring: true })), palette);
    expect(on?.traces?.[0]?.alarmColoring).toBe(true);
    expect(parsePlotConfig(JSON.stringify(on))?.traces?.[0]?.alarmColoring).toBe(true);
  });
});
