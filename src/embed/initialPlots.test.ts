// The opening plots built from a host query: the CANOPY preset gives three
// archive + live traces whose automatic live retention keeps the range's worth
// of live samples, at most LIVE_RETENTION_MAX_MS; no query, or a query without
// PVs, gives one empty plot with one default axis. Retention and background
// are optional-automatic: an opening stamps neither, so neither
// Properties field shows a dot, and reset returns a pinned one to automatic.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INITIAL_AXIS_ID,
  INITIAL_PLOT_ID,
  buildInitialPlots,
  initialSelection,
  plotQuery,
  rangeSpanMs,
} from './initialPlots';
import { getPalette, colorForIndex, DEFAULT_PALETTE_ID } from '../palettes';
import { LIVE_RETENTION_MAX_MS } from '../hooks/useLiveSeries';
import { resolveLiveRetentionMs } from '../state/liveStore';
import { drawingThemeFor } from '../annotationTheme';
import { effectiveBackground } from '../plotBackground';
import type { Plot } from '../types';
import type { ObjectSchema, Target, ToolContext } from '../workbench/types';
import type { TraceDotState } from '../tools/trace/dots';
import { pvCurveSchema } from '../tools/trace/schema/curve';
import { plotSchema, type TracePlotModel } from '../tools/trace/schema/plot';

// The retention the live path gives a newly watched automatic curve of the
// opening (`useLiveSeries`): derived from the query's range span.
function autoRetention(search: string): number {
  const [plot] = buildInitialPlots(search);
  const trace = plot.traces[0];
  return resolveLiveRetentionMs(trace.liveRetentionMs, undefined, rangeSpanMs(plot.xAxis));
}

const PRESET =
  'pv=TEST:DIAG:BPM:01:POSITION:X&pv=TEST:DIAG:BPM:02:POSITION:X&pv=TEST:DIAG:BPM:03:POSITION:X&range=-1h';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildInitialPlots with the preset query', () => {
  const plots = buildInitialPlots(`?${PRESET}&theme=dark&embedded=true`);

  it('opens one plot with three PV traces on the one axis', () => {
    expect(plots).toHaveLength(1);
    const [plot] = plots;
    expect(plot.id).toBe(INITIAL_PLOT_ID);
    expect(plot.axes.map((a) => a.id)).toEqual([INITIAL_AXIS_ID]);
    expect(plot.traces.map((t) => t.pvName)).toEqual([
      'TEST:DIAG:BPM:01:POSITION:X',
      'TEST:DIAG:BPM:02:POSITION:X',
      'TEST:DIAG:BPM:03:POSITION:X',
    ]);
    expect(plot.traces.map((t) => t.id)).toEqual(['trace-1', 'trace-2', 'trace-3']);
    for (const t of plot.traces) expect(t.axisId).toBe(INITIAL_AXIS_ID);
  });

  it('makes every trace archive + live, with automatic live retention', () => {
    for (const t of plots[0].traces) {
      expect(t.useArchive).toBe(true);
      expect(t.useLive).toBe(true);
      expect(t.liveRetentionMs).toBeUndefined();
      expect(t.kind).toBeUndefined();
      expect(t.data).toEqual([]);
    }
  });

  it('carries the range and colors traces from the palette', () => {
    expect(plots[0].xAxis).toEqual({ timeRange: '-1h' });
    const palette = getPalette(DEFAULT_PALETTE_ID);
    expect(plots[0].traces.map((t) => t.color)).toEqual(
      [0, 1, 2].map((i) => colorForIndex(palette, i))
    );
  });

  it('selects the first trace', () => {
    expect(initialSelection(plots)).toEqual({
      type: 'trace',
      id: 'trace-1',
      plotId: INITIAL_PLOT_ID,
    });
  });
});

describe('buildInitialPlots without PVs', () => {
  for (const [label, search] of [
    ['no query', ''],
    ['only page keys', '?theme=light&embedded=true'],
    ['a range but no PV', '?range=-2h'],
  ] as const) {
    it(`gives one empty plot with one default axis (${label})`, () => {
      const plots = buildInitialPlots(search);
      expect(plots).toHaveLength(1);
      expect(plots[0].id).toBe(INITIAL_PLOT_ID);
      expect(plots[0].traces).toEqual([]);
      expect(plots[0].axes).toHaveLength(1);
      expect(plots[0].axes[0]).toMatchObject({
        id: INITIAL_AXIS_ID,
        orientation: 'left',
        autoScale: true,
      });
      expect(initialSelection(plots)).toEqual({
        type: 'plot',
        id: INITIAL_PLOT_ID,
        plotId: INITIAL_PLOT_ID,
      });
    });
  }

  it('does not warn for an empty query', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildInitialPlots('');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('range span', () => {
  it('uses the relative range', () => {
    expect(rangeSpanMs({ timeRange: '-2h' })).toBe(7_200_000);
    expect(autoRetention('?pv=A:B&range=-30m')).toBe(1_800_000);
  });

  it('uses the custom window span', () => {
    expect(
      rangeSpanMs({ timeRange: 'custom', timeFrom: '2026-01-01T10:00', timeTo: '2026-01-01T12:30' })
    ).toBe(9_000_000);
  });
});

describe('live retention', () => {
  it('is 1800 s at most', () => {
    expect(LIVE_RETENTION_MAX_MS).toBe(1_800_000);
  });

  it('clamps a range longer than the maximum', () => {
    expect(autoRetention('pv=TEST:TEST&range=-1h')).toBe(LIVE_RETENTION_MAX_MS);
  });

  it('keeps a range shorter than the maximum', () => {
    expect(autoRetention('pv=TEST:TEST&range=-10m')).toBe(600_000);
  });

  it('clamps a custom window longer than the maximum', () => {
    expect(
      autoRetention('pv=TEST:TEST&range=custom&from=2026-01-01T10:00&to=2026-01-01T12:30')
    ).toBe(LIVE_RETENTION_MAX_MS);
  });
});

describe('plotQuery', () => {
  it('drops theme and embedded and keeps the rest', () => {
    expect(plotQuery('?theme=dark&pv=A:B&embedded=true&range=-1h')).toBe('pv=A%3AB&range=-1h');
    expect(plotQuery('?embedded=true')).toBe('');
  });

  it('drops the host-bar flag too', () => {
    expect(plotQuery('?embedded=true&hostbar=1&pv=A:B')).toBe('pv=A%3AB');
  });
});

// ------------------------------------------------- optional-automatic dots --

// The field contract the dot tests drive; every FieldDef kind narrows to it.
interface DotField {
  get(ctx: Ctx): unknown;
  set(ctx: Ctx, value: unknown): void;
  modified(ctx: Ctx): boolean;
  reset(ctx: Ctx): void;
}
type Ctx = ToolContext<TraceDotState, TracePlotModel>;

function fieldOf(schema: ObjectSchema<TraceDotState, never>, id: string): DotField {
  for (const tab of schema.tabs) {
    const field = tab.fields.find((f) => f.id === id);
    if (field) return field as unknown as DotField;
  }
  throw new Error(`no field ${id}`);
}

const MODEL: TracePlotModel = {
  palette: getPalette(DEFAULT_PALETTE_ID),
  fragmentInput: (plot: Plot) => ({
    plot,
    archiveResults: new Map(),
    liveResults: new Map(),
    formulaResults: new Map(),
    theme: drawingThemeFor('dark'),
  }),
};

// A ToolContext over a mutable state holder, as the workbench store gives.
function harness(search: string) {
  const holder: { state: TraceDotState } = {
    state: { plots: buildInitialPlots(search), activePlotId: INITIAL_PLOT_ID },
  };
  const ctx = (target: Target): Ctx => ({
    get state() {
      return holder.state;
    },
    model: MODEL,
    update: (fn) => {
      holder.state = fn(holder.state);
    },
    selection: null as never,
    target,
    capabilities: { elog: false },
    ui: {},
  });
  return {
    holder,
    curve: (id: string) => ctx({ level: 'item', kind: 'curve', id }),
    plot: () => ctx({ level: 'tool', kind: 'trace', id: INITIAL_PLOT_ID }),
  };
}

const retention = fieldOf(pvCurveSchema as ObjectSchema<TraceDotState, never>, 'live-retention');
const background = fieldOf(plotSchema as ObjectSchema<TraceDotState, never>, 'plot-background');

describe('optional-automatic retention and background', () => {
  it('a fresh open stamps neither and shows no retention or background dot', () => {
    for (const search of [PRESET, `?${PRESET}&theme=light`, '', '?range=-2h']) {
      const h = harness(search);
      const [plot] = h.holder.state.plots;
      expect(plot).not.toHaveProperty('backgroundColor');
      expect(background.modified(h.plot())).toBe(false);
      for (const t of plot.traces) {
        expect(t).not.toHaveProperty('liveRetentionMs');
        expect(retention.modified(h.curve(t.id))).toBe(false);
        // An empty field: the automatic retention follows the time range.
        expect(retention.get(h.curve(t.id))).toBeNull();
      }
    }
  });

  it('shows the theme default background while automatic', () => {
    const h = harness(PRESET);
    expect(background.get(h.plot())).toBe(drawingThemeFor('dark').bg);
  });

  it('the background field shows the colour the chart draws', () => {
    const h = harness(PRESET);
    // A pinned theme-default literal is snapped to the current theme by the
    // chart (effectiveBackground); the field must not claim otherwise.
    background.set(h.plot(), '#ffffff');
    const drawn = effectiveBackground(
      h.holder.state.plots[0].backgroundColor,
      drawingThemeFor('dark')
    );
    expect(background.get(h.plot())).toBe(drawn);
    background.set(h.plot(), '#123456');
    expect(background.get(h.plot())).toBe('#123456');
  });

  it('editing then resetting the retention writes undefined', () => {
    const h = harness(PRESET);
    retention.set(h.curve('trace-1'), 120);
    expect(h.holder.state.plots[0].traces[0].liveRetentionMs).toBe(120_000);
    expect(retention.modified(h.curve('trace-1'))).toBe(true);

    retention.reset(h.curve('trace-1'));
    const trace = h.holder.state.plots[0].traces[0];
    expect(trace.liveRetentionMs).toBeUndefined();
    expect(retention.modified(h.curve('trace-1'))).toBe(false);
  });

  it('editing then resetting the background writes undefined', () => {
    const h = harness(PRESET);
    background.set(h.plot(), '#123456');
    expect(h.holder.state.plots[0].backgroundColor).toBe('#123456');
    expect(background.modified(h.plot())).toBe(true);
    expect(background.get(h.plot())).toBe('#123456');

    background.reset(h.plot());
    expect(h.holder.state.plots[0].backgroundColor).toBeUndefined();
    expect(background.modified(h.plot())).toBe(false);
    expect(background.get(h.plot())).toBe(drawingThemeFor('dark').bg);
  });

  it('a plot mixing automatic and pinned retention keeps each curve its own', () => {
    const h = harness(`?${PRESET}`.replace('range=-1h', 'range=-10m'));
    retention.set(h.curve('trace-2'), 45);
    const [plot] = h.holder.state.plots;
    const span = rangeSpanMs(plot.xAxis);
    expect(plot.traces.map((t) => t.liveRetentionMs)).toEqual([undefined, 45_000, undefined]);
    expect(plot.traces.map((t) => retention.modified(h.curve(t.id)))).toEqual([false, true, false]);
    // What the live path watches each curve with: the automatic curves derive
    // the range's span (and never lower it), the pinned one keeps its value.
    const watched = plot.traces.map((t) =>
      resolveLiveRetentionMs(t.liveRetentionMs, undefined, span)
    );
    expect(watched).toEqual([600_000, 45_000, 600_000]);
    // Widening then narrowing the range: automatic curves keep the longer
    // window (non-decreasing), the pinned curve stays put.
    const widened = plot.traces.map((t, i) =>
      resolveLiveRetentionMs(t.liveRetentionMs, watched[i], 1_200_000)
    );
    expect(widened).toEqual([1_200_000, 45_000, 1_200_000]);
    const narrowed = plot.traces.map((t, i) =>
      resolveLiveRetentionMs(t.liveRetentionMs, widened[i], 60_000)
    );
    expect(narrowed).toEqual([1_200_000, 45_000, 1_200_000]);
  });
});
