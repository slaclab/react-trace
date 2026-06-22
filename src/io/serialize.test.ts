import { describe, it, expect } from 'vitest';
import { deserializeWorkspace } from './serialize';

// Minimal legacy .trc shaped after trace/examples/FormulaExample.trc. No
// time_axis, so the only warnings exercised are formula-binding ones.
function trcWithFormula(curveDict: Record<string, string>): string {
  return JSON.stringify({
    plot: { title: 'T' },
    'y-axes': [{ name: 'Axis 1', orientation: 'left' }],
    curves: [
      { channel: 'TEST:SINE', name: 'A', yAxisName: 'Axis 1' },
      { channel: 'TEST:COUNTER', name: 'B', yAxisName: 'Axis 1' },
    ],
    formula: [
      {
        formula: 'f://{x1}+{x2}',
        curveDict,
        name: 'f://{x1}+{x2}',
        color: '#b80058',
        yAxisName: 'Axis 1',
      },
    ],
  });
}

describe('deserializeWorkspace — legacy .trc formula import', () => {
  it('imports a formula curve and resolves bindings to base curves', () => {
    const result = deserializeWorkspace(
      trcWithFormula({ x1: 'TEST:SINE', x2: 'TEST:COUNTER' })
    );
    const traces = result.plots[0].traces;
    expect(traces).toHaveLength(3);

    const formula = traces.find((t) => t.kind === 'formula');
    expect(formula).toBeDefined();
    // f:// is stripped from both the expression and the display name.
    expect(formula!.expression).toBe('{x1}+{x2}');
    expect(formula!.displayName).toBe('{x1}+{x2}');
    expect(formula!.useArchive).toBe(false);

    // Each variable binds to the base curve carrying that PV.
    const a = traces.find((t) => t.pvName === 'TEST:SINE')!;
    const b = traces.find((t) => t.pvName === 'TEST:COUNTER')!;
    expect(formula!.bindings).toEqual({ x1: a.id, x2: b.id });
    expect(result.warnings).toHaveLength(0);
  });

  it('warns and omits a binding when a variable references a PV not on the plot', () => {
    const result = deserializeWorkspace(
      trcWithFormula({ x1: 'TEST:SINE', x2: 'NOT:ON:PLOT' })
    );
    const traces = result.plots[0].traces;
    const formula = traces.find((t) => t.kind === 'formula')!;
    const a = traces.find((t) => t.pvName === 'TEST:SINE')!;

    expect(formula.bindings).toEqual({ x1: a.id }); // x2 dropped
    expect(result.warnings.some((w) => w.includes('could not bind'))).toBe(true);
  });
});
