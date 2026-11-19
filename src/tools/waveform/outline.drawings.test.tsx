// @vitest-environment jsdom
//
// Waveform's Drawings section and `annotation` item kind: the generic workbench pieces over `state.drawings`.
//
// - the schema registers `sections.annotations` (the Hide-all eye bound to
//   `ui.drawingsHidden`) and `items.annotation` (the drawing card);
// - the Outline lists drawings only while there are any, a drawing hidden by
//   context (the rendered x, Δ) dimmed with `waveformHiddenReason`'s reason;
// - `ops.remove` deletes a drawing through `update`; a drawing moves nowhere;
// - card writes go through `ctx.update` (`patch`/`remove` of the access);
// - the view-model is kept across frames and rebuilt when the rendered x moves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { drawingThemeFor } from '../../annotationTheme';
import type { Annotation } from '../../annotations/model';
import { DRAWING_ITEM_KIND, DRAWINGS_SECTION_KIND } from '../../annotations/host/workbench';
import { DELTA_CHANGED, WAVEFORM_AXIS_ID, X_SOURCE_CHANGED } from './drawings';
import { deriveWaveformModel, type WaveformRingSummary } from './model';
import type { WaveformPlotInput } from './plotOption';
import { defaultWaveformState, normalizeWaveformState, type WaveformState } from './query';
import { Outline } from '../../workbench/Outline';
import { SelectionProvider, createSelectionStore } from '../../workbench/selection';
import type {
  FieldDef,
  OutlineSection,
  ToolContext,
  ToolSchema,
  ToolUi,
} from '../../workbench/types';
import { waveformBinding, waveformOutline } from './outline';
import { DRAWING_STAYS_REASON, DRAWINGS_VISIBLE_FIELD_ID } from '../shared/drawingOutline';
import { WAVEFORM_DRAWING_ACCESS, waveformSchema, type WaveformUi } from './schema';
import {
  useWaveformDefinition,
  type WaveformProbe,
  type WaveformToolModel,
  type WaveformUiRecord,
} from './tool';

type State = WaveformState;

const A = 'WF:A';
const XS = 'WF:S';

const ring = (length: number): WaveformRingSummary => ({
  connected: true,
  length,
  resetEpoch: 0,
  arrival: 1,
});

function drawing(over: Partial<Annotation> = {}): Annotation {
  return {
    id: 'annotation-1-0',
    kind: 'vline',
    points: [{ t: 3, v: 0 }],
    axisId: WAVEFORM_AXIS_ID,
    color: '#ff0000',
    width: 1.5,
    text: '',
    xRef: 'index',
    ...over,
  };
}

function stateOf(patch: Partial<State>): State {
  return normalizeWaveformState({ ...defaultWaveformState(), pvs: [A], ...patch });
}

function modelOf(state: State): WaveformToolModel {
  const waveform = deriveWaveformModel({
    state,
    rings: { [A]: ring(8), [XS]: ring(8) },
    meta: { [A]: { egu: 'mm' } },
    metaTimedOut: true,
  });
  return {
    waveform,
    fragmentInput: (s: State): WaveformPlotInput => ({
      state: s,
      model: waveform,
      frames: { live: {}, reference: null, x: null },
      widthPx: 600,
      theme: drawingThemeFor('light'),
    }),
  };
}

const probe: WaveformProbe = {
  probe: async () => ({ ok: true, info: { pv: '', status: 'ok', units: '' } }),
  endProbe: () => {},
};

type Ctx = ToolContext<State, WaveformToolModel, WaveformUi>;
type Field = FieldDef<State, WaveformToolModel, WaveformUi>;
const get = (f: Field, ctx: Ctx) => (f as { get(c: Ctx): unknown }).get(ctx);
const set = (f: Field, ctx: Ctx, v: unknown) =>
  (f as { set(c: Ctx, v: unknown): void }).set(ctx, v);

function drawingsOf(sections: readonly OutlineSection[]): OutlineSection | undefined {
  return sections.find((s) => s.id === DRAWINGS_SECTION_KIND);
}

afterEach(() => {
  cleanup();
});

// ------------------------------------------------------------------ schema --

describe('waveform schema: drawings', () => {
  const schema = waveformSchema();

  it('registers the Annotations section and the annotation item kind', () => {
    expect(schema.sections[DRAWINGS_SECTION_KIND]).toBeDefined();
    expect(schema.items[DRAWING_ITEM_KIND]).toBeDefined();
    // The curve sections and items are untouched.
    expect(Object.keys(schema.sections)).toEqual(['live', 'reference', 'xsource', 'annotations']);
    expect(Object.keys(schema.items)).toEqual(['live', 'reference', 'xsource', 'annotation']);
  });

  function eyeOf(s: ToolSchema<State, WaveformToolModel, WaveformUi>) {
    const fields = s.sections[DRAWINGS_SECTION_KIND]!.tabs.flatMap((t) => t.fields);
    const eye = fields.find((f) => f.id === DRAWINGS_VISIBLE_FIELD_ID);
    if (!eye) throw new Error('no eye');
    expect(eye.row).toBe('eye');
    return eye;
  }

  function ctxOf(state: State, ui: ToolUi, update = vi.fn()) {
    return {
      state,
      model: modelOf(state),
      update,
      selection: null,
      target: { level: 'section', kind: DRAWINGS_SECTION_KIND, id: DRAWINGS_SECTION_KIND },
      capabilities: { elog: false },
      ui,
    } as unknown as ToolContext<State, WaveformToolModel, WaveformUi>;
  }

  it('the eye shows drawings unless ui.drawingsHidden, and a ui of {} shows all', () => {
    const eye = eyeOf(waveformSchema());
    const state = stateOf({});
    expect(get(eye, ctxOf(state, {}))).toBe(true);
    expect(get(eye, ctxOf(state, { drawingsHidden: false }))).toBe(true);
    expect(get(eye, ctxOf(state, { drawingsHidden: true }))).toBe(false);
  });

  it('the eye writes drawingsHidden through the schema writer', () => {
    let ui: WaveformUi = {};
    const setUi = vi.fn((fn: (u: WaveformUi) => WaveformUi) => {
      ui = fn(ui);
    });
    const eye = eyeOf(waveformSchema({ setUi }));
    set(eye, ctxOf(stateOf({}), ui), false);
    expect(ui).toEqual({ drawingsHidden: true });
    set(eye, ctxOf(stateOf({}), ui), true);
    expect(ui).toEqual({ drawingsHidden: false });
    expect(setUi).toHaveBeenCalledTimes(2);
  });

  it('the eye prefers a writer carried on the ui record', () => {
    const own = vi.fn();
    const fallback = vi.fn();
    const eye = eyeOf(waveformSchema({ setUi: fallback }));
    set(eye, ctxOf(stateOf({}), { setUi: own }), false);
    expect(own).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('the eye without any writer does nothing', () => {
    const eye = eyeOf(waveformSchema());
    expect(() => set(eye, ctxOf(stateOf({}), {}), false)).not.toThrow();
  });

  it('the drawing card edits through ctx.update with the access patch', () => {
    const item = schema.items[DRAWING_ITEM_KIND]!;
    const fields = item.tabs.flatMap((t) => t.fields);
    const d = drawing({ text: 'old' });
    let state = stateOf({ drawings: [d] });
    const update = vi.fn((fn: (s: State) => State) => {
      state = fn(state);
    });
    const ctx = {
      ...ctxOf(state, {}, update),
      target: { level: 'item', kind: DRAWING_ITEM_KIND, id: d.id },
    } as unknown as ToolContext<State, WaveformToolModel, WaveformUi>;
    const label = fields.find((f) => f.id === 'annotation-label')!;
    expect(get(label, ctx)).toBe('old');
    set(label, ctx, 'new');
    expect(update).toHaveBeenCalledTimes(1);
    expect(state.drawings[0]!.text).toBe('new');
    // The Kind reads Waveform's catalog.
    const kind = fields.find((f) => f.id === 'annotation-kind')!;
    expect(get(kind, ctx)).not.toBe('');
  });
});

describe('waveform drawing access', () => {
  it('patches a drawing, keeping the state when nothing changes or the id is unknown', () => {
    const d = drawing();
    const state = stateOf({ drawings: [d] });
    expect(WAVEFORM_DRAWING_ACCESS.patch(state, d.id, (a) => a)).toBe(state);
    expect(WAVEFORM_DRAWING_ACCESS.patch(state, 'nope', (a) => ({ ...a, color: '#00ff00' }))).toBe(
      state
    );
    const next = WAVEFORM_DRAWING_ACCESS.patch(state, d.id, (a) => ({ ...a, color: '#00ff00' }));
    expect(next.drawings[0]!.color).toBe('#00ff00');
    expect(state.drawings[0]!.color).toBe('#ff0000');
  });

  it('removes a drawing; lists state.drawings; names the one y axis', () => {
    const d = drawing();
    const e = drawing({ id: 'annotation-2-0' });
    const state = stateOf({ drawings: [d, e] });
    expect(WAVEFORM_DRAWING_ACCESS.list(state, d.id)).toBe(state.drawings);
    expect(WAVEFORM_DRAWING_ACCESS.remove(state, d.id).drawings.map((a) => a.id)).toEqual([e.id]);
    expect(WAVEFORM_DRAWING_ACCESS.remove(state, 'nope')).toBe(state);
    expect(WAVEFORM_DRAWING_ACCESS.axes(state, d.id).map((a) => a.id)).toEqual([WAVEFORM_AXIS_ID]);
  });
});

// ----------------------------------------------------------------- outline --

describe('waveform outline: drawings section', () => {
  it('lists no Annotations section while there are no drawings', () => {
    const state = stateOf({});
    const vm = waveformOutline(state, modelOf(state).waveform, undefined, 'index');
    expect(drawingsOf(vm.sections)).toBeUndefined();
  });

  it('lists drawings in order, rows of kind annotation, ok while the context matches', () => {
    const d = drawing();
    const e = drawing({ id: 'annotation-2-0', kind: 'hline', xRef: undefined });
    const state = stateOf({ drawings: [d, e] });
    const vm = waveformOutline(state, modelOf(state).waveform, undefined, 'index');
    const section = drawingsOf(vm.sections)!;
    expect(section.kind).toBe(DRAWINGS_SECTION_KIND);
    expect(section.count).toBe(2);
    expect(section.rows.map((r) => [r.id, r.kind, r.status])).toEqual([
      [d.id, DRAWING_ITEM_KIND, 'ok'],
      [e.id, DRAWING_ITEM_KIND, 'ok'],
    ]);
    expect(section.rows.every((r) => r.label !== '')).toBe(true);
    // The curve sections stay first.
    expect(vm.sections.map((s) => s.id)).toEqual(['live', 'reference', 'xsource', 'annotations']);
  });

  it('dims a drawing placed against another x source with the reason', () => {
    const d = drawing({ xRef: 'index' });
    const h = drawing({ id: 'annotation-2-0', kind: 'hline', xRef: 'index' });
    const state = stateOf({ drawings: [d, h] });
    const vm = waveformOutline(state, modelOf(state).waveform, undefined, `src:${XS}`);
    const rows = drawingsOf(vm.sections)!.rows;
    expect(rows[0]).toMatchObject({ status: 'stale', refusal: X_SOURCE_CHANGED });
    // An H-line ignores x.
    expect(rows[1]).toMatchObject({ status: 'ok' });
    expect(rows[1]!.refusal).toBeUndefined();
  });

  it('dims a drawing placed against Δ while Δ is off', () => {
    const d = drawing({ delta: true });
    const state = stateOf({ drawings: [d] });
    const vm = waveformOutline(state, modelOf(state).waveform, undefined, 'index');
    expect(drawingsOf(vm.sections)!.rows[0]).toMatchObject({
      status: 'stale',
      refusal: DELTA_CHANGED,
    });
  });

  it('without a rendered x skips the x check', () => {
    const d = drawing({ xRef: `src:${XS}` });
    const state = stateOf({ drawings: [d] });
    const vm = waveformOutline(state, modelOf(state).waveform);
    expect(drawingsOf(vm.sections)!.rows[0]!.status).toBe('ok');
  });
});

describe('waveform binding: drawings', () => {
  let state: State;
  const update = vi.fn((fn: (s: State) => State) => {
    state = fn(state);
  });

  beforeEach(() => {
    update.mockClear();
    state = stateOf({ drawings: [drawing()] });
  });

  it('removes a drawing through update', () => {
    const b = waveformBinding({ getState: () => state, update, probe });
    b.ops.remove('annotation-1-0');
    expect(update).toHaveBeenCalledTimes(1);
    expect(state.drawings).toEqual([]);
    // The curves are untouched.
    expect(state.pvs).toEqual([A]);
  });

  it('refuses and ignores moving a drawing', () => {
    const b = waveformBinding({ getState: () => state, update, probe });
    expect(b.moveRefusal('annotation-1-0', 'live')).toBe(DRAWING_STAYS_REASON);
    b.ops.move('annotation-1-0', 'live');
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps the view-model across frames and rebuilds it when the rendered x moves', () => {
    let rendered = 'index';
    const b = waveformBinding({
      getState: () => state,
      update,
      probe,
      getRenderedX: () => rendered,
    });
    const first = b.outline(state, modelOf(state));
    // A new model object of the same content (a data tick).
    expect(b.outline(state, modelOf(state))).toBe(first);
    rendered = `src:${XS}`;
    const moved = b.outline(state, modelOf(state));
    expect(moved).not.toBe(first);
    expect(drawingsOf(moved.sections)!.rows[0]).toMatchObject({
      status: 'stale',
      refusal: X_SOURCE_CHANGED,
    });
    expect(b.outline(state, modelOf(state))).toBe(moved);
  });
});

// -------------------------------------------------------------- definition --

describe('useWaveformDefinition: drawing inputs', () => {
  it('passes the rendered x to the binding and keeps the definition across equal x', () => {
    const state = stateOf({ drawings: [drawing({ xRef: 'index' })] });
    const update = vi.fn();
    const { result, rerender } = renderHook(
      ({ renderedX }: { renderedX: string }) =>
        useWaveformDefinition({ state, update, probe, renderedX, drawings: state.drawings }),
      { initialProps: { renderedX: 'index' } }
    );
    const first = result.current;
    expect(drawingsOf(first.binding.outline(state, modelOf(state)).sections)!.rows[0]!.status).toBe(
      'ok'
    );
    rerender({ renderedX: 'index' });
    expect(result.current).toBe(first);
    rerender({ renderedX: `src:${XS}` });
    expect(result.current.schema).toBe(first.schema);
    expect(
      drawingsOf(result.current.binding.outline(state, modelOf(state)).sections)!.rows[0]
    ).toMatchObject({ status: 'stale', refusal: X_SOURCE_CHANGED });
  });

  it('the Outline header eye writes the ui record through setUi', () => {
    let written: WaveformUiRecord | null = null;
    function Harness() {
      const [state, setState] = useState(() => stateOf({ drawings: [drawing()] }));
      const [ui, setUiState] = useState<WaveformUiRecord>({});
      const setUi = (fn: (u: WaveformUiRecord) => WaveformUiRecord) =>
        setUiState((prev) => {
          const next = fn(prev);
          written = next;
          return next;
        });
      const definition = useWaveformDefinition({
        state,
        update: setState,
        probe,
        renderedX: 'index',
        ui,
        setUi,
      });
      return (
        <SelectionProvider store={createSelectionStore()}>
          <Outline
            definition={definition}
            state={state}
            model={modelOf(state)}
            ui={ui}
            update={setState}
            capabilities={{ elog: false }}
            catalog={[]}
          />
        </SelectionProvider>
      );
    }
    const { getByTestId } = render(<Harness />);
    const row = document.querySelector(`[data-row-id="annotation-1-0"]`);
    expect(row).not.toBeNull();
    act(() => {
      fireEvent.click(getByTestId(DRAWINGS_VISIBLE_FIELD_ID));
    });
    expect(written).toEqual({ drawingsHidden: true });
  });
});
