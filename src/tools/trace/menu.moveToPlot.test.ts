// Trace's Move to plot writer (R6 C): the other plots, each disabled with
// `moveToPlotRefusal`'s reason (in its label too, since the menu shows a
// disabled entry's label), running the binding's move. No writer without the
// move, and no entry with no other plot.
import { describe, expect, it, vi } from 'vitest';
import { newFormula, newPlot, newTrace } from '../../embed/plotConfig';
import { resolveMenu, type MenuEnv } from '../../workbench/contextMenu/registry';
import type { Plot, PVTrace } from '../../types';
import type { TraceDotState } from './dots';
import { traceMenuWriters, type TraceMenuInput } from './menu';
import { FORMULA_BINDS_REASON } from './outline';

function plot(id: string, index: number, traces: PVTrace[]): Plot {
  const p = newPlot(id, index);
  return { ...p, traces: traces.map((t) => ({ ...t, axisId: p.axes[0].id })) };
}

const SINE = newTrace('sine', 'TEST:SINE', '', '#0f62fe', []);

function input(state: TraceDotState, moveToPlot?: TraceMenuInput['moveToPlot']): TraceMenuInput {
  return {
    state,
    archiveResultsByPlot: new Map(),
    liveResultsByPlot: new Map(),
    formulaResultsByPlot: new Map(),
    cursorOf: () => undefined,
    moveToPlot,
  };
}

const env = (): MenuEnv => ({ copyText: vi.fn(), copyImage: vi.fn(), showPvInfo: vi.fn() });
const SIGNAL = { id: 'sine', pv: 'TEST:SINE' };

describe('Move to plot writer', () => {
  it('lists the other plots and runs the move', () => {
    const state: TraceDotState = {
      activePlotId: 'p1',
      plots: [plot('p1', 0, [SINE]), plot('p2', 1, []), plot('p3', 2, [])],
    };
    const move = vi.fn();
    const choices = traceMenuWriters(input(state, move)).moveToPlot!(SIGNAL)!;
    expect(choices.map((c) => [c.label, c.disabled])).toEqual([
      ['Plot 2', false],
      ['Plot 3', false],
    ]);
    choices[1].run();
    expect(move).toHaveBeenCalledWith('sine', 'p3');
    const menu = resolveMenu(
      { scope: 'signal', signals: [SIGNAL] },
      traceMenuWriters(input(state, move)),
      env()
    );
    const entry = menu!.groups.flat().find((i) => i.id === 'move-to-plot');
    expect(entry?.label).toBe('Move to plot');
    expect(entry?.children?.map((c) => c.label)).toEqual(['Plot 2', 'Plot 3']);
  });

  it('a plot it cannot go to is disabled with the reason, in its label too', () => {
    const formula: PVTrace = {
      ...newFormula('f1', '', '#ff0000'),
      expression: '{x1}',
      bindings: { x1: 'sine' },
    };
    const state: TraceDotState = {
      activePlotId: 'p1',
      plots: [plot('p1', 0, [SINE, formula]), plot('p2', 1, [])],
    };
    const [entry] = traceMenuWriters(input(state, vi.fn())).moveToPlot!(SIGNAL)!;
    expect(entry.disabled).toBe(FORMULA_BINDS_REASON);
    expect(entry.label).toBe(`Plot 2: ${FORMULA_BINDS_REASON}`);
  });

  it('is left out with no other plot, or without the move', () => {
    const one: TraceDotState = { activePlotId: 'p1', plots: [plot('p1', 0, [SINE])] };
    const menu = resolveMenu(
      { scope: 'signal', signals: [SIGNAL] },
      traceMenuWriters(input(one, vi.fn())),
      env()
    );
    expect(menu!.groups.flat().some((i) => i.id === 'move-to-plot')).toBe(false);
    const two: TraceDotState = {
      activePlotId: 'p1',
      plots: [plot('p1', 0, [SINE]), plot('p2', 1, [])],
    };
    expect(traceMenuWriters(input(two)).moveToPlot!(SIGNAL)).toBeNull();
  });
});
