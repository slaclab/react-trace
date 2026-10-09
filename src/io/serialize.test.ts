import { describe, it, expect } from 'vitest';
import {
  deserializeWorkspace,
  deserializeConfigData,
  serializeWorkspace,
  serializeConfigData,
  SCHEMA_VERSION,
} from './serialize';
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

// A native config `data` object (what magpie stores), not a string.
function nativeWorkspace(plots: unknown[]): Record<string, unknown> {
  return { schemaVersion: SCHEMA_VERSION, theme: 'dark', plots };
}

describe('serialize/deserialize — config store (object form)', () => {
  it('serializeConfigData returns a plain object the store persists as JSON', () => {
    const data = serializeConfigData({ theme: 'dark', plots: [validPlot] });
    expect(typeof data).toBe('object');
    expect(data.schemaVersion).toBe(SCHEMA_VERSION);
    expect(data.plots).toHaveLength(1);
  });

  it('round-trips object → serializeConfigData → deserializeConfigData', () => {
    const data = serializeConfigData({ theme: 'dark', plots: [validPlot] });
    const result = deserializeConfigData(data);
    expect(result.source).toBe('native');
    expect(result.theme).toBe('dark');
    expect(result.plots[0].id).toBe('plot-1');
  });

  it('deserializeWorkspace (string door) delegates to the same logic', () => {
    const json = serializeWorkspace({ theme: 'dark', plots: [validPlot] });
    const result = deserializeWorkspace(json);
    expect(result.source).toBe('native');
    expect(result.plots[0].id).toBe('plot-1');
  });

  it('rejects a non-object config value', () => {
    expect(() => deserializeConfigData(null)).toThrow(/not an object/);
    expect(() => deserializeConfigData('a string')).toThrow(/not an object/);
  });
});

describe('deserializeConfigData — native workspace', () => {
  it('rejects a workspace whose schema is newer than the app', () => {
    const data = { schemaVersion: SCHEMA_VERSION + 1, plots: [validPlot] };
    expect(() => deserializeConfigData(data)).toThrow(/newer than the app/);
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
    // Nested elements: these pass the array check but crash the render path.
    ['null trace', { ...validPlot, traces: [null] }, /traces\[0\] is not an object/],
    ['trace missing id', { ...validPlot, traces: [{}] }, /traces\[0\] is missing an id/],
    [
      'trace with non-array data',
      { ...validPlot, traces: [{ id: 'trace-1', data: 'nope' }] },
      /traces\[0\]\.data is not an array/,
    ],
    [
      'trace with a null data point',
      { ...validPlot, traces: [{ id: 'trace-1', data: [null] }] },
      /traces\[0\]\.data\[0\] is not an object/,
    ],
    ['null axis', { ...validPlot, axes: [null] }, /axes\[0\] is not an object/],
    ['axis missing id', { ...validPlot, axes: [{}] }, /axes\[0\] is missing an id/],
  ])('rejects a native workspace with a %s', (_label, plot, pattern) => {
    expect(() => deserializeConfigData(nativeWorkspace([plot]))).toThrow(pattern as RegExp);
  });

  it('drops an unsupported theme rather than passing it through', () => {
    const data = { schemaVersion: SCHEMA_VERSION, theme: 'sepia', plots: [validPlot] };
    expect(deserializeConfigData(data).theme).toBeUndefined();
    expect(deserializeConfigData({ ...data, theme: 'light' }).theme).toBe('light');
  });

  it('reports the index of the offending plot', () => {
    expect(() => deserializeConfigData(nativeWorkspace([validPlot, {}]))).toThrow(/plots\[1\]/);
  });

  it('accepts a trace with data omitted (rehydratePlot fills it)', () => {
    const plot = { ...validPlot, traces: [{ id: 'trace-1' }] };
    const result = deserializeConfigData(nativeWorkspace([plot]));
    expect(result.plots[0].traces[0].data).toEqual([]);
  });

  // The parse itself allows an empty plot list (applyWorkspace is what refuses
  // it); make sure validation doesn't change that contract.
  it('allows an empty plot list', () => {
    const result = deserializeConfigData(nativeWorkspace([]));
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
