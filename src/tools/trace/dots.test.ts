import { describe, expect, it } from 'vitest';
import { newAxis, newPlot, newTrace, unitAxis } from '../../embed/plotConfig';
import { colorForIndex, getPalette } from '../../palettes';
import type { Plot } from '../../types';
import type { DotProps, Target, ToolContext } from '../../workbench/types';
import { traceCapabilities } from './capabilities';
import {
  activePlot,
  axisLabelDot,
  axisOptional,
  curveColourDot,
  curveOptional,
  plotOptional,
  plotPaletteDot,
  plotTitleDot,
  type TraceDotModel,
  type TraceDotState,
} from './dots';

type State = TraceDotState;
type Model = TraceDotModel;

const PALETTE = getPalette('default');
const OTHER = { id: 'other', label: 'Other', colors: ['#abcdef', '#123456'] };
const MPL = getPalette('matplotlib');

function harness(initial: State, target: Target, model: Model = { palette: PALETTE }) {
  let state = initial;
  let updates = 0;
  const ctx = (t: Target = target): ToolContext<State, Model> => ({
    state,
    model,
    update(fn) {
      updates += 1;
      state = fn(state);
    },
    selection: null,
    target: t,
    capabilities: { elog: false },
    ui: {},
  });
  return {
    ctx,
    state: () => state,
    set: (s: State) => (state = s),
    updates: () => updates,
  };
}

const curve = (id: string): Target => ({ level: 'item', kind: 'pv', id });
const axis = (id: string): Target => ({ level: 'section', kind: 'axis', id });
const tool: Target = { level: 'tool', kind: 'trace', id: 'trace' };

/** A plot at `index` with three curves (palette slots 0..2) and three axes. */
function plotAt(id: string, index: number): Plot {
  const p = newPlot(id, index);
  return {
    ...p,
    axes: [newAxis(`${id}-a1`, 0), unitAxis(`${id}-a2`, 1, 'mA'), newAxis(`${id}-a3`, 2)],
    traces: [0, 1, 2].map((i) =>
      newTrace(`${id}-c${i}`, `PV:${id}:${i}`, `${id}-a1`, colorForIndex(PALETTE, i), [])
    ),
  };
}

const workspace = (): State => ({
  plots: [plotAt('p1', 0), plotAt('p2', 1), plotAt('p3', 2)],
  activePlotId: 'p1',
});

const plotOf = (s: State, id: string) => s.plots.find((p) => p.id === id)!;
const removeCurve = (s: State, plotId: string, id: string): State => ({
  ...s,
  plots: s.plots.map((p) =>
    p.id === plotId ? { ...p, traces: p.traces.filter((t) => t.id !== id) } : p
  ),
});
const removeAxis = (s: State, plotId: string, id: string): State => ({
  ...s,
  plots: s.plots.map((p) =>
    p.id === plotId ? { ...p, axes: p.axes.filter((a) => a.id !== id) } : p
  ),
});
const patchCurve = (s: State, id: string, color: string): State => ({
  ...s,
  plots: s.plots.map((p) => ({
    ...p,
    traces: p.traces.map((t) => (t.id === id ? { ...t, color } : t)),
  })),
});
const patchAxisName = (s: State, id: string, name: string): State => ({
  ...s,
  plots: s.plots.map((p) => ({
    ...p,
    axes: p.axes.map((a) => (a.id === id ? { ...a, name } : a)),
  })),
});
const patchPlot = (s: State, id: string, patch: Partial<Plot>): State => ({
  ...s,
  plots: s.plots.map((p) => (p.id === id ? { ...p, ...patch } : p)),
});

describe('curve colour (stamped value)', () => {
  const dot = curveColourDot<State, Model>();

  it('a palette colour is not pinned; any other colour is', () => {
    const h = harness(workspace(), curve('p1-c1'));
    expect(dot.modified(h.ctx())).toBe(false);
    h.set(patchCurve(h.state(), 'p1-c1', '#ff00ff'));
    expect(dot.modified(h.ctx())).toBe(true);
  });

  it("a different slot's palette colour is still automatic (membership, not slot)", () => {
    const h = harness(patchCurve(workspace(), 'p1-c1', colorForIndex(PALETTE, 4)), curve('p1-c1'));
    expect(dot.modified(h.ctx())).toBe(false);
  });

  it('membership ignores hex case', () => {
    const h = harness(
      patchCurve(workspace(), 'p1-c1', colorForIndex(PALETTE, 1).toLowerCase()),
      curve('p1-c1')
    );
    expect(dot.modified(h.ctx())).toBe(false);
  });

  it('picking the palette colour clears the dot', () => {
    const h = harness(patchCurve(workspace(), 'p1-c2', '#ff00ff'), curve('p1-c2'));
    expect(dot.modified(h.ctx())).toBe(true);
    h.set(patchCurve(h.state(), 'p1-c2', PALETTE.colors[0]));
    expect(dot.modified(h.ctx())).toBe(false);
  });

  it('is judged against the palette of the plot holding the curve, not the model', () => {
    // The model palette plays no part.
    const h = harness(workspace(), curve('p1-c0'), { palette: OTHER });
    expect(dot.modified(h.ctx())).toBe(false);
    // A default-palette colour is user-set on a plot in another palette...
    h.set(patchPlot(h.state(), 'p1', { palette: MPL.id }));
    expect(dot.modified(h.ctx())).toBe(true);
    // ...and that palette's own colours are automatic there.
    h.set(patchCurve(h.state(), 'p1-c0', colorForIndex(MPL, 3)));
    expect(dot.modified(h.ctx())).toBe(false);
    // Another plot still judges by the default.
    expect(dot.modified(h.ctx(curve('p2-c0')))).toBe(false);
  });

  it('reset writes the colour of the plot palette at the curve position', () => {
    const h = harness(
      patchCurve(patchPlot(workspace(), 'p2', { palette: MPL.id }), 'p2-c1', '#ff00ff'),
      curve('p2-c1')
    );
    dot.reset(h.ctx());
    expect(plotOf(h.state(), 'p2').traces[1].color).toBe(colorForIndex(MPL, 1));
  });

  it('reset writes the palette colour at the curve position', () => {
    const h = harness(patchCurve(workspace(), 'p2-c2', '#ff00ff'), curve('p2-c2'));
    dot.reset(h.ctx());
    expect(h.updates()).toBe(1);
    expect(plotOf(h.state(), 'p2').traces[2].color).toBe(colorForIndex(PALETTE, 2));
    expect(dot.modified(h.ctx())).toBe(false);
    // Nothing else moved.
    expect(plotOf(h.state(), 'p1')).toEqual(plotOf(workspace(), 'p1'));
  });

  it('deleting the first curve lights no dot on the others', () => {
    const h = harness(removeCurve(workspace(), 'p1', 'p1-c0'), curve('p1-c1'));
    expect(dot.modified(h.ctx(curve('p1-c1')))).toBe(false);
    expect(dot.modified(h.ctx(curve('p1-c2')))).toBe(false);
  });

  it('an unknown curve is never pinned and its reset writes nothing', () => {
    const h = harness(workspace(), curve('nope'));
    expect(dot.modified(h.ctx())).toBe(false);
    const before = h.state();
    dot.reset(h.ctx());
    expect(h.state()).toBe(before);
  });
});

describe('axis Label (stamped value)', () => {
  const dot = axisLabelDot<State, Model>();

  it('`Y-Axis <n>` and the stamped units are automatic; anything else is pinned', () => {
    const h = harness(workspace(), axis('p1-a1'));
    expect(dot.modified(h.ctx(axis('p1-a1')))).toBe(false);
    expect(dot.modified(h.ctx(axis('p1-a2')))).toBe(false); // name = units = 'mA'
    h.set(patchAxisName(h.state(), 'p1-a1', 'Current'));
    expect(dot.modified(h.ctx(axis('p1-a1')))).toBe(true);
    h.set(patchAxisName(h.state(), 'p1-a2', 'Beam'));
    expect(dot.modified(h.ctx(axis('p1-a2')))).toBe(true);
  });

  it('a `Y-Axis <n>` of another slot is still automatic', () => {
    const h = harness(patchAxisName(workspace(), 'p1-a3', 'Y-Axis 7'), axis('p1-a3'));
    expect(dot.modified(h.ctx())).toBe(false);
  });

  it('reset writes axis.units when stamped', () => {
    const h = harness(patchAxisName(workspace(), 'p1-a2', 'Beam'), axis('p1-a2'));
    dot.reset(h.ctx());
    expect(plotOf(h.state(), 'p1').axes[1].name).toBe('mA');
    expect(dot.modified(h.ctx())).toBe(false);
  });

  it('reset writes `Y-Axis <n>` at the axis position otherwise', () => {
    const h = harness(patchAxisName(workspace(), 'p1-a3', 'Custom'), axis('p1-a3'));
    dot.reset(h.ctx());
    expect(plotOf(h.state(), 'p1').axes[2].name).toBe('Y-Axis 3');
    expect(dot.modified(h.ctx())).toBe(false);
  });

  it('deleting the first axis lights no dot on the others', () => {
    const h = harness(removeAxis(workspace(), 'p1', 'p1-a1'), axis('p1-a2'));
    expect(dot.modified(h.ctx(axis('p1-a2')))).toBe(false);
    expect(dot.modified(h.ctx(axis('p1-a3')))).toBe(false);
  });
});

describe('plot Title (stamped value)', () => {
  const dot = plotTitleDot<State, Model>();

  it('`Plot <n>` is automatic; anything else is pinned', () => {
    const h = harness(workspace(), tool);
    expect(dot.modified(h.ctx())).toBe(false);
    h.set(patchPlot(h.state(), 'p1', { title: 'Orbit' }));
    expect(dot.modified(h.ctx())).toBe(true);
  });

  it('binds to the active plot at tool level', () => {
    const h = harness(patchPlot(workspace(), 'p2', { title: 'Orbit' }), tool);
    expect(dot.modified(h.ctx())).toBe(false);
    h.set({ ...h.state(), activePlotId: 'p2' });
    expect(dot.modified(h.ctx())).toBe(true);
    dot.reset(h.ctx());
    expect(plotOf(h.state(), 'p2').title).toBe('Plot 2');
    expect(plotOf(h.state(), 'p1').title).toBe('Plot 1');
  });

  it('reset writes `Plot <n>` at the plot position', () => {
    const h = harness(
      { ...patchPlot(workspace(), 'p3', { title: 'Orbit' }), activePlotId: 'p3' },
      tool
    );
    dot.reset(h.ctx());
    expect(plotOf(h.state(), 'p3').title).toBe('Plot 3');
    expect(dot.modified(h.ctx())).toBe(false);
  });

  it('deleting the first plot lights no dot on the others', () => {
    const s = workspace();
    const h = harness({ plots: s.plots.slice(1), activePlotId: 'p2' }, tool);
    expect(dot.modified(h.ctx())).toBe(false);
    h.set({ ...h.state(), activePlotId: 'p3' });
    expect(dot.modified(h.ctx())).toBe(false);
  });

  it('falls back to the first plot when the active id is stale', () => {
    expect(activePlot({ plots: workspace().plots, activePlotId: 'gone' })?.id).toBe('p1');
  });
});

describe('optional paths', () => {
  it('curve: pinned iff present, reset writes undefined', () => {
    const dot = curveOptional<State, Model>('liveRetentionMs');
    const h = harness(workspace(), curve('p1-c1'));
    expect(dot.modified(h.ctx())).toBe(false);
    h.set({
      ...h.state(),
      plots: h.state().plots.map((p) => ({
        ...p,
        traces: p.traces.map((t) => (t.id === 'p1-c1' ? { ...t, liveRetentionMs: 60_000 } : t)),
      })),
    });
    expect(dot.modified(h.ctx())).toBe(true);
    dot.reset(h.ctx());
    expect(plotOf(h.state(), 'p1').traces[1].liveRetentionMs).toBeUndefined();
    expect(dot.modified(h.ctx())).toBe(false);
  });

  it('axis: pinned iff present, reset writes undefined', () => {
    const dot = axisOptional<State, Model>('units');
    const h = harness(workspace(), axis('p1-a2'));
    expect(dot.modified(h.ctx())).toBe(true);
    dot.reset(h.ctx());
    expect(plotOf(h.state(), 'p1').axes[1].units).toBeUndefined();
    expect(dot.modified(h.ctx())).toBe(false);
  });

  it('plot: pinned iff present on the active plot, reset writes undefined', () => {
    const dot = plotOptional<State, Model>('archiver');
    const h = harness(patchPlot(workspace(), 'p1', { archiver: 'arch-2' }), tool);
    expect(dot.modified(h.ctx())).toBe(true);
    dot.reset(h.ctx());
    expect(plotOf(h.state(), 'p1').archiver).toBeUndefined();
    expect(dot.modified(h.ctx())).toBe(false);
  });

  it('only accepts optional keys', () => {
    // @ts-expect-error `color` is required: a stamped value, not an optional path.
    curveOptional<State, Model>('color');
    // @ts-expect-error `orientation` (Side) has no automatic rule and no dot.
    axisOptional<State, Model>('orientation');
    // @ts-expect-error `title` is a stamped value.
    plotOptional<State, Model>('title');
  });
});

describe('plot Palette (optional path)', () => {
  const dot = plotPaletteDot<State, Model>();

  it('is pinned iff the bound plot states a palette', () => {
    const h = harness(workspace(), tool);
    expect(dot.modified(h.ctx())).toBe(false);
    h.set(patchPlot(h.state(), 'p1', { palette: MPL.id }));
    expect(dot.modified(h.ctx())).toBe(true);
    // Bound to the active plot unless the target names one.
    expect(dot.modified(h.ctx({ ...tool, id: 'p2' }))).toBe(false);
  });

  it('reset returns to the default palette, moving palette colours back by slot', () => {
    const start = patchPlot(workspace(), 'p1', {
      palette: MPL.id,
      traces: plotOf(workspace(), 'p1').traces.map((t, i) => ({
        ...t,
        color: i === 2 ? '#ff00ff' : colorForIndex(MPL, i + 1),
      })),
    });
    const h = harness(start, tool);
    dot.reset(h.ctx());
    expect(h.updates()).toBe(1);
    const p1 = plotOf(h.state(), 'p1');
    expect(p1.palette).toBeUndefined();
    expect('palette' in p1).toBe(false);
    expect(p1.traces.map((t) => t.color)).toEqual([
      colorForIndex(PALETTE, 1),
      colorForIndex(PALETTE, 2),
      '#ff00ff',
    ]);
    expect(dot.modified(h.ctx())).toBe(false);
    expect(plotOf(h.state(), 'p2')).toEqual(plotOf(workspace(), 'p2'));
  });
});

describe('dot shape', () => {
  it('every builder satisfies DotProps', () => {
    const dots: DotProps<State, Model, object>[] = [
      curveColourDot<State, Model>(),
      axisLabelDot<State, Model>(),
      plotTitleDot<State, Model>(),
      curveOptional<State, Model>('archiver'),
    ];
    for (const d of dots) {
      expect(typeof d.modified).toBe('function');
      expect(typeof d.reset).toBe('function');
    }
  });
});

describe('traceCapabilities', () => {
  it('elog passes through', () => {
    expect(traceCapabilities({ elog: true })).toEqual({ elog: true });
    expect(traceCapabilities({ elog: false })).toEqual({ elog: false });
  });
});
