// Trace's field-table completeness test: every schema field id has a class in
// fieldTable.ts; `plot` fields are exactly the *_CHECKS keys of
// embed/plotConfig.ts, `query` fields exactly parseTraceQuery's own keys, and
// the never-serialized session settings are `session`.
// A missing field or an orphan CHECKS key fails by name. Then every plot-class
// setting of the first plot round-trips through the query with unchanged
// bytes for a fixture of existing views. The drawing item's fields map onto
// the slots of the `plot=` drawing tuple, and each
// one round-trips through the tuple codec off its default.
import { afterEach, describe, expect, it, vi } from 'vitest';
import plotConfigRaw from '../../embed/plotConfig.ts?raw';
import queryRaw from '../../embed/query.ts?raw';
import drawingConfigRaw from '../../annotations/config.ts?raw';
import { BUILTIN_CATALOG } from '../../annotations/catalog';
import { TIME_X_AXIS } from '../../annotations/catalog/xAxis';
import { decodeDrawings, encodeDrawings } from '../../annotations/config';
import type { Annotation } from '../../annotations/model';
import type { Axis, Plot, PVTrace } from '../../types';
import { defaultMetrics } from '../../statistics/model';
import { defaultAnnotationColor } from '../../annotationTheme';
import { TRACE_METRICS } from './metrics';
import { DEFAULT_PALETTE_ID, getPalette } from '../../palettes';
import { buildInitialPlots } from '../../embed/initialPlots';
import {
  axisId,
  newFormula,
  parsePlotConfig,
  plotConfigOf,
  PLOT_CONFIG_VERSION,
  type PlotConfig,
} from '../../embed/plotConfig';
import { serializeTraceQuery } from '../../embed/query';
import type {
  FieldDef,
  ObjectSchema,
  Target,
  TargetLevel,
  ToolContext,
} from '../../workbench/types';
import type { TraceDotState } from './dots';
import { plotSchema } from './schema/plot';
import { AXIS_SECTION_KIND, traceAxisSchema } from './schema/axis';
import { PV_CURVE_ITEM_KIND, pvCurveSchema, type TraceCurveModel } from './schema/curve';
import { FORMULA_CURVE_ITEM_KIND, formulaCurveSchema } from './schema/formula';
import { DRAWING_ITEM_KIND } from '../../annotations/host/workbench';
import { createAnnotationSchema } from './schema/annotation';
import {
  DERIVED_DRAWING_SLOTS,
  DERIVED_PLOT_CONFIG_KEYS,
  TRACE_FIELD_TABLE,
  type FieldClass,
  type PlotConfigScope,
} from './fieldTable';

type Model = TraceCurveModel;
type Field = FieldDef<TraceDotState, Model>;

const palette = getPalette(DEFAULT_PALETTE_ID);
const SCOPES: PlotConfigScope[] = ['plot', 'axis', 'trace'];

/** The settings that are session state and never serialized. */
const SESSION_SETTINGS = ['autoscroll'];

/** parseTraceQuery keys that carry no single field: `plot` carries the plot class, `from`/`to` the custom time range. */
const CARRIER_QUERY_KEYS: Record<string, string> = {
  plot: 'every plot-class field',
  from: 'time-range',
  to: 'time-range',
};

const TOOL_KIND = 'trace';
const SCHEMAS: { level: TargetLevel; kind: string; schema: ObjectSchema<TraceDotState, Model> }[] =
  [
    { level: 'tool', kind: TOOL_KIND, schema: plotSchema },
    { level: 'section', kind: AXIS_SECTION_KIND, schema: traceAxisSchema<TraceDotState, Model>() },
    { level: 'item', kind: PV_CURVE_ITEM_KIND, schema: pvCurveSchema },
    { level: 'item', kind: FORMULA_CURVE_ITEM_KIND, schema: formulaCurveSchema },
    {
      level: 'item',
      kind: DRAWING_ITEM_KIND,
      schema: createAnnotationSchema<TraceDotState, Model>(),
    },
  ];

function fieldsOf(schema: ObjectSchema<TraceDotState, Model>): Field[] {
  const header = (schema as { headerField?: Field }).headerField;
  return [...(header ? [header] : []), ...schema.tabs.flatMap((t) => t.fields)];
}

/** Every field id of every Trace schema, with the field (first occurrence; shared ids are one field). */
function schemaFields(): Map<string, Field> {
  const out = new Map<string, Field>();
  for (const { schema } of SCHEMAS) {
    for (const field of fieldsOf(schema)) if (!out.has(field.id)) out.set(field.id, field);
  }
  return out;
}

const entries = Object.entries(TRACE_FIELD_TABLE) as [string, FieldClass][];
const plotKeys = (scope: PlotConfigScope): string[] =>
  entries.flatMap(([, c]) => (c.class === 'plot' && c.scope === scope ? [c.key] : []));

/** The keys of each *_CHECKS table, read from plotConfig.ts's source (they are module-private). */
function checksKeysFromSource(): Record<PlotConfigScope, string[]> {
  const out = {} as Record<PlotConfigScope, string[]>;
  const table = /const (PLOT|AXIS|TRACE)_CHECKS: Record<string, Check> = \{([\s\S]*?)\n\};/g;
  for (const [, name, body] of plotConfigRaw.matchAll(table)) {
    out[name.toLowerCase() as PlotConfigScope] = [...body.matchAll(/^ {2}(\w+):/gm)].map(
      (m) => m[1]
    );
  }
  return out;
}

const checks = checksKeysFromSource();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Trace field table: classes', () => {
  it('names every schema field id, and only those', () => {
    const ids = schemaFields();
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids.keys()) {
      expect(TRACE_FIELD_TABLE[id], `schema field "${id}" has no field-table entry`).toBeDefined();
    }
    for (const id of Object.keys(TRACE_FIELD_TABLE)) {
      expect(ids.has(id), `field-table entry "${id}" is no schema field`).toBe(true);
    }
  });

  it('classes a field that holds no setting (code, status, action) as session', () => {
    for (const [id, field] of schemaFields()) {
      if (field.kind === 'code' || field.kind === 'readonly' || field.kind === 'action') {
        expect(TRACE_FIELD_TABLE[id]?.class, id).toBe('session');
      }
    }
  });

  it('pins the session-state list as session', () => {
    for (const id of SESSION_SETTINGS) expect(TRACE_FIELD_TABLE[id]?.class, id).toBe('session');
  });

  it('reads all three *_CHECKS tables from plotConfig.ts, as parsePlotConfig checks them', () => {
    expect(Object.keys(checks).sort()).toEqual([...SCOPES].sort());
    for (const scope of SCOPES) expect(checks[scope].length, scope).toBeGreaterThan(0);

    // Every key at an invalid value: parsePlotConfig's one warning names exactly the CHECKS keys.
    const invalid = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, { bad: true }]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parsePlotConfig(
      JSON.stringify({
        v: PLOT_CONFIG_VERSION,
        ...invalid(checks.plot),
        axes: [invalid(checks.axis)],
        traces: [invalid(checks.trace)],
      })
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const named = String(warn.mock.calls[0][0])
      .replace(/^.*ignoring invalid /, '')
      .replace(/\.$/, '')
      .split(', ');
    expect(named.sort()).toEqual(
      [
        ...checks.plot,
        ...checks.axis.map((k) => `axes[0].${k}`),
        ...checks.trace.map((k) => `traces[0].${k}`),
      ].sort()
    );
  });

  it.each(SCOPES)('maps the %s-scope plot fields one-to-one onto its CHECKS keys', (scope) => {
    const mapped = plotKeys(scope);
    const derived = DERIVED_PLOT_CONFIG_KEYS[scope];
    for (const key of checks[scope]) {
      expect(
        mapped.includes(key) || derived.includes(key),
        `${scope} CHECKS key "${key}" has no field`
      ).toBe(true);
    }
    for (const key of mapped) {
      expect(checks[scope].includes(key), `${scope} field key "${key}" is no CHECKS key`).toBe(
        true
      );
      expect(mapped.filter((k) => k === key).length, `${scope} key "${key}" twice`).toBe(1);
    }
    for (const key of derived) {
      expect(checks[scope].includes(key), `derived ${scope} key "${key}" is no CHECKS key`).toBe(
        true
      );
      expect(mapped.includes(key), `derived ${scope} key "${key}" now has a field`).toBe(false);
    }
  });

  it("maps the query fields one-to-one onto parseTraceQuery's own keys", () => {
    const parsed = new Set(
      [...queryRaw.matchAll(/params\.get(?:All)?\('(\w+)'\)/g)].map((m) => m[1])
    );
    expect(parsed.size).toBeGreaterThan(0);
    const fieldKeys = entries.flatMap(([, c]) => (c.class === 'query' ? [c.key] : []));
    expect(new Set(fieldKeys).size).toBe(fieldKeys.length);
    for (const key of parsed) {
      expect(
        fieldKeys.includes(key as never) || key in CARRIER_QUERY_KEYS,
        `query key "${key}" has no field`
      ).toBe(true);
    }
    for (const key of [...fieldKeys, ...Object.keys(CARRIER_QUERY_KEYS)]) {
      expect(parsed.has(key), `"${key}" is no parseTraceQuery key`).toBe(true);
    }
  });
});

// ── Round trip ──────────────────────────────────────────────────────────────

const A = 'TEST:BPM1:X';
const B = 'TEST:QF1:CURRENT';
const C = 'TEST:VAC:IG1';

function opened(search: string): Plot {
  return buildInitialPlots(search, palette)[0];
}

function axisAt(index: number, over: Partial<Axis>): Axis {
  return {
    id: axisId(index),
    name: `Y-Axis ${index + 1}`,
    orientation: 'left',
    autoScale: true,
    logScale: false,
    visible: true,
    ...over,
  };
}

// Every plot-class setting off its default, a custom range, and a formula.
function everything(): Plot {
  const plot = opened(`?pv=${A}&pv=${B}&pv=${C}&range=-1h`);
  const look: Partial<PVTrace> = {
    displayName: 'Beam X & "pos"',
    visible: false,
    useLive: false,
    useArchive: false,
    showArchiveBand: false,
    optimizedDataBins: 500,
    archiver: 'https://archiver.example/b?x=1',
    lineWidth: 3.5,
    lineType: 'direct',
    lineStyle: 'dashDot',
    showExtensionLine: false,
    alarmColoring: true,
    showSymbol: true,
    symbolShape: 'diamond',
    symbolSize: 6,
    color: '#123456',
  };
  return {
    ...plot,
    title: 'Test overview',
    showLegend: false,
    showLegendValue: true,
    pinDataWindow: true,
    showStatusLine: false,
    showTooltip: false,
    dragMode: 'pan',
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: true,
    gridStyle: 'dashed',
    gridOpacity: 0.4,
    tickFontSize: 14,
    refreshIntervalS: 12,
    archiver: 'https://archiver.example/a',
    palette: 'matplotlib',
    showStats: true,
    showDist: true,
    metrics: [
      ...defaultMetrics(TRACE_METRICS).map((m) => (m.id === 'mean' ? { ...m, strip: true } : m)),
      { id: 'c1', label: 'noise', expr: 'std(y - mean(y))', unit: 'y', on: true, strip: false },
    ],
    xAxis: { timeRange: 'custom', timeFrom: '2026-01-02T03:04', timeTo: '2026-01-02T05:06' },
    axes: [
      axisAt(0, { name: 'Position', orientation: 'right', units: 'mm' }),
      axisAt(1, {
        name: 'Current',
        autoScale: false,
        min: 0.001,
        max: 120,
        logScale: true,
        visible: false,
        units: 'A',
        unitLabel: 'amp',
      }),
    ],
    traces: [
      plot.traces[0],
      { ...plot.traces[1], ...look, axisId: axisId(1) },
      newFormula('formula-1', axisId(0), '#abcdef'),
      plot.traces[2],
    ],
    // Drawings ride as the derived `drawings` key.
    annotations: [
      {
        id: 'annotation-1',
        kind: 'hline',
        points: [{ t: 0, v: 2.5 }],
        axisId: axisId(1),
        traceId: plot.traces[1].id,
        color: '#ff0000',
        width: 2,
        dash: true,
        text: 'limit "hi" & low',
        locked: true,
      },
      {
        id: 'annotation-2',
        kind: 'trend',
        points: [
          { t: 1_767_323_040_000, v: 0.125 },
          { t: 1_767_326_760_000, v: 0.5 },
        ],
        axisId: axisId(0),
        color: defaultAnnotationColor(1),
        width: 1.5,
        text: '',
        extend: 'both',
        hidden: true,
      },
    ],
  };
}

// Existing views: as opened, an operator's customization, everything.
function views(): [string, Plot][] {
  const customized = opened(`?pv=${A}&pv=${B}&range=-8h`);
  return [
    ['as opened', opened(`?pv=${A}&pv=${B}&pv=${C}&range=-1h`)],
    ['no PVs', opened('?range=-1d')],
    [
      'customized',
      {
        ...customized,
        title: 'Vacuum',
        gridOpacity: 0.25,
        axes: [axisAt(0, { units: 'Torr' }), axisAt(1, { orientation: 'right', logScale: true })],
        traces: customized.traces.map((t, i) => (i === 1 ? { ...t, axisId: axisId(1) } : t)),
      },
    ],
    ['everything', everything()],
  ];
}

const queryOf = (plot: Plot): string =>
  serializeTraceQuery(plot.traces, plot.xAxis, plotConfigOf(plot, palette));

function ctxFor(plot: Plot, target: Target): ToolContext<TraceDotState, Model> {
  return {
    state: { plots: [plot], activePlotId: plot.id },
    model: {
      palette,
      fragmentInput: () => {
        throw new Error('no fragment input in this test');
      },
      inspect: () => {},
      createFormula: () => {},
    },
    update: () => {},
    selection: target.level === 'tool' ? null : target,
    target,
    capabilities: { elog: true },
    ui: {},
  } as ToolContext<TraceDotState, Model>;
}

interface Bound {
  /** Stable across a query round trip: a drawing gets a new id when decoded, so it is keyed by position. */
  key: string;
  target: Target;
  schema: ObjectSchema<TraceDotState, Model>;
}

/** Each object of `plot` a schema binds to, with that schema. */
function targetsOf(plot: Plot): Bound[] {
  const out: Bound[] = [];
  for (const { level, kind, schema } of SCHEMAS) {
    if (level === 'tool') out.push({ key: plot.id, target: { level, kind, id: plot.id }, schema });
    if (level === 'section') {
      for (const a of plot.axes) out.push({ key: a.id, target: { level, kind, id: a.id }, schema });
    }
    if (kind === PV_CURVE_ITEM_KIND) {
      for (const t of plot.traces.filter((t) => t.kind !== 'formula')) {
        out.push({ key: t.id, target: { level, kind, id: t.id }, schema });
      }
    }
    if (kind === DRAWING_ITEM_KIND) {
      (plot.annotations ?? []).forEach((a, i) =>
        out.push({ key: `drawing[${i}]`, target: { level, kind, id: a.id }, schema })
      );
    }
  }
  return out;
}

/** Every query-riding (plot, query or drawing class) field value of `plot`, keyed `<target key>#<field id>`. */
function ridingValues(plot: Plot): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, target, schema } of targetsOf(plot)) {
    const ctx = ctxFor(plot, target);
    for (const field of fieldsOf(schema)) {
      const cls = TRACE_FIELD_TABLE[field.id]?.class;
      if ((cls === 'plot' || cls === 'query' || cls === 'drawing') && 'get' in field) {
        out[`${key}#${field.id}`] = (field.get as (c: typeof ctx) => unknown)(ctx);
      }
    }
  }
  return out;
}

describe('Trace field table: round trip through the query', () => {
  it('the everything fixture sets every plot-class key off its default', () => {
    const config = plotConfigOf(everything(), palette) as PlotConfig;
    expect(config).toBeDefined();
    const present: Record<PlotConfigScope, Set<string>> = {
      plot: new Set(Object.keys(config)),
      axis: new Set((config.axes ?? []).flatMap((a) => Object.keys(a))),
      trace: new Set((config.traces ?? []).flatMap((t) => Object.keys(t))),
    };
    for (const scope of SCOPES) {
      for (const key of checks[scope]) {
        expect(present[scope].has(key), `${scope} key "${key}" not set by the fixture`).toBe(true);
      }
    }
  });

  it.each(views())('%s: the query re-serializes to unchanged bytes', (_name, plot) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const q1 = queryOf(plot);
    const back = opened(`?${q1}`);
    expect(queryOf(back)).toBe(q1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(views())('%s: every plot- and query-class field reads back the same', (_name, plot) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = ridingValues(plot);
    const after = ridingValues(opened(`?${queryOf(plot)}`));
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const [key, value] of Object.entries(before)) expect(after[key], key).toEqual(value);
  });

  it('session fields do not reach the query', () => {
    const plot = everything();
    const q = queryOf(plot);
    const changed: Plot = {
      ...plot,
      autoScroll: !plot.autoScroll,
      backgroundColor: '#fafafa',
      traces: plot.traces.map((t) =>
        t.kind === 'formula' ? { ...t, expression: 'a * 2' } : { ...t, liveRetentionMs: 123_000 }
      ),
    };
    expect(queryOf(changed)).toBe(q);
  });
});

// ── Drawing slots ───────────────────────────────────────────────────────────

/** The slot labels of `DrawingTuple`, read from annotations/config.ts's source (labels are type-only). */
function drawingTupleSlotsFromSource(): string[] {
  const body = /export type DrawingTuple = \[([\s\S]*?)\];/.exec(drawingConfigRaw)?.[1] ?? '';
  return [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
}

const drawingFields = (): [Field, DrawingSlotClass][] =>
  [...schemaFields().values()].flatMap((f) => {
    const c = TRACE_FIELD_TABLE[f.id];
    return c?.class === 'drawing' ? [[f, c] as [Field, DrawingSlotClass]] : [];
  });

type DrawingSlotClass = Extract<FieldClass, { class: 'drawing' }>;

const TUPLE_AXES = [axisAt(0, {}), axisAt(1, { name: 'Current' })];
const TUPLE_TRACES = [{ id: 'trace-a' }];
const TRACE_CODEC = { catalog: BUILTIN_CATALOG, xAxis: TIME_X_AXIS };

/** A drawing at every default: palette colour of index 0, width 1.5, no flags, no label. */
function defaultDrawing(kind: Annotation['kind']): Annotation {
  const two = kind !== 'hline' && kind !== 'vline' && kind !== 'note';
  return {
    id: 'annotation-x',
    kind,
    points: two
      ? [
          { t: 1_767_323_040_000, v: 1 },
          { t: 1_767_326_760_000, v: 2 },
        ]
      : [{ t: kind === 'hline' ? 0 : 1_767_323_040_000, v: kind === 'vline' ? 0 : 1 }],
    axisId: TUPLE_AXES[0].id,
    color: defaultAnnotationColor(0),
    width: 1.5,
    text: '',
  };
}

function drawingPlot(a: Annotation): Plot {
  return { ...opened('?range=-1h'), axes: TUPLE_AXES, annotations: [a] };
}

/** `field` set on `plot`'s only drawing to a value off its current one, through its own setter. */
function setOffDefault(field: Field, plot: Plot): Plot {
  let state: TraceDotState = { plots: [plot], activePlotId: plot.id };
  const target: Target = { level: 'item', kind: DRAWING_ITEM_KIND, id: plot.annotations![0].id };
  const ctx = {
    ...ctxFor(plot, target),
    update: (fn: (s: TraceDotState) => TraceDotState) => {
      state = fn(state);
    },
  } as ToolContext<TraceDotState, Model>;
  switch (field.kind) {
    case 'text':
      field.set(ctx, 'limit');
      break;
    case 'colour':
      field.set(ctx, '#123456');
      break;
    case 'number':
      field.set(ctx, (field.get(ctx) ?? 0) + 0.5);
      break;
    case 'toggle':
      field.set(ctx, !field.get(ctx));
      break;
    case 'select': {
      const other = field.options(ctx).find((o) => o.value !== field.get(ctx));
      field.set(ctx, other!.value);
      break;
    }
    default:
      throw new Error(`no off-default value for a ${field.kind} field (${field.id})`);
  }
  return state.plots[0];
}

const KINDS: Annotation['kind'][] = ['hline', 'vline', 'trange', 'trend', 'box', 'note', 'measure'];

/** The first kind whose drawing shows `field`. */
function kindShowing(field: Field): Annotation['kind'] {
  const kind = KINDS.find((k) => {
    const plot = drawingPlot(defaultDrawing(k));
    const target: Target = { level: 'item', kind: DRAWING_ITEM_KIND, id: 'annotation-x' };
    return !field.when || field.when(ctxFor(plot, target));
  });
  if (!kind) throw new Error(`no drawing kind shows ${field.id}`);
  return kind;
}

const SLOT_INDEX = (slot: string) => drawingTupleSlotsFromSource().indexOf(slot);

describe('Trace field table: drawing slots', () => {
  it('reads the DrawingTuple slots from annotations/config.ts', () => {
    expect(drawingTupleSlotsFromSource()).toEqual([
      'kindCode',
      'points',
      'axisIndex',
      'traceIndex',
      'color',
      'text',
      'flags',
    ]);
  });

  it('maps the drawing-class fields onto exactly the DrawingTuple slots (with the derived ones)', () => {
    const tuple = drawingTupleSlotsFromSource();
    const mapped = new Set(drawingFields().map(([, c]) => c.slot as string));
    expect(mapped.size).toBeGreaterThan(0);
    for (const slot of mapped) expect(tuple, `"${slot}" is no DrawingTuple slot`).toContain(slot);
    for (const slot of DERIVED_DRAWING_SLOTS) {
      expect(tuple, `derived "${slot}" is no DrawingTuple slot`).toContain(slot);
      expect(mapped.has(slot), `derived drawing slot "${slot}" now has a field`).toBe(false);
    }
    expect([...mapped, ...DERIVED_DRAWING_SLOTS].sort()).toEqual([...tuple].sort());
  });

  it('only drawing fields are drawing-class', () => {
    const drawingIds = new Set(
      fieldsOf(SCHEMAS.find((s) => s.kind === DRAWING_ITEM_KIND)!.schema).map((f) => f.id)
    );
    for (const [id, c] of entries) {
      if (c.class === 'drawing') expect(drawingIds.has(id), id).toBe(true);
    }
  });

  it.each(drawingFields().map(([f, c]) => [f.id, f, c] as const))(
    '%s round-trips through encodeDrawings/decodeDrawings off its default',
    (_id, field, cls) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const base = drawingPlot(defaultDrawing(kindShowing(field)));
      const changed = setOffDefault(field, base);
      expect(changed.annotations![0], 'the setter changed nothing').not.toEqual(
        base.annotations![0]
      );

      const before = encodeDrawings(base, TUPLE_TRACES, TRACE_CODEC)![0];
      const tuple = encodeDrawings(changed, TUPLE_TRACES, TRACE_CODEC)![0];
      // The change rides in the slot the field table names, and only there.
      const at = SLOT_INDEX(cls.slot);
      expect(tuple[at], `slot ${cls.slot}`).not.toEqual(before[at]);
      // A trailing empty slot is popped by the encoder: '' and absent are the same slot.
      const slot = (t: readonly unknown[], i: number) => (t[i] === '' ? undefined : t[i]);
      for (let i = 0; i < Math.max(tuple.length, before.length); i++) {
        if (i !== at) expect(slot(tuple, i), `slot ${i}`).toEqual(slot(before, i));
      }

      const decoded = decodeDrawings(
        JSON.parse(JSON.stringify([tuple])),
        changed,
        TUPLE_TRACES,
        TRACE_CODEC
      );
      expect(decoded).toHaveLength(1);
      const back: Plot = { ...changed, annotations: decoded };
      const read = (p: Plot) =>
        (field.get as (c: ToolContext<TraceDotState, Model>) => unknown)(
          ctxFor(p, { level: 'item', kind: DRAWING_ITEM_KIND, id: p.annotations![0].id })
        );
      expect(read(back)).toEqual(read(changed));
      expect(read(back)).not.toEqual(read(base));
      expect({ ...decoded[0], id: '' }).toEqual({ ...changed.annotations![0], id: '' });
      expect(warn).not.toHaveBeenCalled();
    }
  );
});
