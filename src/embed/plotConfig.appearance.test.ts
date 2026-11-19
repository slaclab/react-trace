// Two Display toggles: "Pin data window" (off by default, only `true` stored)
// fixes the hover tooltip at the plot's top-right instead of following the
// cursor; "Status line" (on by default, only `false`
// stored). Both are plot-class keys that round-trip through `plot=`, and
// neither is written while at its default.
import { describe, expect, it } from 'vitest';
import type { Axis, Plot, PVTrace } from '../types';
import { drawingThemeFor } from '../annotationTheme';
import { buildPlotOption } from '../components/plotOption';
import { applyPlotConfig, newTrace, parsePlotConfig, plotConfigOf } from './plotConfig';
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
const palette = getPalette(DEFAULT_PALETTE_ID);

function plotWith(over: Partial<Plot> = {}): Plot {
  const trace: PVTrace = newTrace('t1', 'TEST:BEAM:I', AXIS.id, '#0f62fe', []);
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
    ...over,
  };
}

function toggle(id: string) {
  const field = plotSchema.tabs.find((t) => t.id === 'display')?.fields.find((f) => f.id === id) as
    | FieldDef<TraceDotState, TracePlotModel>
    | undefined;
  expect(field).toBeDefined();
  expect(field?.kind).toBe('toggle');
  expect(field?.level).toBe('L2');
  const plot = plotWith();
  const holder = { state: { plots: [plot], activePlotId: plot.id } as TraceDotState };
  const ctx = {
    get state() {
      return holder.state;
    },
    model: {} as TracePlotModel,
    update: (fn: (s: TraceDotState) => TraceDotState) => {
      holder.state = fn(holder.state);
    },
    selection: null,
    target: { level: 'tool', kind: 'trace', id: plot.id },
    capabilities: {},
    ui: {},
  } as unknown as ToolContext<TraceDotState, TracePlotModel>;
  const t = field as unknown as {
    get: (c: typeof ctx) => boolean;
    set: (c: typeof ctx, v: boolean) => void;
  };
  return {
    get: () => t.get(ctx),
    set: (v: boolean) => t.set(ctx, v),
    plot: () => holder.state.plots[0],
  };
}

function option(plot: Plot) {
  return buildPlotOption({
    plot,
    archiveResults: new Map(),
    liveResults: new Map(),
    formulaResults: new Map(),
    theme: drawingThemeFor('dark'),
    width: 800,
  } as unknown as Parameters<typeof buildPlotOption>[0]);
}

type PositionFn = (
  point: [number, number],
  params: unknown,
  dom: unknown,
  rect: unknown,
  size: { contentSize: [number, number]; viewSize: [number, number] }
) => [number, number];

describe('pin data window', () => {
  it('the toggle reads off and stores only true', () => {
    const t = toggle('pin-data-window');
    expect(t.get()).toBe(false);
    t.set(true);
    expect(t.plot().pinDataWindow).toBe(true);
    expect(t.get()).toBe(true);
    t.set(false);
    expect(t.plot().pinDataWindow).toBeUndefined();
    expect(t.plot()).not.toHaveProperty('pinDataWindow', false);
  });

  it('is classed as a plot key', () => {
    expect(TRACE_FIELD_TABLE['pin-data-window']).toEqual({
      class: 'plot',
      scope: 'plot',
      key: 'pinDataWindow',
    });
  });

  it('round-trips through plot= only when on', () => {
    const off = plotWith();
    expect(plotConfigOf(off, palette)?.pinDataWindow).toBeUndefined();
    expect(plotConfigOf({ ...off, pinDataWindow: false }, palette)?.pinDataWindow).toBeUndefined();
    const config = plotConfigOf({ ...off, pinDataWindow: true }, palette);
    expect(config?.pinDataWindow).toBe(true);
    const parsed = parsePlotConfig(JSON.stringify(config));
    expect(parsed?.pinDataWindow).toBe(true);
    expect(applyPlotConfig(off, parsed!).pinDataWindow).toBe(true);
  });

  it('rejects a non-boolean value on read', () => {
    const config = { ...plotConfigOf(plotWith(), palette), pinDataWindow: 'yes' };
    const parsed = parsePlotConfig(JSON.stringify(config));
    expect(parsed?.pinDataWindow).toBeUndefined();
  });

  it('unpinned: the tooltip follows the cursor (no fixed position)', () => {
    const tooltip = option(plotWith()).tooltip as { position?: unknown };
    expect(tooltip.position).toBeUndefined();
  });

  it("pinned: the tooltip sits at the grid's top-right wherever the cursor is", () => {
    const tooltip = option(plotWith({ pinDataWindow: true })).tooltip as {
      position?: PositionFn;
    };
    expect(typeof tooltip.position).toBe('function');
    const size = {
      contentSize: [150, 60] as [number, number],
      viewSize: [800, 400] as [number, number],
    };
    const a = tooltip.position!([100, 120], [], null, null, size);
    const b = tooltip.position!([600, 300], [], null, null, size);
    expect(a).toEqual(b);
    // One left axis: grid right inset 20 px, grid top 40 px (plotLayout).
    expect(a[0] + size.contentSize[0]).toBeLessThanOrEqual(800 - 20);
    expect(a[0] + size.contentSize[0]).toBeGreaterThan(800 - 20 - 20);
    expect(a[1]).toBeGreaterThanOrEqual(40);
    expect(a[1]).toBeLessThan(40 + 20);
  });

  it('pinned: a tooltip wider than the view never leaves the left edge', () => {
    const tooltip = option(plotWith({ pinDataWindow: true })).tooltip as {
      position?: PositionFn;
    };
    const [x] = tooltip.position!([10, 10], [], null, null, {
      contentSize: [2000, 60],
      viewSize: [800, 400],
    });
    expect(x).toBeGreaterThanOrEqual(0);
  });
});

describe('status line', () => {
  it('the toggle reads on and stores only false', () => {
    const t = toggle('show-status-line');
    expect(t.get()).toBe(true);
    t.set(false);
    expect(t.plot().showStatusLine).toBe(false);
    expect(t.get()).toBe(false);
    t.set(true);
    expect(t.plot().showStatusLine).toBeUndefined();
  });

  it('is classed as a plot key', () => {
    expect(TRACE_FIELD_TABLE['show-status-line']).toEqual({
      class: 'plot',
      scope: 'plot',
      key: 'showStatusLine',
    });
  });

  it('round-trips through plot= only when off', () => {
    const on = plotWith();
    expect(plotConfigOf(on, palette)?.showStatusLine).toBeUndefined();
    expect(plotConfigOf({ ...on, showStatusLine: true }, palette)?.showStatusLine).toBeUndefined();
    const config = plotConfigOf({ ...on, showStatusLine: false }, palette);
    expect(config?.showStatusLine).toBe(false);
    const parsed = parsePlotConfig(JSON.stringify(config));
    expect(parsed?.showStatusLine).toBe(false);
    expect(applyPlotConfig(on, parsed!).showStatusLine).toBe(false);
  });

  it('both keys survive one round trip together', () => {
    const plot = plotWith({ pinDataWindow: true, showStatusLine: false });
    const parsed = parsePlotConfig(JSON.stringify(plotConfigOf(plot, palette)));
    const back = applyPlotConfig(plotWith(), parsed!);
    expect(back.pinDataWindow).toBe(true);
    expect(back.showStatusLine).toBe(false);
  });
});
