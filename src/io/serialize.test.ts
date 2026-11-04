import { describe, it, expect } from 'vitest';
import { deserializeWorkspace, LIVE_RETENTION_PIN_KEY, serializeWorkspace } from './serialize';
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
      const text = oldFile([
        {
          ...plot('plot-1', [
            curve(0, { liveRetentionMs: 600_000 }),
            curve(1, { liveRetentionMs: 3_600_000 }),
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
          expect(t.liveRetentionMs).toBeUndefined(); // no Retention dot
          expect(paletteSlot(t.color, DEFAULT)).toBeGreaterThanOrEqual(0); // no Colour dot
        }
      }
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
      expect(p.traces.every((t) => t.liveRetentionMs === undefined)).toBe(true);
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

    it('never writes liveRetentionMs; a pin goes under the new key', () => {
      const plots = [plot('plot-1', [curve(0), curve(1, { liveRetentionMs: 900_000 })])];
      const text = serializeWorkspace({ theme: 'dark', plots });
      expect(text).not.toContain('"liveRetentionMs"');
      expect(LIVE_RETENTION_PIN_KEY).not.toBe('liveRetentionMs');
      const ws = JSON.parse(text);
      expect(LIVE_RETENTION_PIN_KEY in ws.plots[0].traces[0]).toBe(false);
      expect(ws.plots[0].traces[1][LIVE_RETENTION_PIN_KEY]).toBe(900_000);
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
      // The old reader has no retention pin: the curve's retention is its own default.
      expect(old.plots[0].traces[1].liveRetentionMs).toBeUndefined();
    });

    it('re-saving keeps the new key, and this Trace still reads the pin', () => {
      const old = baseLoad(text);
      const resaved = baseSave(old.theme, old.plots);
      const ws = JSON.parse(resaved);
      expect(ws.plots[0].traces[1][LIVE_RETENTION_PIN_KEY]).toBe(900_000);
      const back = deserializeWorkspace(resaved).plots;
      expect(back[0].traces[1].liveRetentionMs).toBe(900_000);
      expect(back[0].traces[0].liveRetentionMs).toBeUndefined();
      expect(back[0].backgroundColor).toBeUndefined();
      expect(back[1].backgroundColor).toBe('#abcdef');
    });
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
