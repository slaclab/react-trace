// Correlation's drawing schemas: the Drawings
// section (one field, the hide-all eye on `ui.drawingsHidden`) and the
// `annotation` item (the generic drawing schema over `state.drawings`, every
// write through `ctx.update`), plus the drawing-first move rule.
import { describe, expect, it, vi } from 'vitest';
import { CORRELATION_CATALOG } from '../../annotations/catalog';
import { DRAWING_ITEM_KIND, DRAWINGS_SECTION_KIND } from '../../annotations/host/workbench';
import type { Annotation } from '../../annotations/model';
import { defaultCorrelationState, normalizeCorrelationState, type CorrelationState } from './query';
import type { FieldDef, ObjectSchema, Target, ToolContext } from '../../workbench/types';
import { GROUPS } from '../vocabulary';
import {
  ANNOTATIONS_ONLY_REASON,
  CORRELATION_DRAWING_ACCESS,
  correlationDrawingAxes,
  correlationItemId,
  correlationMoveRefusal,
  correlationSchema,
  patchCorrelationDrawing,
  type CorrelationSchemaModel,
  type CorrelationUi,
} from './schema';
import {
  DRAWINGS_VISIBLE_FIELD_ID,
  DRAWING_STAYS_REASON,
  isListedDrawing,
} from '../shared/drawingOutline';

type S = CorrelationState;
type Ctx = ToolContext<S, CorrelationSchemaModel, CorrelationUi>;

const schema = correlationSchema();

function drawing(id: string, over: Partial<Annotation> = {}): Annotation {
  return {
    id,
    kind: 'hline',
    points: [{ t: 0, v: 1.5 }],
    axisId: 'Y:A',
    color: '#112233',
    width: 1.5,
    text: '',
    ...over,
  };
}

function makeState(over: Partial<S> = {}): S {
  return normalizeCorrelationState(
    { ...defaultCorrelationState(), x: 'X:PV', ys: ['Y:A', 'Y:B'], ...over },
    CORRELATION_CATALOG
  );
}

/** A context over a mutable state; `update` applies in place. */
function ctxOf(initial: S, target: Target, ui: CorrelationUi = {}) {
  const box = { state: initial };
  const ctx = {
    get state() {
      return box.state;
    },
    target,
    ui,
    model: {} as CorrelationSchemaModel,
    update: (fn: (s: S) => S) => {
      box.state = fn(box.state);
    },
  } as unknown as Ctx;
  return { ctx, box };
}

function fieldsOf(obj: ObjectSchema<S, CorrelationSchemaModel, CorrelationUi>) {
  return obj.tabs.flatMap((t) => t.fields);
}

function field(obj: ObjectSchema<S, CorrelationSchemaModel, CorrelationUi>, id: string) {
  const f = fieldsOf(obj).find((x) => x.id === id);
  if (!f) throw new Error(`no field ${id}`);
  return f as FieldDef<S, CorrelationSchemaModel, CorrelationUi> & {
    get(ctx: Ctx): unknown;
    set(ctx: Ctx, v: unknown): void;
  };
}

const sectionTarget: Target = {
  level: 'section',
  kind: DRAWINGS_SECTION_KIND,
  id: DRAWINGS_SECTION_KIND,
};
const itemTarget = (id: string): Target => ({ level: 'item', kind: DRAWING_ITEM_KIND, id });

describe('Correlation schema — drawings', () => {
  it('registers the Drawings section and the annotation item after the roles', () => {
    expect(Object.keys(schema.sections)).toEqual(['y', 'x', 'trig', DRAWINGS_SECTION_KIND]);
    expect(Object.keys(schema.items)).toEqual(['y', 'x', 'trig', DRAWING_ITEM_KIND]);
    expect(schema.sections[DRAWINGS_SECTION_KIND].group).toBe(GROUPS.drawings);
  });

  it('the section has one field: the header eye', () => {
    const fields = fieldsOf(schema.sections[DRAWINGS_SECTION_KIND]);
    expect(fields.map((f) => [f.id, f.kind, f.row])).toEqual([
      [DRAWINGS_VISIBLE_FIELD_ID, 'toggle', 'eye'],
    ]);
  });

  it('the eye reads !ui.drawingsHidden and writes it through ui.setUi', () => {
    const eye = field(schema.sections[DRAWINGS_SECTION_KIND], DRAWINGS_VISIBLE_FIELD_ID);
    let record: CorrelationUi = { drawingsHidden: false };
    const setUi = vi.fn((fn: (u: CorrelationUi) => CorrelationUi) => {
      record = fn(record);
    });
    const { ctx } = ctxOf(makeState(), sectionTarget, {
      get drawingsHidden() {
        return record.drawingsHidden;
      },
      setUi,
    });
    expect(eye.get(ctx)).toBe(true);
    eye.set(ctx, false);
    expect(record.drawingsHidden).toBe(true);
    expect(eye.get(ctx)).toBe(false);
    eye.set(ctx, true);
    expect(record.drawingsHidden).toBe(false);
  });

  it('a ui without the record shows every drawing and ignores the toggle', () => {
    const eye = field(schema.sections[DRAWINGS_SECTION_KIND], DRAWINGS_VISIBLE_FIELD_ID);
    const { ctx, box } = ctxOf(makeState(), sectionTarget, {});
    const before = box.state;
    expect(eye.get(ctx)).toBe(true);
    expect(() => eye.set(ctx, false)).not.toThrow();
    expect(box.state).toBe(before);
  });

  it('the item has the generic drawing tab over Correlation’s catalog', () => {
    const item = schema.items[DRAWING_ITEM_KIND];
    expect(item.tabs.map((t) => t.id)).toEqual(['drawing']);
    const ids = fieldsOf(item).map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['annotation-color', 'annotation-delete']));
  });

  it('the Colour field reads and writes the drawing through update', () => {
    const colour = field(schema.items[DRAWING_ITEM_KIND], 'annotation-color');
    const { ctx, box } = ctxOf(
      makeState({ drawings: [drawing('a1'), drawing('a2')] }),
      itemTarget('a2')
    );
    expect(colour.get(ctx)).toBe('#112233');
    colour.set(ctx, '#ff8800');
    expect(box.state.drawings.map((a) => a.color)).toEqual(['#112233', '#ff8800']);
    expect(box.state.drawings[1].id).toBe('a2');
  });

  it('the Axis options are the Ys, by label', () => {
    const state = makeState({ labels: { 'Y:B': 'Beam B' } });
    expect(correlationDrawingAxes(state)).toEqual([
      { id: 'Y:A', name: 'Y:A' },
      { id: 'Y:B', name: 'Beam B' },
    ]);
  });

  it('Delete removes the drawing through update', () => {
    const del = fieldsOf(schema.items[DRAWING_ITEM_KIND]).find(
      (f) => f.id === 'annotation-delete'
    ) as {
      run(ctx: Ctx): void;
    };
    const { ctx, box } = ctxOf(
      makeState({ drawings: [drawing('a1'), drawing('a2')] }),
      itemTarget('a1')
    );
    del.run(ctx);
    expect(box.state.drawings.map((a) => a.id)).toEqual(['a2']);
  });

  it('patch and remove keep the state for an unknown id or a no-op', () => {
    const state = makeState({ drawings: [drawing('a1')] });
    expect(patchCorrelationDrawing(state, 'nope', (a) => ({ ...a, color: '#000000' }))).toBe(state);
    expect(patchCorrelationDrawing(state, 'a1', (a) => a)).toBe(state);
    expect(CORRELATION_DRAWING_ACCESS.remove(state, 'nope')).toBe(state);
    expect(CORRELATION_DRAWING_ACCESS.list(state, 'a1')).toBe(state.drawings);
  });

  it('the move rule reads drawing ids before PV ids', () => {
    // A drawing whose id also parses as a PV item id.
    const tricky = drawing(correlationItemId('y', 'Y:A'));
    const state: S = { ...makeState(), drawings: [tricky] };
    expect(isListedDrawing(state, tricky.id)).toBe(true);
    expect(correlationMoveRefusal(state, tricky.id, 'x')).toBe(DRAWING_STAYS_REASON);
    expect(correlationMoveRefusal(makeState(), correlationItemId('y', 'Y:A'), 'x')).toBeNull();
    expect(
      correlationMoveRefusal(makeState(), correlationItemId('y', 'Y:A'), DRAWINGS_SECTION_KIND)
    ).toBe(ANNOTATIONS_ONLY_REASON);
  });
});
