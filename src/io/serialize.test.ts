import { describe, it, expect } from 'vitest';
import {
  deserializeWorkspace,
  deserializeConfigData,
  LIVE_RETENTION_PIN_KEY,
  serializeWorkspace,
  serializeConfigData,
  SCHEMA_VERSION,
} from './serialize';
import type { Plot, PVTrace } from '../types';
import { getPalette, paletteSlot, colorForIndex } from '../palettes';
import typesSource from '../types.ts?raw';

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
      'formula trace with a non-string expression',
      { ...validPlot, traces: [{ id: 'formula-1', kind: 'formula', expression: {} }] },
      /traces\[0\]\.expression must be a string/,
    ],
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
    [
      'trace with a non-numeric data point value',
      { ...validPlot, traces: [{ id: 'trace-1', data: [{ time: 1, value: '<img>' }] }] },
      /traces\[0\]\.data\[0\]\.value must be a finite number/,
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

  it('rejects duplicate plot ids', () => {
    expect(() => deserializeConfigData(nativeWorkspace([validPlot, validPlot]))).toThrow(
      /duplicate plot id 'plot-1'/
    );
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
    const result = deserializeWorkspace(trcWithFormula({ x1: 'TEST:SINE', x2: 'TEST:COUNTER' }));
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
    const result = deserializeWorkspace(trcWithFormula({ x1: 'TEST:SINE', x2: 'NOT:ON:PLOT' }));
    const traces = result.plots[0].traces;
    const formula = traces.find((t) => t.kind === 'formula')!;
    const a = traces.find((t) => t.pvName === 'TEST:SINE')!;

    expect(formula.bindings).toEqual({ x1: a.id }); // x2 dropped
    expect(result.warnings.some((w) => w.includes('could not bind'))).toBe(true);
  });
});

// ------------------------------------------------- automatic-value rules ---

// Frozen copies of the pre-workbench reader and writer (base sha 457038b,
// src/io/serialize.ts `rehydratePlot` and `stripTraceData`), so the tests show
// what an older Trace does with a file this one writes. Do not "update" these.
function baseRehydratePlot(p: Plot): Plot {
  const legacy = p as Plot & { showGridlines?: boolean };
  const xAxis = p.xAxis?.timeRange === '-1m' ? { ...p.xAxis, timeRange: '-1M' } : p.xAxis;
  return {
    ...p,
    xAxis,
    showLegend: p.showLegend ?? true,
    showCrosshair: p.showCrosshair ?? true,
    showXGridlines: p.showXGridlines ?? legacy.showGridlines ?? true,
    showYGridlines: p.showYGridlines ?? legacy.showGridlines ?? true,
    gridOpacity: p.gridOpacity ?? 1,
    tickFontSize: p.tickFontSize ?? 11,
    traces: (p.traces ?? []).map((t) => ({ ...t, data: t.data ?? [] })),
  };
}
function baseStripTraceData(plot: Plot): Plot {
  return { ...plot, traces: plot.traces.map((t) => ({ ...t, data: [] })) };
}
/** Base-sha native load: parse, version check, rehydrate. */
function baseLoad(text: string): { theme: string; plots: Plot[] } {
  const obj = JSON.parse(text) as { schemaVersion: number; theme: string; plots: Plot[] };
  if (obj.schemaVersion > 1) throw new Error('newer schema');
  return { theme: obj.theme, plots: obj.plots.map(baseRehydratePlot) };
}
/** Base-sha save of plots it loaded. */
function baseSave(theme: string, plots: Plot[]): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      savedAt: '2026-01-01T00:00:00.000Z',
      theme,
      plots: plots.map(baseStripTraceData),
    },
    null,
    2
  );
}

const DEFAULT = getPalette('default');

function curve(i: number, extra: Partial<PVTrace> = {}): PVTrace {
  return {
    id: `trace-${i + 1}`,
    pvName: `TEST:PV${i}`,
    displayName: '',
    color: colorForIndex(DEFAULT, i),
    visible: true,
    axisId: 'axis-1',
    useLive: true,
    useArchive: true,
    lineWidth: 2,
    lineType: 'step',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'circle',
    symbolSize: 10,
    data: [],
    ...extra,
  };
}

function plot(id: string, traces: PVTrace[], extra: Partial<Plot> = {}): Plot {
  return {
    id,
    title: id,
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
    axes: [
      {
        id: 'axis-1',
        name: 'Y',
        orientation: 'left',
        autoScale: true,
        logScale: false,
        visible: true,
      },
    ],
    traces,
    ...extra,
  };
}

// An old-format (pre-workbench) file: every curve stamped `liveRetentionMs`,
// every plot stamped a background, no palette key.
function oldFile(plots: unknown[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    savedAt: '2025-01-01T00:00:00Z',
    theme: 'dark',
    plots,
  });
}

describe('serializeWorkspace / deserializeWorkspace — automatic value rules', () => {
  it('keeps schemaVersion 1', () => {
    const ws = JSON.parse(
      serializeWorkspace({ theme: 'dark', plots: [plot('plot-1', [curve(0)])] })
    );
    expect(ws.schemaVersion).toBe(1);
  });

  describe('an old-format file opens with a dot only where it differs from automatic', () => {
    it('theme-default backgrounds, stamped retention and default-palette colours open automatic', () => {
      // R9: a saved retention loads again, as on main. Main's stamped default
      // (300 s) and an out-of-range value (3600 s) open automatic; an
      // in-range value (600 s) is that curve's pin.
      const text = oldFile([
        {
          ...plot('plot-1', [
            curve(0, { liveRetentionMs: 600_000 }),
            curve(1, { liveRetentionMs: 3_600_000 }),
            curve(2, { liveRetentionMs: 300_000 }),
          ]),
          backgroundColor: '#161616',
        },
        { ...plot('plot-2', [curve(0, { liveRetentionMs: 600_000 })]), backgroundColor: '#ffffff' },
      ]);
      const { plots } = deserializeWorkspace(text);
      expect(plots).toHaveLength(2);
      for (const p of plots) {
        expect(p.backgroundColor).toBeUndefined(); // no Background dot
        expect(p.palette).toBeUndefined(); // no Palette dot
        for (const t of p.traces) {
          expect(paletteSlot(t.color, DEFAULT)).toBeGreaterThanOrEqual(0); // no Colour dot
        }
      }
      expect(plots[0].traces.map((t) => t.liveRetentionMs)).toEqual([
        600_000,
        undefined,
        undefined,
      ]);
      expect(plots[1].traces[0].liveRetentionMs).toBe(600_000);
    });

    it('a custom background stays pinned and a non-default palette is inferred', () => {
      const viridis = getPalette('viridis');
      const text = oldFile([
        {
          ...plot('plot-1', [
            curve(0, { color: colorForIndex(viridis, 0), liveRetentionMs: 600_000 }),
            curve(1, { color: colorForIndex(viridis, 1) }),
          ]),
          backgroundColor: '#123456',
        },
      ]);
      const [p] = deserializeWorkspace(text).plots;
      expect(p.backgroundColor).toBe('#123456');
      expect(p.palette).toBe('viridis');
      // R9: the saved 600 s is curve 0's pin; curve 1 has none.
      expect(p.traces.map((t) => t.liveRetentionMs)).toEqual([600_000, undefined]);
    });

    it('the legacy liveRetentionMs key is read as automatic even beside nothing else', () => {
      const text = oldFile([plot('plot-1', [curve(0, { liveRetentionMs: 42 })])]);
      const [p] = deserializeWorkspace(text).plots;
      expect('liveRetentionMs' in p.traces[0]).toBe(false);
    });
  });

  describe('the writer', () => {
    it('writes the resolved background and the theme-default when automatic', () => {
      const plots = [
        plot('plot-1', [curve(0)]),
        plot('plot-2', [curve(0)], { backgroundColor: '#abcdef' }),
      ];
      const dark = JSON.parse(serializeWorkspace({ theme: 'dark', plots }));
      expect(dark.plots.map((p: Plot) => p.backgroundColor)).toEqual(['#161616', '#abcdef']);
      const light = JSON.parse(serializeWorkspace({ theme: 'light', plots }));
      // The g10 chart background of canopy-charts' light theme.
      expect(light.plots.map((p: Plot) => p.backgroundColor)).toEqual(['#f4f4f4', '#abcdef']);
    });

    it('never writes liveRetentionMs; a pin goes under the new key (only a 300 s pin, R9)', () => {
      // R9: a pin is written under main's key, so main honours it; only a pin
      // of main's stamped default (300 s), which that key reads as automatic,
      // goes under the new key. An automatic curve writes neither.
      const plots = [
        plot('plot-1', [
          curve(0),
          curve(1, { liveRetentionMs: 900_000 }),
          curve(2, { liveRetentionMs: 300_000 }),
        ]),
      ];
      const text = serializeWorkspace({ theme: 'dark', plots });
      expect(LIVE_RETENTION_PIN_KEY).not.toBe('liveRetentionMs');
      const ws = JSON.parse(text);
      expect('liveRetentionMs' in ws.plots[0].traces[0]).toBe(false);
      expect(LIVE_RETENTION_PIN_KEY in ws.plots[0].traces[0]).toBe(false);
      expect(ws.plots[0].traces[1].liveRetentionMs).toBe(900_000);
      expect(LIVE_RETENTION_PIN_KEY in ws.plots[0].traces[1]).toBe(false);
      expect('liveRetentionMs' in ws.plots[0].traces[2]).toBe(false);
      expect(ws.plots[0].traces[2][LIVE_RETENTION_PIN_KEY]).toBe(300_000);
      expect(deserializeWorkspace(text).plots[0].traces.map((t) => t.liveRetentionMs)).toEqual([
        undefined,
        900_000,
        300_000,
      ]);
    });

    it('the new key name is no field of the app types', () => {
      // The pre-workbench format mirrored these types, so a key absent from
      // them was never written; guards a future rename onto a field name.
      expect(typesSource).not.toContain(LIVE_RETENTION_PIN_KEY);
    });
  });

  describe('an older Trace (base sha rehydrate)', () => {
    const plots = [
      plot('plot-1', [curve(0), curve(1, { liveRetentionMs: 900_000 })]),
      plot('plot-2', [curve(0)], { backgroundColor: '#abcdef' }),
    ];
    const text = serializeWorkspace({ theme: 'light', plots });

    it('opens a new file: keeps its background and ignores the new key', () => {
      const old = baseLoad(text);
      expect(old.plots.map((p) => p.backgroundColor)).toEqual(['#f4f4f4', '#abcdef']);
      // R9: the pin is written under main's key, so the old reader honours it.
      expect(old.plots[0].traces[1].liveRetentionMs).toBe(900_000);
      expect(old.plots[0].traces[0].liveRetentionMs).toBeUndefined();
    });

    it('re-saving keeps the new key, and this Trace still reads the pin', () => {
      const old = baseLoad(text);
      const resaved = baseSave(old.theme, old.plots);
      const ws = JSON.parse(resaved);
      // R9: the pin rides main's key through the old reader and writer.
      expect(ws.plots[0].traces[1].liveRetentionMs).toBe(900_000);
      const back = deserializeWorkspace(resaved).plots;
      expect(back[0].traces[1].liveRetentionMs).toBe(900_000);
      expect(back[0].traces[0].liveRetentionMs).toBeUndefined();
      expect(back[0].backgroundColor).toBeUndefined();
      expect(back[1].backgroundColor).toBe('#abcdef');
    });
  });

  it('a 300 s pin survives an older Trace: it keeps the new key on re-save (R9)', () => {
    const text = serializeWorkspace({
      theme: 'dark',
      plots: [plot('plot-1', [curve(0, { liveRetentionMs: 300_000 })])],
    });
    const old = baseLoad(text);
    // The old reader ignores the new key and applies its own 300 s default.
    expect(old.plots[0].traces[0].liveRetentionMs).toBeUndefined();
    const resaved = JSON.parse(baseSave(old.theme, old.plots));
    expect(resaved.plots[0].traces[0][LIVE_RETENTION_PIN_KEY]).toBe(300_000);
    expect(deserializeWorkspace(JSON.stringify(resaved)).plots[0].traces[0].liveRetentionMs).toBe(
      300_000
    );
  });

  it('a value main changed wins over a stale new key (R9)', () => {
    // Saved here with a 300 s pin, then changed to 60 s on main, which writes
    // its key and keeps the new one on re-save.
    const text = JSON.stringify({
      schemaVersion: 1,
      savedAt: '2026-11-01T00:00:00Z',
      theme: 'dark',
      plots: [
        plot('plot-1', [
          {
            ...curve(0, { liveRetentionMs: 60_000 }),
            [LIVE_RETENTION_PIN_KEY]: 300_000,
          } as PVTrace,
        ]),
      ],
    });
    expect(deserializeWorkspace(text).plots[0].traces[0].liveRetentionMs).toBe(60_000);
  });

  it('formula curves, further plots, pins and palettes round-trip', () => {
    const coolwarm = getPalette('coolwarm');
    const formula: PVTrace = {
      ...curve(2),
      id: 'formula-1',
      kind: 'formula',
      pvName: '',
      displayName: 'sum',
      useLive: false,
      useArchive: false,
      expression: '{x1}+{x2}',
      bindings: { x1: 'trace-1', x2: 'trace-2' },
      lineType: 'direct',
    };
    const plots: Plot[] = [
      plot('plot-1', [curve(0, { liveRetentionMs: 120_000 }), curve(1), formula]),
      plot(
        'plot-2',
        [curve(0, { color: colorForIndex(coolwarm, 0) }), curve(1, { color: '#010203' })],
        { backgroundColor: '#222222', palette: 'coolwarm', title: 'Second' }
      ),
      plot('plot-3', []),
    ];
    for (const theme of ['dark', 'light'] as const) {
      const result = deserializeWorkspace(serializeWorkspace({ theme, plots }));
      expect(result.source).toBe('native');
      expect(result.theme).toBe(theme);
      expect(result.warnings).toEqual([]);
      expect(result.plots).toEqual(plots);
    }
  });

  it('a newer schema version is still refused', () => {
    expect(() => deserializeWorkspace(JSON.stringify({ schemaVersion: 2, plots: [] }))).toThrow(
      /newer/
    );
  });
});

describe('deserializeWorkspace — legacy .trc background', () => {
  it('a missing or theme-default background opens automatic; a custom one stays', () => {
    const trc = (bg?: string) =>
      JSON.stringify({
        plot: { title: 'T', ...(bg ? { backgroundColor: bg } : {}) },
        'y-axes': [],
        curves: [],
      });
    expect(deserializeWorkspace(trc()).plots[0].backgroundColor).toBeUndefined();
    expect(deserializeWorkspace(trc('#161616')).plots[0].backgroundColor).toBeUndefined();
    expect(deserializeWorkspace(trc('#ffffff')).plots[0].backgroundColor).toBeUndefined();
    expect(deserializeWorkspace(trc('#334455')).plots[0].backgroundColor).toBe('#334455');
  });
});

describe('deserializeWorkspace — crosshair and drag defaults', () => {
  it('reads a plot without the crosshair flag as off, and an explicit flag as written', () => {
    const missing = plot('p', []) as Partial<Plot>;
    delete missing.showCrosshair;
    expect(deserializeWorkspace(oldFile([missing])).plots[0].showCrosshair).toBe(false);
    expect(
      deserializeWorkspace(oldFile([plot('p', [], { showCrosshair: true })])).plots[0].showCrosshair
    ).toBe(true);
  });

  it('keeps a stored pan and drops a stored zoom (the default)', () => {
    const [pan, zoom, none] = deserializeWorkspace(
      oldFile([
        plot('a', [], { dragMode: 'pan' }),
        plot('b', [], { dragMode: 'zoom' }),
        plot('c', []),
      ])
    ).plots;
    expect(pan.dragMode).toBe('pan');
    expect(zoom).not.toHaveProperty('dragMode');
    expect(none).not.toHaveProperty('dragMode');
  });

  it('a legacy .trc keeps its explicit crosshair flag', () => {
    const trc = (crosshair?: boolean) =>
      JSON.stringify({
        plot: { title: 'T', ...(crosshair === undefined ? {} : { crosshair }) },
        'y-axes': [{ name: 'Axis 1', orientation: 'left' }],
        curves: [{ channel: 'TEST:A', yAxisName: 'Axis 1' }],
      });
    expect(deserializeWorkspace(trc(false)).plots[0].showCrosshair).toBe(false);
    expect(deserializeWorkspace(trc(true)).plots[0].showCrosshair).toBe(true);
    expect(deserializeWorkspace(trc()).plots[0].showCrosshair).toBe(true);
  });
});
