// @vitest-environment jsdom
//
// Layers › Annotations, rendered through the workbench Outline with Trace's
// real definition:
//
// - the section and its rows (objName labels, status ok; stale "Axis hidden"
//   when a value-bearing drawing's axis is hidden);
// - the header eye reads/writes `ui.annotationsHidden` for the active plot,
//   changes no Plot field, and empties a mounted overlay;
// - the row trash removes the drawing, and ⌘Z with focus on an Annotations row
//   restores it (the owner's history-wrapped `update`, as TraceApp's);
// - a drawing dropped on any section and a curve dropped on Annotations are
//   refused with the right message.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { drawingThemeFor } from '../../annotationTheme';
import { AnnotationLayer } from '../../annotations/AnnotationLayer';
import { createProjectionStore, type Projection } from '../../plot/geometry';
import { projectionOf } from '../../plot/testUtils';
import { isUndoKey } from '../../annotations/history';
import {
  popAnnotationHistory,
  withAnnotationHistory,
  type AnnotationHistoryState,
} from './drawing/history';
import { type Annotation, objNameIn } from '../../annotations/model';
import { newAxis, newPlot, newTrace } from '../../embed/plotConfig';
import { DEFAULT_PALETTE_ID, getPalette } from '../../palettes';
import type { Axis, Plot, PVTrace } from '../../types';
import { Outline } from '../../workbench/Outline';
import { SelectionProvider, createSelectionStore } from '../../workbench/selection';
import { TESTIDS } from '../../workbench/testids';
import type { ToolBinding } from '../../workbench/types';
import type { TraceFragmentInput } from './codeFragments';
import { AXIS_HIDDEN_HINT, UNKNOWN_AXIS_REASON, traceMoveRefusal } from './outline';
import { DRAWING_ITEM_KIND, DRAWINGS_SECTION_KIND } from '../../annotations/host/workbench';
import { DRAWING_STAYS_REASON, DRAWINGS_VISIBLE_FIELD_ID } from '../shared/drawingOutline';
import {
  TRACE_SCHEMA,
  useTraceDefinition,
  type TraceModel,
  type TraceState,
  type TraceUi,
} from './tool';
import { BUILTIN_CATALOG } from '../../annotations/catalog';
import { TIME_X_AXIS } from '../../annotations/catalog/xAxis';

const TRACE_LAYER = { catalog: BUILTIN_CATALOG, xAxis: TIME_X_AXIS };

type AppState = TraceState & AnnotationHistoryState;

function axis(id: string, index: number, patch: Partial<Axis> = {}): Axis {
  return { ...newAxis(id, index), ...patch };
}

function curve(id: string, axisId: string): PVTrace {
  return { ...newTrace(id, `PV:${id}`, axisId, '#0f62fe', []), useLive: false, useArchive: false };
}

function ann(over: Partial<Annotation> & Pick<Annotation, 'id' | 'kind' | 'points'>): Annotation {
  return { axisId: 'ax1', color: '#4589ff', width: 2, text: '', ...over };
}

const HLINE = ann({ id: 'd-h', kind: 'hline', points: [{ t: 1000, v: 50 }] });
const VLINE = ann({ id: 'd-v', kind: 'vline', points: [{ t: 2000, v: 0 }] });
const BOX_ON_HIDDEN = ann({
  id: 'd-box',
  kind: 'box',
  axisId: 'ax2',
  points: [
    { t: 1000, v: 10 },
    { t: 3000, v: 20 },
  ],
});
const VLINE_ON_HIDDEN = ann({
  id: 'd-v2',
  kind: 'vline',
  axisId: 'ax2',
  points: [{ t: 2500, v: 0 }],
});

function opening(annotations: Annotation[] = [HLINE, VLINE]): AppState {
  const p1: Plot = {
    ...newPlot('p1', 0),
    title: 'Beam',
    axes: [axis('ax1', 0, { name: 'Y' }), axis('ax2', 1, { name: 'Hidden', visible: false })],
    traces: [curve('t1', 'ax1')],
    annotations,
  };
  const p2: Plot = {
    ...newPlot('p2', 1),
    title: 'Other',
    axes: [axis('bx1', 0)],
    traces: [],
    annotations: [ann({ id: 'other', kind: 'hline', axisId: 'bx1', points: [{ t: 0, v: 1 }] })],
  };
  return { activePlotId: 'p1', plots: [p1, p2], history: new Map() };
}

const MODEL: TraceModel = {
  palette: getPalette(DEFAULT_PALETTE_ID),
  fragmentInput: (p: Plot): TraceFragmentInput => ({
    plot: p,
    archiveResults: new Map(),
    liveResults: new Map(),
    formulaResults: new Map(),
    theme: drawingThemeFor('light'),
  }),
  inspect: () => {},
  createFormula: () => {},
};

// The overlay's projection: grid (0,0) 400x200, x = t/10, y on ax1 = 200 - v.
const GRID = { left: 0, top: 0, width: 400, height: 200 };
const projection: Projection = projectionOf({
  tToX: (t: number) => t / 10,
  xToT: (x: number) => x * 10,
  vToY: (v: number, axisId: string) => (axisId === 'ax1' ? 200 - v : NaN),
  yToV: (y: number, axisId: string) => (axisId === 'ax1' ? 200 - y : NaN),
  gridRect: GRID,
  axisIds: ['ax1'],
});

let latest: AppState;
let binding: ToolBinding<TraceState, TraceModel>;
let projectionStore = createProjectionStore(() => projection);

/** TraceApp's shape: a history-wrapped `update`, the `ui` record, a document undo key. */
function Harness({ initial }: { initial: AppState }) {
  const [state, setState] = useState(initial);
  const update = useCallback((fn: (s: TraceState) => TraceState, tag?: 'undo') => {
    const nowMs = Date.now();
    setState((s) => withAnnotationHistory(s, fn(s) as AppState, tag, nowMs));
  }, []);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const setAnnotationsHidden = useCallback((plotId: string, on: boolean) => {
    setHidden((prev) => {
      if (prev.has(plotId) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(plotId);
      else next.delete(plotId);
      return next;
    });
  }, []);
  const ui = useMemo<TraceUi>(
    () => ({ annotationsHidden: hidden, setAnnotationsHidden }),
    [hidden, setAnnotationsHidden]
  );
  const store = useMemo(() => createSelectionStore(), []);
  const def = useTraceDefinition({ state, model: MODEL, update, selection: store });
  useLayoutEffect(() => {
    latest = state;
    binding = def.binding;
  }, [state, def]);
  useLayoutEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isUndoKey(e, true)) return;
      e.preventDefault();
      update((s) => popAnnotationHistory(s as AppState, s.activePlotId), 'undo');
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [update]);
  const plot = state.plots.find((p) => p.id === state.activePlotId);
  return (
    <SelectionProvider store={store}>
      <Outline
        definition={def}
        state={state}
        model={MODEL}
        ui={ui}
        update={update}
        capabilities={{ elog: false }}
        catalog={[]}
      />
      <div style={{ position: 'relative' }}>
        <AnnotationLayer
          config={TRACE_LAYER}
          projectionStore={projectionStore}
          annotations={plot?.annotations ?? []}
          axes={(plot?.axes ?? []).filter((a) => a.visible)}
          theme={drawingThemeFor('dark')}
          annotationsHidden={plot ? hidden.has(plot.id) : false}
        />
      </div>
    </SelectionProvider>
  );
}

function mount(initial = opening()) {
  const utils = render(<Harness initial={initial} />);
  act(() => projectionStore.bump());
  return utils;
}

function section(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-section-id="${id}"]`);
  if (!el) throw new Error(`no section ${id}`);
  return el;
}

function rowEl(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
  if (!el) throw new Error(`no row ${id}`);
  return el;
}

function statusOf(el: HTMLElement): string {
  return el.querySelector('.wb-outline-row__status')?.getAttribute('aria-label') ?? '';
}

function overlayIds(): string[] {
  return [...document.querySelectorAll('[data-annotation-id]')].map(
    (el) => el.getAttribute('data-annotation-id') ?? ''
  );
}

function headerEye(): HTMLButtonElement {
  const el = section(DRAWINGS_SECTION_KIND).querySelector<HTMLButtonElement>(
    `[data-testid="${DRAWINGS_VISIBLE_FIELD_ID}"]`
  );
  if (!el) throw new Error('no header eye');
  return el;
}

function activeDrawings(): Annotation[] {
  return latest.plots.find((p) => p.id === latest.activePlotId)?.annotations ?? [];
}

beforeEach(() => {
  projectionStore = createProjectionStore(() => projection);
});

afterEach(() => {
  cleanup();
});

// ------------------------------------------------------------------ schema --

describe('Annotations section schema', () => {
  it('is a section kind of the Trace schema with a header eye and no other field', () => {
    const schema = TRACE_SCHEMA.sections[DRAWINGS_SECTION_KIND];
    expect(schema).toBeDefined();
    const fields = schema.tabs.flatMap((t) => t.fields);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ kind: 'toggle', row: 'eye', label: 'Visible' });
  });
});

// ----------------------------------------------------------------- outline --

describe('Layers › Annotations', () => {
  it('appends the section after the axes with objName rows, status ok', () => {
    mount();
    const vm = binding.outline(latest, MODEL);
    const last = vm.sections[vm.sections.length - 1];
    expect(vm.sections.map((s) => s.id)).toEqual(['ax1', 'ax2', DRAWINGS_SECTION_KIND]);
    expect(last).toMatchObject({
      kind: DRAWINGS_SECTION_KIND,
      title: 'Drawings',
      unit: 'drawing',
      count: 2,
    });
    expect(last.add).toBeUndefined();
    const axes = latest.plots[0].axes;
    expect(last.rows).toEqual([
      {
        id: 'd-h',
        kind: DRAWING_ITEM_KIND,
        label: objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, HLINE, axes),
        status: 'ok',
      },
      {
        id: 'd-v',
        kind: DRAWING_ITEM_KIND,
        label: objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, VLINE, axes),
        status: 'ok',
      },
    ]);
    // Rendered: under the Drawings heading (the only section of its group, so
    // no sub-heading and no unit tag), both rows, no add row, nothing of plot 2.
    const el = section(DRAWINGS_SECTION_KIND);
    expect(el.querySelector('.wb-group__heading')?.textContent).toBe('Drawings');
    expect(el.querySelector('.wb-outline-section__unit')).toBeNull();
    expect(rowEl('d-h').textContent).toContain(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, HLINE, axes)
    );
    expect(rowEl('d-v')).toBeTruthy();
    expect(within(el).queryByTestId(TESTIDS.outlineAddInput)).toBeNull();
    expect(document.querySelector('[data-row-id="other"]')).toBeNull();
  });

  it('lists no Annotations section for a plot without drawings', () => {
    mount(opening([]));
    expect(binding.outline(latest, MODEL).sections.map((s) => s.id)).toEqual(['ax1', 'ax2']);
    expect(document.querySelector(`[data-section-id="${DRAWINGS_SECTION_KIND}"]`)).toBeNull();
  });

  it('marks a value-bearing drawing on a hidden axis stale with "Axis hidden"', () => {
    mount(opening([HLINE, BOX_ON_HIDDEN, VLINE_ON_HIDDEN]));
    const rows = binding.outline(latest, MODEL).sections.at(-1)?.rows ?? [];
    const box = rows.find((r) => r.id === 'd-box');
    expect(box).toMatchObject({ status: 'stale', refusal: AXIS_HIDDEN_HINT });
    expect(rows.find((r) => r.id === 'd-h')?.status).toBe('ok');
    // A V-line has no value axis: hiding its carried axis leaves it shown.
    expect(rows.find((r) => r.id === 'd-v2')?.status).toBe('ok');
    expect(statusOf(rowEl('d-box'))).toBe(`Status: ${AXIS_HIDDEN_HINT}`);
    expect(rowEl('d-box').querySelector('.wb-outline-row__status--stale')).not.toBeNull();
  });
});

// -------------------------------------------------------------- header eye --

describe('Annotations header eye', () => {
  it('hides every drawing of the overlay without changing a Plot field, and shows them again', () => {
    mount();
    expect(overlayIds().sort()).toEqual(['d-h', 'd-v']);
    const before = latest.plots;
    expect(headerEye().getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(headerEye());
    expect(document.querySelectorAll('[data-annotation-id]')).toHaveLength(0);
    expect(latest.plots).toBe(before);
    expect(headerEye().getAttribute('aria-pressed')).toBe('false');
    // Rows stay listed while hidden.
    expect(rowEl('d-h')).toBeTruthy();

    fireEvent.click(headerEye());
    expect(overlayIds().sort()).toEqual(['d-h', 'd-v']);
    expect(latest.plots).toBe(before);
  });

  it('reads and writes the active plot only', () => {
    const calls: [string, boolean][] = [];
    const ui: TraceUi = {
      annotationsHidden: new Set(['p2']),
      setAnnotationsHidden: (id, on) => calls.push([id, on]),
    };
    const field = TRACE_SCHEMA.sections[DRAWINGS_SECTION_KIND].tabs[0].fields[0];
    if (field.kind !== 'toggle') throw new Error('not a toggle');
    const ctx = {
      state: opening(),
      model: MODEL,
      update: () => {},
      selection: null,
      target: { level: 'section', kind: DRAWINGS_SECTION_KIND, id: DRAWINGS_SECTION_KIND },
      capabilities: { elog: false },
      ui,
    } as unknown as Parameters<typeof field.get>[0];
    expect(field.get(ctx)).toBe(true);
    field.set(ctx, false);
    expect(calls).toEqual([['p1', true]]);
    expect(field.get({ ...ctx, ui: { ...ui, annotationsHidden: new Set(['p1']) } })).toBe(false);
    // A workbench mounted without Trace's ui shows the drawings and ignores the toggle.
    const bare = { ...ctx, ui: {} } as typeof ctx;
    expect(field.get(bare)).toBe(true);
    expect(() => field.set(bare, false)).not.toThrow();
  });
});

// ------------------------------------------------------------ trash + undo --

describe('Annotations row trash', () => {
  it('removes the drawing and keeps the others', () => {
    mount();
    fireEvent.click(rowEl('d-h').querySelector('[aria-label^="Remove "]') as HTMLElement);
    expect(activeDrawings().map((a) => a.id)).toEqual(['d-v']);
    expect(document.querySelector('[data-row-id="d-h"]')).toBeNull();
    expect(overlayIds()).toEqual(['d-v']);
    // The other plot's drawing is untouched.
    expect(latest.plots[1].annotations?.map((a) => a.id)).toEqual(['other']);
  });

  it('removing the last drawing deletes the plot key and the section', () => {
    mount(opening([HLINE]));
    fireEvent.click(rowEl('d-h').querySelector('[aria-label^="Remove "]') as HTMLElement);
    expect('annotations' in latest.plots[0]).toBe(false);
    expect(document.querySelector(`[data-section-id="${DRAWINGS_SECTION_KIND}"]`)).toBeNull();
  });

  it('removes only an id of the active plot as a drawing; a curve id still removes the curve', () => {
    mount();
    act(() => binding.ops.remove('other'));
    expect(latest.plots[1].annotations?.map((a) => a.id)).toEqual(['other']);
    act(() => binding.ops.remove('t1'));
    expect(latest.plots[0].traces).toEqual([]);
    expect(activeDrawings()).toHaveLength(2);
  });

  it('⌘Z with focus on an Annotations row restores the removed drawing', () => {
    mount();
    fireEvent.click(rowEl('d-h').querySelector('[aria-label^="Remove "]') as HTMLElement);
    expect(activeDrawings().map((a) => a.id)).toEqual(['d-v']);
    const row = rowEl('d-v');
    row.focus();
    fireEvent.keyDown(row, { key: 'z', metaKey: true });
    expect(activeDrawings()).toEqual([HLINE, VLINE]);
    expect(rowEl('d-h')).toBeTruthy();
    expect(overlayIds().sort()).toEqual(['d-h', 'd-v']);
  });
});

// -------------------------------------------------------------------- move --

describe('Annotations drop refusal', () => {
  it('refuses a drawing dropped on an axis section, and on Annotations itself', () => {
    mount();
    expect(binding.moveRefusal('d-h', 'ax1')).toBe(DRAWING_STAYS_REASON);
    expect(binding.moveRefusal('d-h', 'ax2')).toBe(DRAWING_STAYS_REASON);
    expect(traceMoveRefusal(latest, 'd-v', DRAWINGS_SECTION_KIND)).toBe(DRAWING_STAYS_REASON);
    const before = latest;
    act(() => binding.ops.move('d-h', 'ax2'));
    expect(latest).toBe(before);
  });

  it("refuses a curve dropped on Annotations with today's reason", () => {
    mount();
    expect(binding.moveRefusal('t1', DRAWINGS_SECTION_KIND)).toBe(UNKNOWN_AXIS_REASON);
    const before = latest;
    act(() => binding.ops.move('t1', DRAWINGS_SECTION_KIND));
    expect(latest).toBe(before);
    // A curve between axes of its plot still moves.
    expect(binding.moveRefusal('t1', 'ax2')).toBeNull();
  });
});
