// The generic drawing workbench over a host that is not Trace: one flat
// drawing list with its own axes and catalog.
// - the Inspector lays out the common head, then each tool's own fields in
//   catalog order (one field per id, shown only for the tools declaring it),
//   then the common tail;
// - every write goes through the host's `patch`/`remove` via `ctx.update`;
// - the drawings section lists rows by `objName` and dims the rows the host
//   hides by context, with the host's reason.
import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS, CORRELATION_CATALOG, makeCatalog } from '../catalog/index';
import type { AxisRef, DrawingFieldSpec, DrawingTool } from '../catalog/types';
import { VALUE_X_AXIS } from '../catalog/xAxis';
import { ANNOTATION_INK } from '../../annotationTheme';
import { STYLE_WIDTHS, type Annotation } from '../model';
import type { FieldDef, Target, ToolContext } from '../../workbench/types';
import {
  createDrawingSchema,
  createDrawingsSectionSchema,
  DRAWING_ITEM_KIND,
  DRAWINGS_SECTION_KIND,
  drawingsSection,
  type DrawingAccess,
} from './workbench';

interface Host {
  drawings: Annotation[];
  axes: AxisRef[];
}

type Field = FieldDef<Host, unknown>;

const AXES: AxisRef[] = [
  { id: 'y1', name: 'Current', units: 'mA' },
  { id: 'y2', name: '' },
];

const access: DrawingAccess<Host> = {
  list: (state, id) => (state.drawings.some((a) => a.id === id) ? state.drawings : []),
  patch: (state, id, fn) => {
    const current = state.drawings.find((a) => a.id === id);
    if (!current) return state;
    const next = fn(current);
    if (next === current) return state;
    return { ...state, drawings: state.drawings.map((a) => (a.id === id ? next : a)) };
  },
  remove: (state, id) => ({ ...state, drawings: state.drawings.filter((a) => a.id !== id) }),
  axes: (state) => state.axes,
};

const tool = (kind: string) => BUILTIN_TOOLS.find((t) => t.kind === kind)!;

/** A test tool (codes 900+) with its own toggle field, gated on the drawing's text. */
const PIN_FIELD: DrawingFieldSpec = {
  id: 'probe-pinned',
  label: 'Pinned',
  kind: 'toggle',
  when: (a) => a.text !== 'unpinnable',
  get: (a) => a.text === 'pinned',
  set: (a, on) => {
    const text = on ? 'pinned' : '';
    return a.text === text ? a : { ...a, text };
  },
};
const PROBE_TOOL: DrawingTool = {
  ...tool('vline'),
  kind: 'probe',
  code: 900,
  key: undefined,
  label: { long: 'Probe line', short: 'Probe' },
  fields: [PIN_FIELD],
};
/** A second tool sharing the H-line's Value field id. */
const LEVEL_TOOL: DrawingTool = {
  ...tool('hline'),
  kind: 'level',
  code: 901,
  key: undefined,
  label: { long: 'Level', short: 'Level' },
};
const CATALOG = makeCatalog([...CORRELATION_CATALOG.tools, PROBE_TOOL, LEVEL_TOOL]);

const SCHEMA = createDrawingSchema<Host, unknown>(access, { catalog: CATALOG });
const FIELDS = SCHEMA.tabs.flatMap((t) => t.fields) as Field[];
const field = (id: string) => {
  const f = FIELDS.find((x) => x.id === id);
  if (!f) throw new Error(`no field ${id}`);
  return f;
};

function drawing(kind: string, over: Partial<Annotation> = {}): Annotation {
  const two = tool(kind)?.arity === 2;
  return {
    id: `d-${kind}`,
    kind,
    points: two
      ? [
          { t: 1, v: 1 },
          { t: 2, v: 2 },
        ]
      : [{ t: 1.5, v: 2.5 }],
    axisId: 'y1',
    color: '#336699',
    width: 1.5,
    text: '',
    ...over,
  };
}

function harness(state: Host, id: string) {
  const box = { state, updates: 0 };
  const target: Target = { level: 'item', kind: DRAWING_ITEM_KIND, id };
  const ctx = (): ToolContext<Host, unknown> => ({
    state: box.state,
    model: undefined,
    update: (fn) => {
      box.updates += 1;
      box.state = fn(box.state);
    },
    selection: target,
    target,
    capabilities: { elog: true, formulas: true },
    ui: {},
  });
  return { box, ctx };
}

const host = (...drawings: Annotation[]): Host => ({ drawings, axes: AXES });
const get = (f: Field, ctx: ToolContext<Host, unknown>) =>
  (f as { get(c: typeof ctx): unknown }).get(ctx);
const set = (f: Field, ctx: ToolContext<Host, unknown>, v: unknown) =>
  (f as { set(c: typeof ctx, v: unknown): void }).set(ctx, v);
const shown = (f: Field, ctx: ToolContext<Host, unknown>) => !f.when || f.when(ctx);

describe('createDrawingSchema: layout', () => {
  it('lays out the head, the tool fields in catalog order (one per id), then the tail', () => {
    expect(SCHEMA.tabs.map((t) => t.id)).toEqual(['drawing']);
    expect(FIELDS.map((f) => f.id)).toEqual([
      'annotation-kind',
      'annotation-label',
      'annotation-color',
      'annotation-width',
      'annotation-style',
      'annotation-axis',
      'annotation-value',
      'annotation-extend',
      'probe-pinned',
      'annotation-locked',
      'annotation-visible',
      'annotation-delete',
    ]);
  });

  it('rejects two tools that give one field id different kinds', () => {
    const clash: DrawingTool = {
      ...PROBE_TOOL,
      kind: 'clash',
      code: 902,
      fields: [{ ...PIN_FIELD, id: 'annotation-value' }],
    };
    expect(() =>
      createDrawingSchema(access, { catalog: makeCatalog([...BUILTIN_TOOLS, clash]) })
    ).toThrow(/annotation-value/);
  });
});

describe('createDrawingSchema: tool fields', () => {
  it('shows a tool field only for the tools that declare it, and its own when', () => {
    const cases: [string, Partial<Annotation>, Record<string, boolean>][] = [
      [
        'hline',
        {},
        { 'annotation-value': true, 'annotation-extend': false, 'probe-pinned': false },
      ],
      [
        'level',
        {},
        { 'annotation-value': true, 'annotation-extend': false, 'probe-pinned': false },
      ],
      [
        'trend',
        {},
        { 'annotation-value': false, 'annotation-extend': true, 'probe-pinned': false },
      ],
      [
        'probe',
        {},
        { 'annotation-value': false, 'annotation-extend': false, 'probe-pinned': true },
      ],
      ['probe', { text: 'unpinnable' }, { 'probe-pinned': false }],
    ];
    for (const [kind, over, expected] of cases) {
      const { ctx } = harness(host(drawing(kind, over)), `d-${kind}`);
      for (const [id, want] of Object.entries(expected)) {
        expect(shown(field(id), ctx()), `${kind} ${id}`).toBe(want);
      }
    }
  });

  it('reads and writes through the drawing tool spec', () => {
    const { box, ctx } = harness(host(drawing('level')), 'd-level');
    expect(get(field('annotation-value'), ctx())).toBe(2.5);
    set(field('annotation-value'), ctx(), 4);
    expect(box.state.drawings[0].points[0].v).toBe(4);

    const probe = harness(host(drawing('probe')), 'd-probe');
    expect(get(field('probe-pinned'), probe.ctx())).toBe(false);
    set(field('probe-pinned'), probe.ctx(), true);
    expect(probe.box.state.drawings[0].text).toBe('pinned');
    expect(get(field('probe-pinned'), probe.ctx())).toBe(true);
  });

  it('a tool field write on a tool that lacks it changes nothing', () => {
    const state = host(drawing('box'));
    const { box, ctx } = harness(state, 'd-box');
    set(field('annotation-extend'), ctx(), 'both');
    set(field('probe-pinned'), ctx(), true);
    set(field('annotation-value'), ctx(), 9);
    expect(box.state).toBe(state);
    expect(get(field('annotation-value'), ctx())).toBeNull();
    expect(get(field('probe-pinned'), ctx())).toBe(false);
    expect(
      (field('annotation-extend') as Extract<Field, { kind: 'select' }>).options(ctx())
    ).toEqual([]);
  });

  it('offers the select options of the drawing tool', () => {
    const { ctx } = harness(host(drawing('trend')), 'd-trend');
    const extend = field('annotation-extend') as Extract<Field, { kind: 'select' }>;
    expect(extend.options(ctx()).map((o) => o.value)).toEqual(['none', 'right', 'both']);
  });
});

describe('createDrawingSchema: common fields', () => {
  it('labels the kind from the catalog, and an unknown kind by itself', () => {
    expect(get(field('annotation-kind'), harness(host(drawing('probe')), 'd-probe').ctx())).toBe(
      'Probe line'
    );
    const stray = harness(host(drawing('box', { kind: 'gone' })), 'd-box');
    expect(get(field('annotation-kind'), stray.ctx())).toBe('gone');
    expect(shown(field('annotation-axis'), stray.ctx())).toBe(false);
  });

  it('shows Axis only for tools whose points carry a value', () => {
    for (const [kind, want] of [
      ['vline', false],
      ['probe', false],
      ['hline', true],
      ['box', true],
    ] as const) {
      const { ctx } = harness(host(drawing(kind)), `d-${kind}`);
      expect(shown(field('annotation-axis'), ctx()), kind).toBe(want);
    }
  });

  it('offers the host axes for Axis, unnamed ones by position', () => {
    const { ctx } = harness(host(drawing('box')), 'd-box');
    const axis = field('annotation-axis') as Extract<Field, { kind: 'select' }>;
    expect(axis.options(ctx())).toEqual([
      { value: 'y1', label: 'Current' },
      { value: 'y2', label: 'Y-Axis 2' },
    ]);
  });

  it('writes the common fields through the host patch, flags stored only when set', () => {
    const { box, ctx } = harness(host(drawing('box', { traceId: 'pv:a' })), 'd-box');
    set(field('annotation-color'), ctx(), '#abcdef');
    set(field('annotation-width'), ctx(), '3');
    set(field('annotation-style'), ctx(), 'dashed');
    set(field('annotation-axis'), ctx(), 'y2');
    set(field('annotation-locked'), ctx(), true);
    set(field('annotation-visible'), ctx(), false);
    set(field('annotation-label'), ctx(), 'x'.repeat(500));
    const a = box.state.drawings[0];
    expect(a).toMatchObject({
      color: '#abcdef',
      width: 3,
      dash: true,
      axisId: 'y2',
      locked: true,
      hidden: true,
    });
    expect(a.text.length).toBe(200);
    expect('traceId' in a).toBe(false);

    set(field('annotation-style'), ctx(), 'solid');
    set(field('annotation-locked'), ctx(), false);
    set(field('annotation-visible'), ctx(), true);
    const b = box.state.drawings[0];
    expect(['dash' in b, 'locked' in b, 'hidden' in b]).toEqual([false, false, false]);
  });

  it('ignores an unknown axis, width or empty colour, and keeps the state identity', () => {
    const state = host(drawing('box'));
    const { box, ctx } = harness(state, 'd-box');
    set(field('annotation-axis'), ctx(), 'nope');
    set(field('annotation-width'), ctx(), '7');
    set(field('annotation-color'), ctx(), '');
    set(field('annotation-style'), ctx(), 'solid');
    expect(box.state).toBe(state);
  });

  it('shows an ink drawing in the chrome text colour, which follows the theme', () => {
    const { ctx } = harness(host(drawing('box', { color: ANNOTATION_INK })), 'd-box');
    expect(get(field('annotation-color'), ctx())).toBe('var(--cds-text-primary)');
    const other = harness(host(drawing('box')), 'd-box');
    expect(get(field('annotation-color'), other.ctx())).toBe('#336699');
    // The swatch value written back keeps the drawing in ink.
    set(field('annotation-color'), other.ctx(), 'var(--cds-text-primary)');
    expect(other.box.state.drawings[0].color).toBe(ANNOTATION_INK);
  });

  it('offers the style widths, and a drawing its own width when it holds another', () => {
    const width = field('annotation-width') as Extract<Field, { kind: 'select' }>;
    const values = (a: Annotation) =>
      width.options(harness(host(a), a.id).ctx()).map((o) => o.value);
    expect(STYLE_WIDTHS).toEqual([0.5, 0.75, 1, 1.5, 2]);
    expect(values(drawing('box'))).toEqual(['0.5', '0.75', '1', '1.5', '2']);
    expect(values(drawing('box', { width: 3 }))).toEqual(['0.5', '0.75', '1', '1.5', '2', '3']);
    expect(width.options(harness(host(drawing('box')), 'd-box').ctx())[1]).toEqual({
      value: '0.75',
      label: '0.75 px',
    });
    const { box, ctx } = harness(host(drawing('box')), 'd-box');
    expect(get(width, ctx())).toBe('1.5');
    set(width, ctx(), '0.75');
    expect(box.state.drawings[0].width).toBe(0.75);
  });

  it('Delete removes the drawing through the host', () => {
    const keep = drawing('vline');
    const { box, ctx } = harness(host(drawing('box'), keep), 'd-box');
    (field('annotation-delete') as Extract<Field, { kind: 'action' }>).run(ctx());
    expect(box.state.drawings).toEqual([keep]);
  });
});

describe('createDrawingsSectionSchema', () => {
  it('is one header eye bound to the host', () => {
    let hidden = false;
    const section = createDrawingsSectionSchema<Host, unknown>(
      { id: 'drawings-visible', get: () => !hidden, set: (_ctx, on) => (hidden = !on) },
      'Drawings'
    );
    expect(section.tabs.map((t) => [t.id, t.label])).toEqual([[DRAWINGS_SECTION_KIND, 'Drawings']]);
    const [eye] = section.tabs[0].fields;
    expect([eye.id, eye.kind, (eye as { row?: string }).row]).toEqual([
      'drawings-visible',
      'toggle',
      'eye',
    ]);
    const { ctx } = harness(host(), 'x');
    set(eye as Field, ctx(), false);
    expect(hidden).toBe(true);
    expect(get(eye as Field, ctx())).toBe(false);
  });
});

describe('drawingsSection', () => {
  it('lists the drawings by objName in order, dimming the hidden ones with their reason', () => {
    const list = [
      drawing('hline', { id: 'a' }),
      drawing('vline', { id: 'b' }),
      drawing('note', { id: 'c', text: 'hi', axisId: 'y2' }),
    ];
    const section = drawingsSection(
      list,
      AXES,
      (a) => (a.axisId === 'y2' ? 'x source changed' : null),
      { catalog: CATALOG, xAxis: VALUE_X_AXIS, title: 'Drawings' }
    );
    expect(section).toMatchObject({
      id: DRAWINGS_SECTION_KIND,
      kind: DRAWINGS_SECTION_KIND,
      title: 'Drawings',
      unit: 'drawing',
      count: 3,
    });
    expect(section.rows.map((r) => [r.id, r.kind, r.status, r.refusal])).toEqual([
      ['a', DRAWING_ITEM_KIND, 'ok', undefined],
      ['b', DRAWING_ITEM_KIND, 'ok', undefined],
      ['c', DRAWING_ITEM_KIND, 'stale', 'x source changed'],
    ]);
    expect(section.rows[0].label).toBe(
      tool('hline').objName(list[0], { axis: AXES[0], xAxis: VALUE_X_AXIS })
    );
    expect(section.rows[1].label).toBe(
      tool('vline').objName(list[1], { axis: AXES[0], xAxis: VALUE_X_AXIS })
    );
    expect('refusal' in section.rows[0]).toBe(false);
  });

  it('is an empty section for no drawings, with the default title', () => {
    expect(
      drawingsSection([], AXES, () => null, { catalog: CATALOG, xAxis: VALUE_X_AXIS })
    ).toMatchObject({
      title: 'Drawings',
      count: 0,
      rows: [],
    });
  });
});
