import { describe, it, expect } from 'vitest';
import { deserializeWorkspace, serializeWorkspace, SCHEMA_VERSION } from './serialize';
import type { Plot } from '../types';

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

// A minimal but complete native plot — the fields assertPlotShape requires plus
// enough for rehydratePlot. Spread + override to produce malformed variants.
const validPlot: Plot = {
  id: 'plot-1',
  title: 'T',
  traces: [],
  axes: [],
  backgroundColor: '#161616',
  showLegend: true,
  showXGridlines: true,
  showYGridlines: true,
  showCrosshair: true,
  gridStyle: 'solid',
  gridOpacity: 1,
  tickFontSize: 11,
  xAxis: { timeRange: '-1h' },
};

function nativeWorkspace(plots: unknown[]): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, theme: 'dark', plots });
}

describe('deserializeWorkspace — native workspace', () => {
  it('round-trips a serialized workspace', () => {
    const json = serializeWorkspace({ theme: 'dark', plots: [validPlot] });
    const result = deserializeWorkspace(json);
    expect(result.source).toBe('native');
    expect(result.theme).toBe('dark');
    expect(result.plots).toHaveLength(1);
    expect(result.plots[0].id).toBe('plot-1');
  });

  it('rejects a workspace whose schema is newer than the app', () => {
    const json = JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, plots: [validPlot] });
    expect(() => deserializeWorkspace(json)).toThrow(/newer than the app/);
  });

  // A malformed plot would otherwise pass the cast and crash the render body
  // (resolveTimeWindow(plot.xAxis), plot.traces.filter). Reachable from a
  // hand-edited ?config= share link, so each load-bearing field is guarded.
  it.each([
    ['empty object', {}, /missing an id/],
    ['missing id', { ...validPlot, id: undefined }, /missing an id/],
    ['non-string id', { ...validPlot, id: 42 }, /missing an id/],
    ['missing xAxis', { ...validPlot, xAxis: undefined }, /missing xAxis\.timeRange/],
    ['xAxis without timeRange', { ...validPlot, xAxis: {} }, /missing xAxis\.timeRange/],
    ['non-array traces', { ...validPlot, traces: 'nope' }, /traces is not an array/],
    ['non-array axes', { ...validPlot, axes: null }, /axes is not an array/],
    ['null plot', null, /is not an object/],
  ])('rejects a native workspace with a %s', (_label, plot, pattern) => {
    expect(() => deserializeWorkspace(nativeWorkspace([plot]))).toThrow(pattern as RegExp);
  });

  it('reports the index of the offending plot', () => {
    expect(() => deserializeWorkspace(nativeWorkspace([validPlot, {}]))).toThrow(/plots\[1\]/);
  });

  // deserializeWorkspace itself allows an empty plot list (applyWorkspace is
  // what refuses it); make sure validation doesn't change that contract.
  it('allows an empty plot list', () => {
    const result = deserializeWorkspace(nativeWorkspace([]));
    expect(result.plots).toEqual([]);
  });
});

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
