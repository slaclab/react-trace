// @vitest-environment jsdom
//
// Trace's drawing item schema:
// - the Drawing tab lists Kind, Label, Colour, Width, Style, Axis, Value,
//   Extend, Locked, Visible and Delete, with the Layers row slots (swatch,
//   lock, eye) on Colour, Locked and Visible;
// - every field reads its drawing and every setter is a pure patch of the plot
//   holding it, through `withAnnotations` (optional flags stored only when set);
// - Axis shows only for kinds whose points carry a value, Value only for an
//   H-line, Extend only for a trend;
// - Delete removes the drawing (the last one deletes the plot's key);
// - in the Outline, a hidden drawing's row is muted and a visible one is not.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { defaultAnnotationColor } from '../../../annotationTheme';
import {
  MAX_ANNOTATION_TEXT,
  type Annotation,
  type AnnotationKind,
  hasValueAxisIn,
} from '../../../annotations/model';
import { DEFAULT_PALETTE_ID, getPalette } from '../../../palettes';
import type { Axis, Plot } from '../../../types';
import { Outline } from '../../../workbench/Outline';
import { SelectionProvider, createSelectionStore } from '../../../workbench/selection';
import type {
  FieldDef,
  Target,
  ToolBinding,
  ToolContext,
  ToolDefinition,
} from '../../../workbench/types';
import type { TraceDotState } from '../dots';
import { TRACE_SCHEMA, type TraceModel, type TraceState } from '../tool';
import { DRAWING_ITEM_KIND } from '../../../annotations/host/workbench';
import { annotationSchema } from './annotation';
import { BUILTIN_CATALOG } from '../../../annotations/catalog';

type Field = FieldDef<TraceDotState, unknown>;

const KINDS: AnnotationKind[] = ['hline', 'vline', 'trange', 'trend', 'box', 'note', 'measure'];

function axis(id: string, name: string): Axis {
  return { id, name, orientation: 'left', autoScale: true, logScale: false, visible: true };
}

function drawing(kind: AnnotationKind, over: Partial<Annotation> = {}): Annotation {
  const two = kind !== 'hline' && kind !== 'vline' && kind !== 'note';
  return {
    id: `d-${kind}`,
    kind,
    points: two
      ? [
          { t: 1000, v: 1 },
          { t: 2000, v: 2 },
        ]
      : [{ t: 1000, v: 2.5 }],
    axisId: 'ax1',
    color: defaultAnnotationColor(0),
    width: 1.5,
    text: '',
    ...over,
  };
}

function plot(id: string, annotations: Annotation[] | undefined): Plot {
  const p = {
    id,
    title: 'Plot 1',
    axes: [axis('ax1', 'Position'), axis('ax2', 'Current')],
    traces: [],
    xAxis: { timeRange: '-1h' },
  } as unknown as Plot;
  return annotations ? { ...p, annotations } : p;
}

const FIELDS = annotationSchema.tabs.flatMap((t) => t.fields) as Field[];
const field = (id: string) => {
  const f = FIELDS.find((x) => x.id === id);
  if (!f) throw new Error(`no field ${id}`);
  return f;
};

/** A ctx on drawing `id`, recording every update applied to `state`. */
function harness(state: TraceDotState, id: string) {
  const box = { state, updates: 0 };
  const target: Target = { level: 'item', kind: DRAWING_ITEM_KIND, id };
  const ctx = (): ToolContext<TraceDotState, unknown> => ({
    state: box.state,
    model: undefined,
    update: (fn) => {
      box.updates += 1;
      box.state = fn(box.state);
    },
    selection: target,
    target,
    capabilities: { elog: true },
    ui: {},
  });
  return { box, ctx };
}

function stateOf(...plots: Plot[]): TraceDotState {
  return { plots, activePlotId: plots[0].id };
}

const get = (f: Field, ctx: ToolContext<TraceDotState, unknown>) =>
  (f as { get(c: typeof ctx): unknown }).get(ctx);
const set = (f: Field, ctx: ToolContext<TraceDotState, unknown>, v: unknown) =>
  (f as { set(c: typeof ctx, v: unknown): void }).set(ctx, v);
const shown = (f: Field, ctx: ToolContext<TraceDotState, unknown>) => !f.when || f.when(ctx);

afterEach(cleanup);

describe('Drawing tab: shape', () => {
  it('is one "Drawing" tab with its fields in order', () => {
    expect(annotationSchema.tabs.map((t) => [t.id, t.label])).toEqual([['drawing', 'Drawing']]);
    expect(FIELDS.map((f) => [f.label, f.kind])).toEqual([
      ['Kind', 'readonly'],
      ['Label', 'text'],
      ['Colour', 'colour'],
      ['Width', 'select'],
      ['Style', 'select'],
      ['Axis', 'select'],
      ['Value', 'number'],
      ['Extend', 'select'],
      ['Locked', 'toggle'],
      ['Visible', 'toggle'],
      ['Delete', 'action'],
    ]);
    for (const f of FIELDS) expect(f.tab, f.id).toBe('drawing');
  });

  it('declares the Layers row slots: swatch on Colour, lock on Locked, eye on Visible', () => {
    const slots = FIELDS.filter((f) => 'row' in f && f.row !== undefined).map((f) => [
      f.id,
      (f as { row: string }).row,
    ]);
    expect(slots).toEqual([
      ['annotation-color', 'swatch'],
      ['annotation-locked', 'lock'],
      ['annotation-visible', 'eye'],
    ]);
  });

  it('is the Trace schema item of kind "annotation"', () => {
    const item = TRACE_SCHEMA.items[DRAWING_ITEM_KIND];
    expect(item).toBeDefined();
    expect(item.tabs.flatMap((t) => t.fields).map((f) => f.id)).toEqual(FIELDS.map((f) => f.id));
  });

  it('carries no modified dot', () => {
    for (const f of FIELDS) expect('modified' in f && f.modified !== undefined, f.id).toBe(false);
  });
});

describe('Drawing tab: reads', () => {
  it('reads every field of the drawing, in whichever plot holds it', () => {
    const a = drawing('trend', {
      id: 'x',
      color: '#123456',
      width: 3,
      dash: true,
      text: 'slope',
      extend: 'both',
      locked: true,
      hidden: true,
      axisId: 'ax2',
    });
    const { ctx } = harness(stateOf(plot('p1', undefined), plot('p2', [a])), 'x');
    expect(get(field('annotation-kind'), ctx())).toBe('Trend line');
    expect(get(field('annotation-label'), ctx())).toBe('slope');
    expect(get(field('annotation-color'), ctx())).toBe('#123456');
    expect(get(field('annotation-width'), ctx())).toBe('3');
    expect(get(field('annotation-style'), ctx())).toBe('dashed');
    expect(get(field('annotation-axis'), ctx())).toBe('ax2');
    expect(get(field('annotation-extend'), ctx())).toBe('both');
    expect(get(field('annotation-locked'), ctx())).toBe(true);
    expect(get(field('annotation-visible'), ctx())).toBe(false);
  });

  it('reads the defaults of a plain drawing', () => {
    const { ctx } = harness(stateOf(plot('p1', [drawing('hline')])), 'd-hline');
    expect(get(field('annotation-kind'), ctx())).toBe('Horizontal line');
    expect(get(field('annotation-width'), ctx())).toBe('1.5');
    expect(get(field('annotation-style'), ctx())).toBe('solid');
    expect(get(field('annotation-value'), ctx())).toBe(2.5);
    expect(get(field('annotation-locked'), ctx())).toBe(false);
    expect(get(field('annotation-visible'), ctx())).toBe(true);
  });

  it('labels every kind', () => {
    for (const k of KINDS) {
      const { ctx } = harness(stateOf(plot('p1', [drawing(k)])), `d-${k}`);
      expect(get(field('annotation-kind'), ctx())).toBe(BUILTIN_CATALOG.byKind(k)!.label.long);
    }
  });

  it('offers the holding plot axes for Axis', () => {
    const { ctx } = harness(stateOf(plot('p1', [drawing('box')])), 'd-box');
    const axisField = field('annotation-axis') as Extract<Field, { kind: 'select' }>;
    expect(axisField.options(ctx())).toEqual([
      { value: 'ax1', label: 'Position' },
      { value: 'ax2', label: 'Current' },
    ]);
  });
});

describe('Drawing tab: conditional fields', () => {
  it.each(KINDS)('%s shows Axis, Value and Extend as its kind allows', (kind) => {
    const { ctx } = harness(stateOf(plot('p1', [drawing(kind)])), `d-${kind}`);
    expect(shown(field('annotation-axis'), ctx())).toBe(hasValueAxisIn(BUILTIN_CATALOG, kind));
    expect(shown(field('annotation-value'), ctx())).toBe(kind === 'hline');
    expect(shown(field('annotation-extend'), ctx())).toBe(kind === 'trend');
    for (const id of [
      'annotation-kind',
      'annotation-label',
      'annotation-color',
      'annotation-width',
    ]) {
      expect(shown(field(id), ctx()), id).toBe(true);
    }
  });

  it('Axis is for the kinds whose points carry a value', () => {
    expect(KINDS.filter((k) => hasValueAxisIn(BUILTIN_CATALOG, k))).toEqual([
      'hline',
      'trend',
      'box',
      'note',
      'measure',
    ]);
  });
});

describe('Drawing tab: pure patches', () => {
  function patched(id: string, value: unknown, start: Annotation, others: Annotation[] = []) {
    const before = plot('p1', [start, ...others]);
    const other = plot('p0', [drawing('note', { id: 'elsewhere' })]);
    const state = stateOf(other, before);
    const frozen = JSON.stringify(state);
    const { box, ctx } = harness(state, start.id);
    set(field(id), ctx(), value);
    // Pure: the original state is untouched; the other plot keeps identity.
    expect(JSON.stringify(state)).toBe(frozen);
    expect(box.state.plots[0]).toBe(other);
    const p = box.state.plots[1];
    for (const o of others) expect(p.annotations!.find((a) => a.id === o.id)).toBe(o);
    return { a: p.annotations!.find((x) => x.id === start.id)!, box, ctx };
  }

  it('Label writes the text, clipped to what the tuple keeps', () => {
    expect(patched('annotation-label', 'limit', drawing('hline')).a.text).toBe('limit');
    const long = 'x'.repeat(MAX_ANNOTATION_TEXT + 20);
    expect(patched('annotation-label', long, drawing('hline')).a.text).toHaveLength(
      MAX_ANNOTATION_TEXT
    );
  });

  it('Colour writes the colour; an empty one is ignored', () => {
    expect(patched('annotation-color', '#abcdef', drawing('box')).a.color).toBe('#abcdef');
    const { box } = patched('annotation-color', '', drawing('box'));
    expect(box.state.plots[1].annotations![0].color).toBe(defaultAnnotationColor(0));
  });

  it('Width writes the numeric width; an unknown option is ignored', () => {
    expect(patched('annotation-width', '2', drawing('vline')).a.width).toBe(2);
    expect(patched('annotation-width', '1', drawing('vline')).a.width).toBe(1);
    expect(patched('annotation-width', '7', drawing('vline')).a.width).toBe(1.5);
  });

  it('Style stores dash only when dashed', () => {
    const on = patched('annotation-style', 'dashed', drawing('trange')).a;
    expect(on.dash).toBe(true);
    const off = patched('annotation-style', 'solid', drawing('trange', { dash: true })).a;
    expect('dash' in off).toBe(false);
  });

  it('Axis moves the drawing to another axis of its plot and drops the magnet trace', () => {
    const { a } = patched('annotation-axis', 'ax2', drawing('note', { traceId: 'curve-1' }));
    expect(a.axisId).toBe('ax2');
    expect('traceId' in a).toBe(false);
    // Not an axis of the plot: ignored.
    expect(patched('annotation-axis', 'nope', drawing('note')).a.axisId).toBe('ax1');
    // The same axis keeps the trace.
    const same = patched('annotation-axis', 'ax1', drawing('note', { traceId: 'curve-1' })).a;
    expect(same.traceId).toBe('curve-1');
  });

  it('Value writes the H-line value; an empty input is ignored', () => {
    expect(patched('annotation-value', 7.25, drawing('hline')).a.points).toEqual([
      { t: 1000, v: 7.25 },
    ]);
    expect(patched('annotation-value', null, drawing('hline')).a.points[0].v).toBe(2.5);
  });

  it('Extend stores right/both and deletes the key for none', () => {
    expect(patched('annotation-extend', 'right', drawing('trend')).a.extend).toBe('right');
    const none = patched('annotation-extend', 'none', drawing('trend', { extend: 'both' })).a;
    expect('extend' in none).toBe(false);
    // Only a trend extends.
    expect('extend' in patched('annotation-extend', 'both', drawing('box')).a).toBe(false);
  });

  it('Locked stores locked only when on', () => {
    expect(patched('annotation-locked', true, drawing('box')).a.locked).toBe(true);
    const off = patched('annotation-locked', false, drawing('box', { locked: true })).a;
    expect('locked' in off).toBe(false);
  });

  it('Visible writes or deletes hidden', () => {
    expect(patched('annotation-visible', false, drawing('box')).a.hidden).toBe(true);
    const shownAgain = patched('annotation-visible', true, drawing('box', { hidden: true })).a;
    expect('hidden' in shownAgain).toBe(false);
  });

  it('leaves the other drawings of the plot untouched', () => {
    const neighbour = drawing('vline', { id: 'n' });
    patched('annotation-color', '#abcdef', drawing('hline'), [neighbour]);
  });

  it('a setter on an unknown drawing changes nothing', () => {
    const state = stateOf(plot('p1', [drawing('hline')]));
    const { box, ctx } = harness(state, 'gone');
    for (const f of FIELDS) {
      if (f.kind === 'text') set(f, ctx(), 'x');
      if (f.kind === 'toggle') set(f, ctx(), true);
    }
    expect(box.state).toBe(state);
  });

  it('a write of the current value keeps the state identity', () => {
    const state = stateOf(plot('p1', [drawing('hline')]));
    const { box, ctx } = harness(state, 'd-hline');
    set(field('annotation-width'), ctx(), '1.5');
    set(field('annotation-style'), ctx(), 'solid');
    set(field('annotation-locked'), ctx(), false);
    set(field('annotation-visible'), ctx(), true);
    expect(box.state).toBe(state);
  });
});

describe('Drawing tab: Delete', () => {
  const del = field('annotation-delete') as Extract<Field, { kind: 'action' }>;

  it('removes the drawing and keeps the others', () => {
    const keep = drawing('vline', { id: 'keep' });
    const { box, ctx } = harness(stateOf(plot('p1', [drawing('hline'), keep])), 'd-hline');
    del.run(ctx());
    expect(box.state.plots[0].annotations).toEqual([keep]);
  });

  it('removing the last drawing deletes the plot key', () => {
    const { box, ctx } = harness(stateOf(plot('p1', [drawing('hline')])), 'd-hline');
    del.run(ctx());
    expect('annotations' in box.state.plots[0]).toBe(false);
  });
});

// ── Layers row ──────────────────────────────────────────────────────────────

describe('Drawing tab: Layers row', () => {
  function mount(list: Annotation[]) {
    const p = plot('p1', list);
    const state: TraceState = { plots: [p], activePlotId: p.id };
    const model = { palette: getPalette(DEFAULT_PALETTE_ID) } as unknown as TraceModel;
    // This binding lists the rows itself; `traceOutline`'s section has its own tests.
    const binding: ToolBinding<TraceState, TraceModel> = {
      outline: () => ({
        title: 'Plot 1',
        sections: [
          {
            id: 'annotations',
            kind: 'annotations',
            title: 'Drawings',
            count: list.length,
            rows: list.map((a) => ({
              id: a.id,
              kind: DRAWING_ITEM_KIND,
              label: a.kind,
              status: 'ok' as const,
            })),
          },
        ],
      }),
      ops: { add: async () => {}, remove: () => {}, move: () => {} },
      moveRefusal: () => null,
    };
    const definition: ToolDefinition<TraceState, TraceModel> = { schema: TRACE_SCHEMA, binding };
    render(
      createElement(
        SelectionProvider,
        { store: createSelectionStore() },
        createElement(Outline<TraceState, TraceModel>, {
          definition,
          state,
          model,
          ui: {},
          update: () => {},
          capabilities: { elog: true },
          catalog: [],
        })
      )
    );
  }

  const rowEl = (id: string) => document.querySelector(`[data-row-id="${id}"]`) as HTMLElement;

  it("mutes a hidden drawing's row and not a visible one", () => {
    mount([drawing('hline', { id: 'shown' }), drawing('box', { id: 'hidden', hidden: true })]);
    expect(rowEl('shown')).not.toBeNull();
    expect(rowEl('hidden')).not.toBeNull();
    expect(rowEl('hidden').closest('.wb-card')?.classList.contains('wb-card--muted')).toBe(true);
    expect(rowEl('shown').closest('.wb-card')?.classList.contains('wb-card--muted')).toBe(false);
  });

  it('renders the lock glyph and swatch slots on a drawing row', () => {
    mount([drawing('hline', { id: 'a', locked: true })]);
    expect(rowEl('a').querySelector('.wb-outline-row__lock')).not.toBeNull();
    expect(rowEl('a').querySelector('.wb-outline-row__eye')).not.toBeNull();
  });
});
