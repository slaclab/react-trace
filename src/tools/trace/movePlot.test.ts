// Moving a curve to another plot (R6): `moveCurveToPlot` and its refusals,
// shared by the drop on a plot's tab or grid cell (`ops.drop`).
//
// Landing follows the unit lookup's rule (`assignCurveToUnitAxis`): the
// target's axis with the source axis's unit, else a new axis with that unit,
// else the target's first axis. The curve keeps its id and every setting; a
// colour still on the source palette takes the target palette's slot for its
// new position, a user-set colour stays. A formula binding or an attached
// drawing refuses the move.
import { describe, expect, it } from 'vitest';
import { newAxis, newFormula, newPlot, newTrace } from '../../embed/plotConfig';
import { colorForIndex, getPalette, DEFAULT_PALETTE_ID } from '../../palettes';
import type { Annotation } from '../../annotations/model';
import type { Axis, Plot, PVTrace } from '../../types';
import type { TraceDotState } from './dots';
import {
  DRAWING_ATTACHED_REASON,
  FORMULA_BINDINGS_REASON,
  FORMULA_BINDS_REASON,
  SAME_PLOT_REASON,
  UNKNOWN_CURVE_REASON,
  UNKNOWN_PLOT_REASON,
  moveCurveToPlot,
  moveToPlotRefusal,
} from './outline';

const DEF = getPalette(DEFAULT_PALETTE_ID);
const VIRIDIS = getPalette('viridis');

function axis(id: string, index: number, patch: Partial<Axis> = {}): Axis {
  return { ...newAxis(id, index), ...patch };
}

function curve(id: string, pv: string, axisId: string, patch: Partial<PVTrace> = {}): PVTrace {
  return { ...newTrace(id, pv, axisId, colorForIndex(DEF, 0), []), ...patch };
}

function plot(id: string, index: number, patch: Partial<Plot>): Plot {
  return { ...newPlot(id, index), ...patch };
}

/** Plot 1 holds TEST:SINE on a mA axis and TEST:FAST on a unitless one. */
function state(target: Partial<Plot> = {}, source: Partial<Plot> = {}): TraceDotState {
  return {
    activePlotId: 'p1',
    plots: [
      plot('p1', 0, {
        axes: [axis('a1', 0), axis('a2', 1, { name: 'mA', units: 'mA' })],
        traces: [
          curve('sine', 'TEST:SINE', 'a2', { color: colorForIndex(DEF, 0) }),
          curve('fast', 'TEST:FAST', 'a1', { color: colorForIndex(DEF, 1) }),
        ],
        ...source,
      }),
      plot('p2', 1, {
        axes: [axis('b1', 0)],
        traces: [curve('const', 'TEST:CONST', 'b1', { color: colorForIndex(DEF, 0) })],
        ...target,
      }),
    ],
  };
}

const plotOf = (s: TraceDotState, id: string) => s.plots.find((p) => p.id === id)!;
const curveIn = (s: TraceDotState, plotId: string, id: string) =>
  plotOf(s, plotId).traces.find((t) => t.id === id);

describe('moveCurveToPlot: landing', () => {
  it("onto the target's axis with the source axis's unit", () => {
    const s = state({ axes: [axis('b1', 0), axis('b2', 1, { name: 'Current', units: 'mA' })] });
    const next = moveCurveToPlot(s, 'sine', 'p2', 'new-axis');
    expect(curveIn(next, 'p1', 'sine')).toBeUndefined();
    expect(curveIn(next, 'p2', 'sine')?.axisId).toBe('b2');
    expect(plotOf(next, 'p2').axes.map((a) => a.id)).toEqual(['b1', 'b2']);
  });

  it('onto a new axis with that unit when the target has none', () => {
    const next = moveCurveToPlot(state(), 'sine', 'p2', 'new-axis');
    expect(curveIn(next, 'p2', 'sine')?.axisId).toBe('new-axis');
    const added = plotOf(next, 'p2').axes.find((a) => a.id === 'new-axis');
    expect(added).toMatchObject({ units: 'mA', name: 'mA' });
  });

  it("onto the target's first axis when the source axis has no unit", () => {
    const next = moveCurveToPlot(state(), 'fast', 'p2', 'new-axis');
    expect(curveIn(next, 'p2', 'fast')?.axisId).toBe('b1');
    expect(plotOf(next, 'p2').axes.map((a) => a.id)).toEqual(['b1']);
  });

  it('keeps the id and every per-curve setting, appended to the target', () => {
    const s = state(
      {},
      {
        traces: [
          curve('sine', 'TEST:SINE', 'a1', {
            archiver: 'arch-b',
            lineWidth: 3,
            lineType: 'direct',
            liveRetentionMs: 60_000,
            showArchiveBand: false,
            breakOnGaps: true,
            displayName: 'Sine',
          }),
        ],
      }
    );
    const before = curveIn(s, 'p1', 'sine')!;
    const next = moveCurveToPlot(s, 'sine', 'p2', 'new-axis');
    expect(plotOf(next, 'p2').traces.map((t) => t.id)).toEqual(['const', 'sine']);
    // Its palette colour takes the target's slot 1 (it lands second).
    expect(curveIn(next, 'p2', 'sine')).toEqual({
      ...before,
      axisId: 'b1',
      color: colorForIndex(DEF, 1),
    });
    // The other plot and the active plot are untouched.
    expect(next.activePlotId).toBe('p1');
  });
});

describe('moveCurveToPlot: colour', () => {
  it("a palette colour takes the target palette's slot for its new position", () => {
    const next = moveCurveToPlot(state({ palette: 'viridis' }), 'fast', 'p2', 'x');
    // Appended after one curve: slot 1 of the target's palette.
    expect(curveIn(next, 'p2', 'fast')?.color).toBe(colorForIndex(VIRIDIS, 1));
  });

  it('a user-set colour travels', () => {
    const s = state(
      { palette: 'viridis' },
      {
        traces: [curve('fast', 'TEST:FAST', 'a1', { color: '#123456' })],
      }
    );
    expect(curveIn(moveCurveToPlot(s, 'fast', 'p2', 'x'), 'p2', 'fast')?.color).toBe('#123456');
  });
});

describe('moveToPlotRefusal', () => {
  it('allows another plot; refuses its own, an unknown plot or curve', () => {
    const s = state();
    expect(moveToPlotRefusal(s, 'sine', 'p2')).toBeNull();
    expect(moveToPlotRefusal(s, 'sine', 'p1')).toBe(SAME_PLOT_REASON);
    expect(moveToPlotRefusal(s, 'sine', 'nope')).toBe(UNKNOWN_PLOT_REASON);
    expect(moveToPlotRefusal(s, 'nope', 'p2')).toBe(UNKNOWN_CURVE_REASON);
  });

  it('refuses a curve a formula on its plot uses, and a formula with bindings', () => {
    const formula: PVTrace = {
      ...newFormula('f1', 'a1', colorForIndex(DEF, 2)),
      expression: '{x1} * 2',
      bindings: { x1: 'sine' },
    };
    const s = state({}, { traces: [...state().plots[0].traces, formula] });
    expect(moveToPlotRefusal(s, 'sine', 'p2')).toBe(FORMULA_BINDS_REASON);
    expect(moveToPlotRefusal(s, 'f1', 'p2')).toBe(FORMULA_BINDINGS_REASON);
    expect(moveToPlotRefusal(s, 'fast', 'p2')).toBeNull();
    expect(moveCurveToPlot(s, 'sine', 'p2', 'x')).toBe(s);
  });

  it('refuses a curve with a drawing attached to it', () => {
    const note = { id: 'd1', kind: 'note', axisId: 'a1', traceId: 'fast' } as unknown as Annotation;
    const s = state({}, { annotations: [note] });
    expect(moveToPlotRefusal(s, 'fast', 'p2')).toBe(DRAWING_ATTACHED_REASON);
    expect(moveToPlotRefusal(s, 'sine', 'p2')).toBeNull();
    expect(moveCurveToPlot(s, 'fast', 'p2', 'x')).toBe(s);
  });
});
