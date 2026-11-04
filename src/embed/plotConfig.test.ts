// The first plot's display configuration in the embed query: built sparse
// from a plot, read back leniently, applied on open, and round-tripped.
import { defaultMetrics } from '../statistics/model';
import { TRACE_METRICS } from '../tools/trace/metrics';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Axis, Plot } from '../types';
import { colorForIndex, getPalette, DEFAULT_PALETTE_ID } from '../palettes';
import { buildInitialPlots } from './initialPlots';
import {
  PLOT_CONFIG_VERSION,
  PLOT_DEFAULTS,
  TRACE_DEFAULTS,
  applyPlotConfig,
  axesOnly,
  axisDefaults,
  newAxis,
  newFormula,
  newPlot,
  newTrace,
  unitAxis,
  parsePlotConfig,
  plotConfigOf,
  type PlotConfig,
} from './plotConfig';
import { parseTraceQuery, serializeTraceQuery } from './query';

const palette = getPalette(DEFAULT_PALETTE_ID);
const A = 'TEST:BPM1:X';
const B = 'TEST:QF1:CURRENT';
const C = 'TEST:VAC:IG1';

afterEach(() => {
  vi.restoreAllMocks();
});

function opened(pvs: string[]): Plot {
  return buildInitialPlots(`?${pvs.map((p) => `pv=${p}`).join('&')}&range=-1h`, palette)[0];
}

function axis(id: string, over: Partial<Axis> = {}): Axis {
  return {
    id,
    name: 'Y-Axis 1',
    orientation: 'left',
    autoScale: true,
    logScale: false,
    visible: true,
    ...over,
  };
}

// The plot an operator might set up: a second log axis on the right with a
// fixed range, the current on it, a custom color and dashed line on C.
function customized(): Plot {
  const plot = opened([A, B, C]);
  return {
    ...plot,
    title: 'Test overview',
    showLegend: false,
    gridOpacity: 0.4,
    axes: [
      axis('y-axis-1', { name: 'Position', units: 'mm' }),
      axis('axis-7', {
        name: 'Current',
        orientation: 'right',
        autoScale: false,
        min: 0.001,
        max: 120,
        logScale: true,
        units: 'A',
      }),
    ],
    traces: plot.traces.map((t, i) =>
      i === 1
        ? { ...t, axisId: 'axis-7' }
        : i === 2
          ? { ...t, color: '#123456', lineStyle: 'dashed', lineWidth: 3, useArchive: false }
          : t
    ),
  };
}

describe('plotConfigOf', () => {
  it('is undefined for a plot as Trace opens it', () => {
    expect(plotConfigOf(opened([A, B, C]), palette)).toBeUndefined();
    expect(plotConfigOf(opened([]), palette)).toBeUndefined();
  });

  it('treats absent fields as defaults (a bare trace list)', () => {
    expect(plotConfigOf({ traces: [{ pvName: A }, { pvName: B }] }, palette)).toBeUndefined();
  });

  it('keeps only what differs, naming axes by index', () => {
    expect(plotConfigOf(customized(), palette)).toEqual({
      v: PLOT_CONFIG_VERSION,
      title: 'Test overview',
      showLegend: false,
      gridOpacity: 0.4,
      axes: [
        { name: 'Position', units: 'mm' },
        {
          name: 'Current',
          orientation: 'right',
          autoScale: false,
          logScale: true,
          min: 0.001,
          max: 120,
          units: 'A',
        },
      ],
      traces: [
        {},
        { axis: 1 },
        { color: '#123456', lineStyle: 'dashed', lineWidth: 3, useArchive: false },
      ],
    });
  });

  it('records a log scale or manual range on the single axis', () => {
    const plot = opened([A]);
    plot.axes = [axis('y-axis-1', { logScale: true, autoScale: false, min: -2, max: 2 })];
    expect(plotConfigOf(plot, palette)).toEqual({
      v: 1,
      axes: [{ logScale: true, autoScale: false, min: -2, max: 2 }],
    });
  });

  it('skips formula and blank traces so entries line up with the pv keys', () => {
    const plot = opened([A, B]);
    plot.traces = [
      { ...plot.traces[0], kind: 'formula', pvName: '', color: '#ffffff' },
      { ...plot.traces[1], pvName: ' ' },
      { ...plot.traces[0], visible: false },
    ];
    expect(plotConfigOf(plot, palette)?.traces).toEqual([{ visible: false }]);
  });

  it('trims trailing default trace entries', () => {
    const plot = opened([A, B, C]);
    plot.traces[0] = { ...plot.traces[0], visible: false };
    expect(plotConfigOf(plot, palette)?.traces).toEqual([{ visible: false }]);
  });

  it("compares colors with the plot's own palette, not a palette passed in", () => {
    const plot = opened([A]);
    const other = getPalette('matplotlib');
    expect(plotConfigOf(plot, other)).toBeUndefined();
    plot.traces[0] = { ...plot.traces[0], color: colorForIndex(other, 0) };
    expect(plotConfigOf(plot)?.traces).toEqual([{ color: colorForIndex(other, 0) }]);
  });
});

describe('palette', () => {
  const MPL = getPalette('matplotlib');

  function inMpl(pvs: string[]): Plot {
    const plot = opened(pvs);
    return {
      ...plot,
      palette: MPL.id,
      traces: plot.traces.map((t, i) => ({ ...t, color: colorForIndex(MPL, i) })),
    };
  }

  it('a non-default palette is stated and every curve colour written explicitly', () => {
    const plot = inMpl([A, B, C]);
    plot.traces[1] = { ...plot.traces[1], color: '#123456' };
    expect(plotConfigOf(plot)).toEqual({
      v: 1,
      palette: MPL.id,
      traces: [
        { color: colorForIndex(MPL, 0) },
        { color: '#123456' },
        { color: colorForIndex(MPL, 2) },
      ],
    });
  });

  it('the default palette is never stated', () => {
    const plot = { ...opened([A]), palette: DEFAULT_PALETTE_ID };
    expect(plotConfigOf(plot)).toBeUndefined();
  });

  it('round-trips: the reopened plot has the palette and the colours', () => {
    const before = inMpl([A, B]);
    before.traces[0] = { ...before.traces[0], color: '#123456' };
    const query = serializeTraceQuery(before.traces, before.xAxis, plotConfigOf(before));
    const [after] = buildInitialPlots(`?${query}`);
    expect(after.palette).toBe(MPL.id);
    expect(after.traces.map((t) => t.color)).toEqual(before.traces.map((t) => t.color));
    expect(plotConfigOf(after)).toEqual(plotConfigOf(before));
  });

  it('an older reader (no palette key) still gets the right colours', () => {
    const config = plotConfigOf(inMpl([A, B]))!;
    const { palette: _dropped, ...older } = config;
    void _dropped;
    const plot = applyPlotConfig(opened([A, B]), older);
    expect(plot.traces.map((t) => t.color)).toEqual([colorForIndex(MPL, 0), colorForIndex(MPL, 1)]);
  });

  it('parses a known palette id and drops an unknown one with a warning', () => {
    expect(parsePlotConfig(JSON.stringify({ v: 1, palette: 'viridis' }))).toEqual({
      v: 1,
      palette: 'viridis',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parsePlotConfig(JSON.stringify({ v: 1, palette: 'nope' }))).toEqual({ v: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('axesOnly keeps the palette', () => {
    const plot = inMpl([A, B]);
    plot.axes = [axis('a1'), axis('a2', { name: 'Two', orientation: 'right' })];
    expect(axesOnly(plotConfigOf(plot)!)?.palette).toBe(MPL.id);
  });
});

describe('opening palette', () => {
  const MPL = getPalette('matplotlib');
  const VIR = getPalette('viridis');
  const colours = (plot: Plot) => plot.traces.map((t) => t.color);

  it('the palette the plot config states wins over the fresh-tab palette', () => {
    const [plot] = buildInitialPlots(
      `?pv=${A}&pv=${B}&plot=${encodeURIComponent(JSON.stringify({ v: 1, palette: VIR.id }))}`,
      MPL
    );
    expect(plot.palette).toBe(VIR.id);
    expect(colours(plot)).toEqual([colorForIndex(VIR, 0), colorForIndex(VIR, 1)]);
  });

  it('with no plot key (a fresh tab), the fresh-tab (legacy key) palette', () => {
    const [plot] = buildInitialPlots(`?pv=${A}&pv=${B}&range=-1h`, MPL);
    expect(plot.palette).toBe(MPL.id);
    expect(colours(plot)).toEqual([colorForIndex(MPL, 0), colorForIndex(MPL, 1)]);
  });

  it('a plot key that states no palette opens the default, whatever the legacy key', () => {
    const [plot] = buildInitialPlots(
      `?pv=${A}&plot=${encodeURIComponent(JSON.stringify({ v: 1, title: 'T' }))}`,
      MPL
    );
    expect('palette' in plot).toBe(false);
    expect(colours(plot)).toEqual([colorForIndex(palette, 0)]);
  });

  it('an unreadable plot key still counts as present: default palette', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [plot] = buildInitialPlots(`?pv=${A}&plot=%7Bnot-json`, MPL);
    expect('palette' in plot).toBe(false);
    expect(colours(plot)).toEqual([colorForIndex(palette, 0)]);
  });

  it('otherwise the default', () => {
    const [plot] = buildInitialPlots(`?pv=${A}`);
    expect('palette' in plot).toBe(false);
    expect(colours(plot)).toEqual([colorForIndex(palette, 0)]);
  });
});

describe('parsePlotConfig', () => {
  it('reads a valid config unchanged', () => {
    const config = plotConfigOf(customized(), palette)!;
    expect(parsePlotConfig(JSON.stringify(config))).toEqual(config);
  });

  it('ignores unreadable JSON with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parsePlotConfig('{"v":1,')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('ignores a newer version or a non-object with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parsePlotConfig('{"v":2,"showLegend":false}')).toBeNull();
    expect(parsePlotConfig('[1]')).toBeNull();
    expect(parsePlotConfig('{"showLegend":false}')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('drops invalid fields with one warning naming them, keeping the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = parsePlotConfig(
      JSON.stringify({
        v: 1,
        showLegend: 'no',
        gridOpacity: 3,
        axes: [{ name: 'I', min: 'low', logScale: true, orientation: 'up' }],
        traces: [{ axis: 4, color: 'red; x', lineWidth: 2.5 }, 'junk'],
        futureField: 1,
      })
    );
    expect(config).toEqual({
      v: 1,
      axes: [{ name: 'I', logScale: true }],
      traces: [{ lineWidth: 2.5 }, {}],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    for (const field of [
      'showLegend',
      'gridOpacity',
      'axes[0].min',
      'axes[0].orientation',
      'traces[0].axis',
      'traces[0].color',
    ]) {
      expect(message).toContain(field);
    }
  });

  it('drops an empty or oversized axes list', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parsePlotConfig('{"v":1,"axes":[]}')).toEqual({ v: 1 });
    const many = JSON.stringify({ v: 1, axes: Array.from({ length: 17 }, () => ({})) });
    expect(parsePlotConfig(many)).toEqual({ v: 1 });
  });

  it('accepts a trace axis only within the axes it names', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parsePlotConfig('{"v":1,"traces":[{"axis":1}]}')?.traces).toEqual([{}]);
    expect(parsePlotConfig('{"v":1,"axes":[{},{}],"traces":[{"axis":1}]}')?.traces).toEqual([
      { axis: 1 },
    ]);
  });
});

describe('applyPlotConfig', () => {
  it('builds the axes with fresh ids and moves traces onto them', () => {
    const config = plotConfigOf(customized(), palette)!;
    const plot = applyPlotConfig(opened([A, B, C]), config);
    expect(plot.axes.map((a) => a.id)).toEqual(['y-axis-1', 'y-axis-2']);
    expect(plot.axes[1]).toMatchObject({
      name: 'Current',
      orientation: 'right',
      autoScale: false,
      logScale: true,
      min: 0.001,
      max: 120,
      visible: true,
    });
    expect(plot.traces.map((t) => t.axisId)).toEqual(['y-axis-1', 'y-axis-2', 'y-axis-1']);
    expect(plot.traces[2]).toMatchObject({ color: '#123456', lineStyle: 'dashed', lineWidth: 3 });
    expect(plot.traces[0].color).toBe(colorForIndex(palette, 0));
    expect(plot).toMatchObject({ title: 'Test overview', showLegend: false, gridOpacity: 0.4 });
  });

  it('names a default axis by its position when the config leaves the name out', () => {
    const plot = applyPlotConfig(opened([A]), { v: 1, axes: [{}, { logScale: true }] });
    expect(plot.axes.map((a) => a.name)).toEqual(['Y-Axis 1', 'Y-Axis 2']);
  });

  it('ignores trace entries beyond the PVs', () => {
    const plot = applyPlotConfig(opened([A]), { v: 1, traces: [{}, { visible: false }] });
    expect(plot.traces).toHaveLength(1);
  });
});

describe('round trip through the query', () => {
  it('reopens a customized plot with the same configuration', () => {
    const before = customized();
    const query = serializeTraceQuery(before.traces, before.xAxis, plotConfigOf(before, palette));
    const [after] = buildInitialPlots(`?${query}&theme=dark&embedded=true`, palette);
    expect(plotConfigOf(after, palette)).toEqual(plotConfigOf(before, palette));
    expect(parseTraceQuery(query).pvs).toEqual([A, B, C]);
  });

  it('keeps the bare form for an untouched plot', () => {
    const plot = opened([A, B]);
    expect(serializeTraceQuery(plot.traces, plot.xAxis, plotConfigOf(plot, palette))).toBe(
      `pv=${A}&pv=${B}&range=-1h`
    );
  });

  it('survives PV names and titles with query metacharacters', () => {
    const plot = opened(['A%26B', 'C']);
    plot.traces[0] = { ...plot.traces[0], pvName: 'X&Y=Z', displayName: '50% & "more" #1' };
    plot.title = 'a+b={c}';
    const config = plotConfigOf(plot, palette);
    const query = serializeTraceQuery(plot.traces, plot.xAxis, config);
    const parsed = parseTraceQuery(query);
    expect(parsed.pvs).toEqual(['X&Y=Z', 'C']);
    expect(parsed.plot).toEqual(config);
  });
});

describe('statistics', () => {
  it('writes showStats only when on and the metric tokens only off the default', () => {
    const plot = opened([A]);
    expect(plotConfigOf(plot, palette)).toBeUndefined();
    plot.showStats = true;
    expect(plotConfigOf(plot, palette)).toEqual({ v: PLOT_CONFIG_VERSION, showStats: true });
    plot.showStats = undefined;
    plot.showDist = true;
    expect(plotConfigOf(plot, palette)).toEqual({ v: PLOT_CONFIG_VERSION, showDist: true });
    const withDist = applyPlotConfig(opened([A]), parsePlotConfig('{"v":1,"showDist":true}')!);
    expect(withDist.showDist).toBe(true);
    plot.showDist = undefined;
    plot.metrics = defaultMetrics(TRACE_METRICS).map((m) =>
      m.id === 'std' ? { ...m, strip: true } : m
    );
    plot.metrics.push({
      id: 'c1',
      label: 'drift',
      expr: 'slope(t,y)',
      unit: 'y/s',
      on: true,
      strip: false,
    });
    const config = plotConfigOf(plot, palette)!;
    expect(config.metrics).toEqual([
      'n',
      'mean',
      '~std',
      'min',
      'max',
      '-last',
      '-first',
      '-p2p',
      '-rms',
      '-median',
      '-slope',
      'drift=slope(t,y)=y/s',
    ]);
    const reopened = applyPlotConfig(opened([A]), parsePlotConfig(JSON.stringify(config))!);
    expect(reopened.metrics).toEqual(plot.metrics);
    expect(reopened.showStats).toBeUndefined();
  });

  it('a default list in the config leaves the plot without one; bad tokens are dropped', () => {
    const tokens = defaultMetrics(TRACE_METRICS).map((m) => (m.on ? m.id : `-${m.id}`));
    const config = parsePlotConfig(JSON.stringify({ v: 1, metrics: [...tokens, 'bogus'] }))!;
    expect(applyPlotConfig(opened([A]), config).metrics).toBeUndefined();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parsePlotConfig(JSON.stringify({ v: 1, metrics: 'n' }))?.metrics).toBeUndefined();
    expect(warn.mock.calls[0]?.[0]).toContain('metrics');
    warn.mockRestore();
  });
});

describe('axesOnly', () => {
  it('keeps the axes and each trace axis, nothing else', () => {
    const config = plotConfigOf(customized(), palette)!;
    expect(axesOnly(config)).toEqual({
      v: 1,
      axes: config.axes,
      traces: [{}, { axis: 1 }],
    });
  });

  it('is undefined without axes', () => {
    const config: PlotConfig = { v: 1, showLegend: false };
    expect(axesOnly(config)).toBeUndefined();
  });
});

// Every creation path spreads the tables, so a field added to a table reaches
// each new object; only identity fields and kind-specific overrides differ.
describe('creation builders', () => {
  it('a new axis is the axis defaults with its id', () => {
    expect(newAxis('a', 0)).toEqual({ id: 'a', ...axisDefaults(0) });
  });

  it('puts the second added axis on the right, the third on the left', () => {
    expect(newAxis('b', 1)).toEqual({ id: 'b', ...axisDefaults(1), orientation: 'right' });
    expect(newAxis('c', 2).orientation).toBe('left');
  });

  it('a unit-assigned axis carries the units and name of its PV', () => {
    expect(unitAxis('u', 1, 'mA')).toEqual({
      id: 'u',
      ...axisDefaults(1),
      orientation: 'right',
      name: 'mA',
      units: 'mA',
    });
    expect(unitAxis('v', 2, 'Torr').orientation).toBe('left');
  });

  it('a new plot is the plot defaults with its id, title and one default axis', () => {
    const plot = newPlot('p', 2);
    const { id, title, backgroundColor, xAxis, autoScroll, axes, traces, ...rest } = plot;
    const { title: _title, ...plotDefaults } = PLOT_DEFAULTS;
    void _title;
    expect(rest).toEqual(plotDefaults);
    expect({ id, title, backgroundColor, xAxis, autoScroll, traces }).toEqual({
      id: 'p',
      title: 'Plot 3',
      backgroundColor: undefined,
      xAxis: { timeRange: '-1h' },
      autoScroll: true,
      traces: [],
    });
    expect(axes).toEqual([{ id: 'p-axis-1', ...axisDefaults(0) }]);
  });

  it('a new trace is the trace defaults with its identity fields', () => {
    const data = [{ time: 1, value: 2 }];
    const trace = newTrace('t', 'TEST:X', 'ax', '#123456', data);
    const { id, pvName, axisId, color, data: d, ...rest } = trace;
    expect(rest).toEqual(TRACE_DEFAULTS);
    expect({ id, pvName, axisId, color, data: d }).toEqual({
      id: 't',
      pvName: 'TEST:X',
      axisId: 'ax',
      color: '#123456',
      data,
    });
  });

  it('a new formula is the trace defaults with its identity and formula fields', () => {
    const formula = newFormula('f', 'ax', '#abcdef');
    expect(formula).toEqual({
      ...TRACE_DEFAULTS,
      id: 'f',
      kind: 'formula',
      pvName: '',
      displayName: 'New Formula',
      axisId: 'ax',
      color: '#abcdef',
      useLive: false,
      useArchive: false,
      lineType: 'direct',
      expression: '',
      bindings: {},
      data: [],
    });
  });

  it('a new plot and trace report no plot config', () => {
    const plot = newPlot('p', 0);
    plot.traces = [newTrace('t', A, plot.axes[0].id, colorForIndex(palette, 0), [])];
    expect(plotConfigOf(plot, palette)).toBeUndefined();
  });
});

describe('crosshair and drag defaults', () => {
  it('opens a plot with the crosshair off and no stored drag mode (zoom)', () => {
    const plot = newPlot('p', 0);
    expect(PLOT_DEFAULTS.showCrosshair).toBe(false);
    expect(plot.showCrosshair).toBe(false);
    expect(plot.dragMode).toBeUndefined();
  });

  it('writes the crosshair only when on and the drag mode only as pan', () => {
    const base = opened([A]);
    expect(plotConfigOf(base, palette)).toBeUndefined();
    expect(plotConfigOf({ ...base, showCrosshair: true }, palette)).toEqual({
      v: PLOT_CONFIG_VERSION,
      showCrosshair: true,
    });
    expect(plotConfigOf({ ...base, dragMode: 'pan' }, palette)).toEqual({
      v: PLOT_CONFIG_VERSION,
      dragMode: 'pan',
    });
    // A stored zoom is the default: nothing to write.
    expect(plotConfigOf({ ...base, dragMode: 'zoom' }, palette)).toBeUndefined();
  });

  it('reads a link without the keys as the defaults', () => {
    const plot = applyPlotConfig(opened([A]), parsePlotConfig('{"v":1,"title":"Old"}')!);
    expect(plot.showCrosshair).toBe(false);
    expect(plot.dragMode).toBeUndefined();
  });

  it('still reads an explicit crosshair and an old "zoom" drag mode', () => {
    const on = applyPlotConfig(opened([A]), parsePlotConfig('{"v":1,"showCrosshair":true}')!);
    expect(on.showCrosshair).toBe(true);
    const off = applyPlotConfig(
      { ...opened([A]), showCrosshair: true },
      parsePlotConfig('{"v":1,"showCrosshair":false}')!
    );
    expect(off.showCrosshair).toBe(false);
    const zoom = applyPlotConfig(opened([A]), parsePlotConfig('{"v":1,"dragMode":"zoom"}')!);
    expect(zoom).not.toHaveProperty('dragMode');
    const pan = applyPlotConfig(opened([A]), parsePlotConfig('{"v":1,"dragMode":"pan"}')!);
    expect(pan.dragMode).toBe('pan');
  });

  it('round-trips crosshair on and pan through the query', () => {
    const plot = { ...opened([A, B]), showCrosshair: true, dragMode: 'pan' as const };
    const query = serializeTraceQuery(plot.traces, plot.xAxis, plotConfigOf(plot, palette));
    const [back] = buildInitialPlots(`?${query}`, palette);
    expect(back.showCrosshair).toBe(true);
    expect(back.dragMode).toBe('pan');
  });
});
