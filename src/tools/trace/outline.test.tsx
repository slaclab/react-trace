// @vitest-environment jsdom
//
// Trace's binding half and ToolDefinition, rendered through the properties
// panel:
//
// - the Outline is the active plot's: sections = its Y-axes under
//   Signals (unit tag = the Unit override, else the EGU; muted when hidden),
//   rows = its curves; switching the active plot re-roots it and resets the
//   selection;
// - the plot-wide sections are Acquisition, Axes, Display, Statistics and the
//   chart source;
// - row status dots replace the struck header counts;
// - each axis section's add row adds a PV onto that axis through async
//   `ops.add`, then the unit lookup re-assigns it as today — the cases of
//   `LeftPanel.addTrace.test.tsx`, ported;
// - footer Add formula / Add axis;
// - `ops.move` within a plot only, sharing `moveRefusal` (no cross-plot drag).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { drawingThemeFor } from '../../annotationTheme';
import { newAxis, newFormula, newPlot, newTrace } from '../../embed/plotConfig';
import type { ArchiveSeriesResult } from '../../hooks/useArchiveSeries';
import type { FormulaSeriesResult } from '../../hooks/useFormulaSeries';
import type { LiveSeriesResult } from '../../hooks/useLiveSeries';
import { DEFAULT_PALETTE_ID, colorForIndex, getPalette } from '../../palettes';
import type { Axis, Plot, PVTrace } from '../../types';
import { PanelHarness } from '../../workbench/__fixtures__/PanelHarness';
import {
  SelectionProvider,
  createSelectionStore,
  type SelectionStore,
} from '../../workbench/selection';
import { TESTIDS } from '../../workbench/testids';
import type { OutlineViewModel, ToolBinding, ToolDefinition } from '../../workbench/types';
import type { TraceFragmentInput } from './codeFragments';
import {
  ADD_PV_PLACEHOLDER,
  CROSS_PLOT_REASON,
  NOT_ACTIVE_AXIS_REASON,
  UNKNOWN_AXIS_REASON,
  UNKNOWN_CURVE_REASON,
  curveRowStatus,
  traceMoveRefusal,
  type UnitLookup,
} from './outline';
import { DRAWING_ITEM_KIND, DRAWINGS_SECTION_KIND } from '../../annotations/host/workbench';
import { AXIS_SECTION_KIND } from './schema/axis';
import { GROUPS } from '../vocabulary';
import { PV_CURVE_ITEM_KIND } from './schema/curve';
import { FORMULA_CURVE_ITEM_KIND } from './schema/formula';
import {
  TRACE_SCHEMA,
  useTraceDefinition,
  type TraceModel,
  type TraceState,
  type TraceUi,
} from './tool';
import { WithCanopy } from '../../test/canopy';

const PALETTE = getPalette(DEFAULT_PALETTE_ID);

function axis(id: string, index: number, patch: Partial<Axis> = {}): Axis {
  return { ...newAxis(id, index), ...patch };
}

function curve(id: string, pv: string, axisId: string, patch: Partial<PVTrace> = {}): PVTrace {
  return {
    ...newTrace(id, pv, axisId, '#0f62fe', []),
    useLive: false,
    useArchive: false,
    ...patch,
  };
}

function plot(id: string, index: number, patch: Partial<Plot>): Plot {
  return { ...newPlot(id, index), ...patch };
}

/** Plot 1: two axes (the second with units), a PV curve and a formula; plot 2: one axis, one curve. */
function opening(): TraceState {
  return {
    activePlotId: 'p1',
    plots: [
      plot('p1', 0, {
        title: 'Beam',
        axes: [axis('ax1', 0, { name: 'Y' }), axis('ax2', 1, { name: 'Current', units: 'mA' })],
        traces: [
          curve('t1', 'TEST:DCCT', 'ax1', { displayName: 'Beam current' }),
          curve('t2', 'TEST:BPM01:X', 'ax2'),
          { ...newFormula('f1', 'ax1', '#ff0000'), displayName: 'Sum' },
        ],
      }),
      plot('p2', 1, {
        title: 'Vacuum',
        axes: [axis('bx1', 0, { name: 'Pressure' })],
        traces: [curve('u1', 'TEST:VAC:P1', 'bx1')],
      }),
    ],
  };
}

let liveResults = new Map<string, LiveSeriesResult>();
let archiveResults = new Map<string, ArchiveSeriesResult>();
let formulaResults = new Map<string, FormulaSeriesResult>();

function fragmentInput(p: Plot): TraceFragmentInput {
  return { plot: p, archiveResults, liveResults, formulaResults, theme: drawingThemeFor('light') };
}

/** Every plot shows its drawings. */
const UI: TraceUi = { annotationsHidden: new Set(), setAnnotationsHidden: () => {} };

const MODEL: TraceModel = {
  palette: PALETTE,
  fragmentInput,
  inspect: () => {},
  createFormula: () => {},
};

let latest: TraceState;
let setLatest: (fn: (s: TraceState) => TraceState) => void;
let definition: ToolDefinition<TraceState, TraceModel>;
let binding: ToolBinding<TraceState, TraceModel>;
let store: SelectionStore;
let lookupUnit: ReturnType<typeof vi.fn<UnitLookup>>;

function Harness({ initial }: { initial: TraceState }) {
  const [state, setState] = useState(initial);
  const def = useTraceDefinition({
    state,
    model: MODEL,
    update: setState,
    selection: store,
    search: SEARCH,
    lookupUnit,
  });
  useLayoutEffect(() => {
    latest = state;
    setLatest = setState;
    definition = def;
    binding = def.binding;
  }, [state, def]);
  return (
    <SelectionProvider store={store}>
      <PanelHarness
        definition={def}
        state={state}
        model={MODEL}
        ui={UI}
        update={setState}
        capabilities={{ elog: false }}
        catalog={[]}
      />
    </SelectionProvider>
  );
}

const SEARCH = vi.fn(async () => [] as string[]);

function mount(initial = opening()) {
  render(<Harness initial={initial} />, { wrapper: WithCanopy });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
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

function field(sectionId = 'ax1'): HTMLInputElement {
  return within(section(sectionId)).getByTestId(TESTIDS.outlineAddInput) as HTMLInputElement;
}

function plotOf(state: TraceState, id: string): Plot {
  const p = state.plots.find((x) => x.id === id);
  if (!p) throw new Error(`no plot ${id}`);
  return p;
}

function curvesNamed(state: TraceState, pv: string): PVTrace[] {
  return state.plots.flatMap((p) => p.traces.filter((t) => t.pvName === pv));
}

function outlineNow(): OutlineViewModel {
  return binding.outline(latest, MODEL);
}

beforeEach(() => {
  vi.useFakeTimers();
  store = createSelectionStore();
  liveResults = new Map();
  archiveResults = new Map();
  formulaResults = new Map();
  // By default the unit lookup never answers, as LeftPanel's stubbed fetch.
  lookupUnit = vi.fn<UnitLookup>(() => new Promise<string | undefined>(() => {}));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ schema --

describe('Trace definition', () => {
  it('names the plot, axis, annotations, curve, formula and drawing objects', () => {
    expect(Object.keys(TRACE_SCHEMA.sections)).toEqual([AXIS_SECTION_KIND, DRAWINGS_SECTION_KIND]);
    expect(Object.keys(TRACE_SCHEMA.items).sort()).toEqual(
      [FORMULA_CURVE_ITEM_KIND, PV_CURVE_ITEM_KIND, DRAWING_ITEM_KIND].sort()
    );
  });

  it('declares the plot-wide sections in order, each with a summary, and the chart source', () => {
    expect(TRACE_SCHEMA.tool.tabs.map((t) => [t.id, t.label])).toEqual([
      ['acquisition', 'Acquisition'],
      ['axes', 'Axes'],
      ['display', 'Display'],
      ['statistics', 'Statistics'],
      ['code', 'Chart source'],
    ]);
    for (const tab of TRACE_SCHEMA.tool.tabs.slice(0, 4))
      expect(tab.summary).toBeTypeOf('function');
  });

  it('groups the axes under Signals (fields in Axes) and the drawings under Drawings', () => {
    expect(TRACE_SCHEMA.sections[AXIS_SECTION_KIND].group).toBe(GROUPS.signals);
    expect(TRACE_SCHEMA.sections[AXIS_SECTION_KIND].placement).toBe('axes');
    expect(TRACE_SCHEMA.sections[DRAWINGS_SECTION_KIND].group).toBe(GROUPS.drawings);
  });

  it('gives cards Signal/Style(/Data) blocks and no object a Code tab', () => {
    const ids = (kind: string) => TRACE_SCHEMA.items[kind].tabs.map((t) => t.id);
    expect(ids(PV_CURVE_ITEM_KIND)).toEqual(['signal', 'style', 'data']);
    expect(ids(FORMULA_CURVE_ITEM_KIND)).toEqual(['signal', 'style']);
    for (const s of Object.values(TRACE_SCHEMA.sections)) {
      expect(s.tabs.map((t) => t.id)).not.toContain('code');
    }
  });

  it('renders the axes under one Signals heading and their fields in Axes', () => {
    mount();
    const signals = document.querySelector('.wb-group[data-group="signals"]');
    expect(signals?.querySelector('.wb-group__heading')?.textContent).toBe('Signals');
    expect(signals?.querySelector('[data-section-id="ax1"]')).not.toBeNull();
    expect(signals?.querySelector('[data-section-id="ax2"]')).not.toBeNull();
    const axes = document.querySelector('.wb-plot-section[data-section="axes"]')!;
    expect(
      [...axes.querySelectorAll<HTMLElement>('[data-axes-section]')].map(
        (b) => b.dataset.axesSection
      )
    ).toEqual(['ax1', 'ax2']);
  });

  it('keeps the binding across renders that change only state', () => {
    mount();
    const before = definition;
    act(() => setLatest((s) => ({ ...s, plots: [...s.plots] })));
    expect(definition).toBe(before);
  });
});

// ----------------------------------------------------------------- outline --

describe('Trace outline of the active plot', () => {
  it('roots at the active plot: axis sections with unit tag, curve rows', () => {
    mount();
    const vm = outlineNow();
    expect(vm.sections.map((s) => [s.id, s.kind, s.title, s.count])).toEqual([
      ['ax1', 'axis', 'Y', 2],
      ['ax2', 'axis', 'Current', 1],
    ]);
    expect(vm.sections[0].unit).toBeUndefined();
    expect(vm.sections[1].unit).toBe('mA');
    expect(vm.sections[0].capacity).toBeUndefined();
    expect(vm.sections[0].rows.map((r) => [r.id, r.kind, r.label])).toEqual([
      ['t1', PV_CURVE_ITEM_KIND, 'Beam current'],
      ['f1', FORMULA_CURVE_ITEM_KIND, 'Sum'],
    ]);
    expect(vm.sections[1].rows[0].label).toBe('TEST:BPM01:X');
    expect(vm.sections[0].add?.placeholder).toBe(ADD_PV_PLACEHOLDER);
    expect(vm.sections[0].add?.search).toBe(SEARCH);
    // Rendered: both axes of plot 1, nothing of plot 2.
    expect(section('ax1')).toBeTruthy();
    expect(section('ax2').querySelector('.wb-outline-section__unit')?.textContent).toBe('mA');
    expect(rowEl('t1')).toBeTruthy();
    expect(document.querySelector('[data-section-id="bx1"]')).toBeNull();
    expect(document.querySelector('[data-row-id="u1"]')).toBeNull();
  });

  it('tags an axis with its Unit override, else its stamped EGU', () => {
    const s = opening();
    const p1 = plotOf(s, 'p1');
    mount({
      ...s,
      plots: [
        {
          ...p1,
          axes: p1.axes.map((a) => (a.id === 'ax2' ? { ...a, unitLabel: 'milliamp' } : a)),
        },
        plotOf(s, 'p2'),
      ],
    });
    expect(outlineNow().sections[1].unit).toBe('milliamp');
    expect(section('ax2').querySelector('.wb-outline-section__unit')?.textContent).toBe('milliamp');
    act(() =>
      setLatest((st) => ({
        ...st,
        plots: st.plots.map((p) => ({
          ...p,
          axes: p.axes.map((a) => ({ ...a, unitLabel: undefined })),
        })),
      }))
    );
    expect(outlineNow().sections[1].unit).toBe('mA');
  });

  it('mutes a hidden axis section', () => {
    const s = opening();
    const p1 = plotOf(s, 'p1');
    mount({
      ...s,
      plots: [
        { ...p1, axes: p1.axes.map((a) => (a.id === 'ax2' ? { ...a, visible: false } : a)) },
        plotOf(s, 'p2'),
      ],
    });
    const vm = outlineNow();
    expect(vm.sections[0].muted).toBeUndefined();
    expect(vm.sections[1].muted).toBe(true);
  });

  it('re-roots when the active plot changes', () => {
    mount();
    act(() => setLatest((s) => ({ ...s, activePlotId: 'p2' })));
    const vm = outlineNow();
    expect(vm.sections.map((s) => s.id)).toEqual(['bx1']);
    expect(vm.sections[0].rows.map((r) => r.id)).toEqual(['u1']);
    expect(section('bx1')).toBeTruthy();
    expect(rowEl('u1')).toBeTruthy();
    expect(document.querySelector('[data-section-id="ax1"]')).toBeNull();
    expect(document.querySelector('[data-row-id="t1"]')).toBeNull();
  });

  it('resets the selection when the active plot changes, without a reveal', () => {
    mount();
    act(() => store.select({ level: 'item', kind: PV_CURVE_ITEM_KIND, id: 't1' }));
    const reveals = store.get().revealCount;
    // A state change that keeps the plot keeps the selection.
    act(() => setLatest((s) => ({ ...s, plots: [...s.plots] })));
    expect(store.get().selection?.id).toBe('t1');
    act(() => setLatest((s) => ({ ...s, activePlotId: 'p2' })));
    expect(store.get().selection).toBeNull();
    expect(store.get().origin).toBe('reset');
    expect(store.get().revealCount).toBe(reveals);
    // Selecting the axis of the new plot, then switching back, resets again.
    act(() => store.select({ level: 'section', kind: AXIS_SECTION_KIND, id: 'bx1' }));
    act(() => setLatest((s) => ({ ...s, activePlotId: 'p1' })));
    expect(store.get().selection).toBeNull();
  });

  it('returns the previous view-model while nothing shown changed (rate rule)', () => {
    mount();
    const a = outlineNow();
    const b = binding.outline({ ...latest, plots: latest.plots.map((p) => ({ ...p })) }, MODEL);
    expect(b).toBe(a);
    const c = binding.outline({ ...latest, activePlotId: 'p2' }, MODEL);
    expect(c).not.toBe(a);
  });

  it('shows an empty outline when there is no plot', () => {
    mount();
    expect(binding.outline({ plots: [], activePlotId: '' }, MODEL)).toEqual({ sections: [] });
  });
});

// ------------------------------------------------------------- row status --

describe('Trace row status dots', () => {
  const live = (patch: Partial<LiveSeriesResult>): LiveSeriesResult => ({
    status: 'connected',
    connected: true,
    severity: null,
    latest: null,
    error: null,
    points: [],
    breaks: [],
    ...patch,
  });
  const archive = (patch: Partial<ArchiveSeriesResult>): ArchiveSeriesResult => ({
    status: 'ready',
    mean: [],
    band: [],
    ...patch,
  });
  const pv = (patch: Partial<PVTrace> = {}) => curve('c', 'TEST:X', 'ax1', patch);

  it('a PV curve is the worst of its enabled sources', () => {
    const both = pv({ useLive: true, useArchive: true });
    expect(curveRowStatus(both, { live: live({}), archive: archive({}) })).toEqual({
      status: 'ok',
    });
    expect(
      curveRowStatus(both, { live: live({ status: 'connecting' }), archive: archive({}) })
    ).toEqual({ status: 'pending' });
    expect(
      curveRowStatus(both, { live: live({ connected: false }), archive: archive({}) })
    ).toEqual({ status: 'pending' });
    expect(
      curveRowStatus(both, { live: live({}), archive: archive({ status: 'loading' }) })
    ).toEqual({ status: 'pending' });
    expect(
      curveRowStatus(both, {
        live: live({}),
        archive: archive({ status: 'error', error: { code: 'TIMEOUT', detail: '' } }),
      })
    ).toEqual({ status: 'error', refusal: 'Archive: TIMEOUT' });
    // The archiver lacking the PV reads "Not archived", never its raw code.
    expect(
      curveRowStatus(both, {
        live: live({}),
        archive: archive({
          status: 'error',
          error: { code: 'pv_not_found_in_archiver', detail: '' },
        }),
      })
    ).toEqual({ status: 'error', refusal: 'Not archived' });
    expect(
      curveRowStatus(both, { live: live({ status: 'disconnected' }), archive: archive({}) })
    ).toEqual({ status: 'error', refusal: 'Live: Disconnected' });
    // A disabled source does not count, however it reads.
    expect(
      curveRowStatus(pv({ useLive: false, useArchive: true }), {
        live: live({ status: 'disconnected' }),
        archive: archive({}),
      })
    ).toEqual({ status: 'ok' });
    // No result yet for an enabled source: pending.
    expect(curveRowStatus(pv({ useLive: true }), {})).toEqual({ status: 'pending' });
  });

  it('a curve without a PV is pending; a formula follows its evaluation', () => {
    expect(curveRowStatus(pv({ pvName: '' }), {})).toEqual({ status: 'pending' });
    const f = newFormula('f', 'ax1', '#000');
    expect(curveRowStatus(f, {})).toEqual({ status: 'pending' });
    expect(curveRowStatus(f, { formula: { status: 'ready', points: [] } })).toEqual({
      status: 'ok',
    });
    expect(
      curveRowStatus(f, {
        formula: { status: 'error', points: [], error: { code: 'PARSE', detail: 'bad token' } },
      })
    ).toEqual({ status: 'error', refusal: 'Formula: bad token' });
  });

  it('renders the dots from the plot result maps, keyed by curve id', () => {
    const s = opening();
    const p1 = plotOf(s, 'p1');
    archiveResults.set('t1', archive({ status: 'error', error: { code: 'HTTP_500', detail: '' } }));
    archiveResults.set('t2', archive({}));
    formulaResults.set('f1', { status: 'ready', points: [] });
    mount({
      ...s,
      plots: [
        {
          ...p1,
          traces: p1.traces.map((t) =>
            t.kind === 'formula' ? t : { ...t, useArchive: true, useLive: false }
          ),
        },
        plotOf(s, 'p2'),
      ],
    });
    expect(statusOf(rowEl('t1'))).toBe('Status: Archive: HTTP_500');
    expect(statusOf(rowEl('t2'))).toBe('Status: ok');
    expect(statusOf(rowEl('f1'))).toBe('Status: ok');
  });
});

// --------------------------------------------- add (LeftPanel.addTrace port) --

describe('Trace add row (LeftPanel Add Trace, ported)', () => {
  it('has a PV field in every axis section; typing alone adds nothing', () => {
    mount();
    expect(field('ax1')).toBeTruthy();
    expect(field('ax2')).toBeTruthy();
    const before = latest;
    fireEvent.change(field('ax1'), { target: { value: 'TEST:BPM01:X' } });
    expect(latest).toBe(before);
    // Add formula stays a footer action beside the add rows.
    expect(screen.getByRole('button', { name: /add formula/i })).toBeTruthy();
  });

  it('creates the curve with the committed PV on that axis and empties the field', async () => {
    mount();
    fireEvent.change(field('ax1'), { target: { value: 'TEST:BPM02:Y' } });
    expect(curvesNamed(latest, 'TEST:BPM02:Y')).toEqual([]);
    fireEvent.keyDown(field('ax1'), { key: 'Enter' });
    await flush();
    const added = curvesNamed(latest, 'TEST:BPM02:Y');
    expect(added).toHaveLength(1);
    expect(added[0].axisId).toBe('ax1');
    expect(plotOf(latest, 'p1').traces.at(-1)?.id).toBe(added[0].id);
    expect(plotOf(latest, 'p2').traces.map((t) => t.id)).toEqual(['u1']);
    // Coloured by its position, its label following the PV.
    expect(added[0].color).toBe(colorForIndex(PALETTE, 3));
    expect(added[0].displayName).toBe('');
    expect(rowEl(added[0].id).textContent).toContain('TEST:BPM02:Y');
    expect(field('ax1').value).toBe('');
    // The unit lookup asked for the PV with the plot's archiver.
    expect(lookupUnit).toHaveBeenCalledWith('TEST:BPM02:Y', undefined, expect.any(AbortSignal));
  });

  it('adds onto the axis whose section took the PV', async () => {
    mount();
    fireEvent.change(field('ax2'), { target: { value: 'TEST:BPM03:X' } });
    fireEvent.keyDown(field('ax2'), { key: 'Enter' });
    await flush();
    expect(curvesNamed(latest, 'TEST:BPM03:X')[0]?.axisId).toBe('ax2');
  });

  it('adds nothing on Escape', async () => {
    mount();
    const before = latest;
    fireEvent.change(field('ax1'), { target: { value: 'TEST:' } });
    fireEvent.keyDown(field('ax1'), { key: 'Escape' });
    await flush();
    expect(latest).toBe(before);
  });

  it('left empty adds nothing; left with text it keeps the text, adds nothing, and Enter later adds', async () => {
    mount();
    const before = latest;
    fireEvent.focus(field('ax1'));
    fireEvent.blur(field('ax1'));
    await flush();
    expect(latest).toBe(before);
    fireEvent.change(field('ax1'), { target: { value: 'TEST:X' } });
    fireEvent.blur(field('ax1'));
    await flush();
    expect(field('ax1').value).toBe('TEST:X');
    expect(latest).toBe(before);
    fireEvent.focus(field('ax1'));
    fireEvent.change(field('ax1'), { target: { value: 'TEST:XY' } });
    fireEvent.keyDown(field('ax1'), { key: 'Enter' });
    await flush();
    expect(curvesNamed(latest, 'TEST:XY')[0]?.axisId).toBe('ax1');
    expect(curvesNamed(latest, 'TEST:X')).toEqual([]);
  });

  it('Add formula adds at once onto the first axis and selects it', () => {
    mount();
    const count = plotOf(latest, 'p1').traces.length;
    fireEvent.click(screen.getByRole('button', { name: /add formula/i }));
    const traces = plotOf(latest, 'p1').traces;
    expect(traces).toHaveLength(count + 1);
    const added = traces.at(-1)!;
    expect(added.kind).toBe('formula');
    expect(added.axisId).toBe('ax1');
    expect(store.get().selection).toEqual({
      level: 'item',
      kind: FORMULA_CURVE_ITEM_KIND,
      id: added.id,
    });
    expect(field('ax1').value).toBe('');
  });

  it('refuses an axis that is not on the active plot; ignores a blank PV', async () => {
    mount();
    const before = latest;
    await expect(binding.ops.add('bx1', 'TEST:Z')).resolves.toEqual({
      message: NOT_ACTIVE_AXIS_REASON,
    });
    await expect(binding.ops.add('ax1', '   ')).resolves.toBeUndefined();
    await flush();
    expect(latest).toBe(before);
  });
});

// ------------------------------------------------------- unit re-assignment --

describe('Trace add: unit re-assignment as today', () => {
  async function addOn(axisId: string, pv: string) {
    await act(async () => {
      await binding.ops.add(axisId, pv);
    });
    await flush();
    return curvesNamed(latest, pv)[0];
  }

  it('moves the new curve onto the axis of its unit', async () => {
    lookupUnit = vi.fn<UnitLookup>(async () => 'mA');
    mount();
    const added = await addOn('ax1', 'TEST:DCCT2');
    expect(added.axisId).toBe('ax2');
    expect(plotOf(latest, 'p1').axes).toHaveLength(2);
  });

  it('creates an axis named for an unknown unit', async () => {
    lookupUnit = vi.fn<UnitLookup>(async () => 'Torr');
    mount();
    const added = await addOn('ax1', 'TEST:VAC:P2');
    const axes = plotOf(latest, 'p1').axes;
    expect(axes).toHaveLength(3);
    expect(axes[2]).toMatchObject({ name: 'Torr', units: 'Torr' });
    expect(added.axisId).toBe(axes[2].id);
  });

  it('leaves the curve where it was added without a unit or on a lookup failure', async () => {
    lookupUnit = vi.fn<UnitLookup>(async () => undefined);
    mount();
    expect((await addOn('ax1', 'TEST:A')).axisId).toBe('ax1');
    lookupUnit.mockImplementation(async () => {
      throw new Error('404');
    });
    expect((await addOn('ax1', 'TEST:B')).axisId).toBe('ax1');
  });

  it('a move made while the lookup runs wins', async () => {
    let answer!: (unit: string) => void;
    lookupUnit = vi.fn<UnitLookup>(
      () => new Promise<string | undefined>((resolve) => (answer = resolve))
    );
    mount();
    await act(async () => {
      await binding.ops.add('ax2', 'TEST:C');
    });
    const id = curvesNamed(latest, 'TEST:C')[0].id;
    act(() => binding.ops.move(id, 'ax1'));
    expect(curvesNamed(latest, 'TEST:C')[0].axisId).toBe('ax1');
    await act(async () => answer('Torr'));
    await flush();
    expect(curvesNamed(latest, 'TEST:C')[0].axisId).toBe('ax1');
    expect(plotOf(latest, 'p1').axes).toHaveLength(2);
  });

  it('removing the curve aborts its lookup', async () => {
    let signal!: AbortSignal;
    lookupUnit = vi.fn<UnitLookup>((_pv, _archiver, s) => {
      signal = s;
      return new Promise<string | undefined>(() => {});
    });
    mount();
    await act(async () => {
      await binding.ops.add('ax1', 'TEST:D');
    });
    const id = curvesNamed(latest, 'TEST:D')[0].id;
    act(() => binding.ops.remove(id));
    expect(signal.aborted).toBe(true);
    expect(curvesNamed(latest, 'TEST:D')).toEqual([]);
  });
});

// ------------------------------------------------------------ move / remove --

describe('Trace move between axes of one plot', () => {
  it('moveRefusal: same plot allowed; another plot or unknown ids refused', () => {
    const s = opening();
    expect(traceMoveRefusal(s, 't1', 'ax2')).toBeNull();
    expect(traceMoveRefusal(s, 't1', 'bx1')).toBe(CROSS_PLOT_REASON);
    expect(traceMoveRefusal(s, 'nope', 'ax2')).toBe(UNKNOWN_CURVE_REASON);
    expect(traceMoveRefusal(s, 't1', 'nope')).toBe(UNKNOWN_AXIS_REASON);
    mount();
    expect(binding.moveRefusal('t1', 'bx1')).toBe(CROSS_PLOT_REASON);
    expect(binding.moveRefusal('f1', 'ax2')).toBeNull();
  });

  it('ops.move retargets within the plot and never across plots', () => {
    mount();
    act(() => binding.ops.move('t1', 'ax2'));
    expect(plotOf(latest, 'p1').traces.find((t) => t.id === 't1')?.axisId).toBe('ax2');
    expect(within(section('ax2')).getAllByText('Beam current')).toBeTruthy();
    const before = latest;
    act(() => binding.ops.move('t1', 'bx1'));
    act(() => binding.ops.move('t1', 'ax2'));
    expect(latest).toBe(before);
  });

  it('agrees with the Y-axis field options: only the holding plot axes', () => {
    mount();
    act(() => store.select({ level: 'item', kind: PV_CURVE_ITEM_KIND, id: 't1' }));
    const select = document.querySelector<HTMLSelectElement>('#y-axis');
    expect(select).not.toBeNull();
    const values = Array.from(select!.options).map((o) => o.value);
    expect(values).toEqual(['ax1', 'ax2']);
    for (const v of values) expect(binding.moveRefusal('t1', v)).toBeNull();
  });

  it('ops.remove drops the curve from its plot', () => {
    mount();
    act(() => binding.ops.remove('t2'));
    expect(plotOf(latest, 'p1').traces.map((t) => t.id)).toEqual(['t1', 'f1']);
    expect(document.querySelector('[data-row-id="t2"]')).toBeNull();
  });
});

// ------------------------------------------------------------------ footer --

describe('Trace footer', () => {
  it('offers Add formula and Add axis, both enabled', () => {
    mount();
    expect(binding.footer?.map((a) => [a.label, a.disabled ?? false])).toEqual([
      ['Add formula', false],
      ['Add axis', false],
    ]);
  });

  it('Add axis appends an axis to the active plot and selects it', () => {
    mount();
    act(() => setLatest((s) => ({ ...s, activePlotId: 'p2' })));
    fireEvent.click(screen.getByRole('button', { name: /add axis/i }));
    const axes = plotOf(latest, 'p2').axes;
    expect(axes).toHaveLength(2);
    expect(axes[1].orientation).toBe('right');
    expect(plotOf(latest, 'p1').axes).toHaveLength(2);
    expect(store.get().selection).toEqual({
      level: 'section',
      kind: AXIS_SECTION_KIND,
      id: axes[1].id,
    });
    expect(section(axes[1].id)).toBeTruthy();
  });
});

// ------------------------------------------------------- section expansion --

describe('Trace axis sections start expanded', () => {
  const toggle = (id: string) =>
    section(id).querySelector<HTMLButtonElement>('.wb-outline-section__toggle')!;

  it('shows axes created after mount expanded, with their rows and add row', async () => {
    lookupUnit = vi.fn<UnitLookup>(async () => 'Torr');
    mount();
    // The axis made for a PV's units now holds the new curve.
    await act(async () => {
      await binding.ops.add('ax1', 'TEST:VAC:P2');
    });
    await flush();
    const unitAxis = plotOf(latest, 'p1').axes[2];
    const added = curvesNamed(latest, 'TEST:VAC:P2')[0];
    expect(added.axisId).toBe(unitAxis.id);
    expect(toggle(unitAxis.id).getAttribute('aria-expanded')).toBe('true');
    expect(rowEl(added.id)).toBeTruthy();
    expect(field(unitAxis.id)).toBeTruthy();

    // Add axis, and a plot that arrives with its default axis.
    fireEvent.click(screen.getByRole('button', { name: /add axis/i }));
    const footerAxis = plotOf(latest, 'p1').axes[3];
    expect(toggle(footerAxis.id).getAttribute('aria-expanded')).toBe('true');
    act(() =>
      setLatest((s) => ({
        ...s,
        activePlotId: 'p3',
        plots: [...s.plots, plot('p3', 2, { axes: [axis('cx1', 0), axis('cx2', 1)], traces: [] })],
      }))
    );
    expect(toggle('cx1').getAttribute('aria-expanded')).toBe('true');
    expect(field('cx1')).toBeTruthy();
    expect(field('cx2')).toBeTruthy();
  });

  it('still collapses and re-expands one axis at a time', () => {
    mount();
    fireEvent.click(toggle('ax1'));
    expect(toggle('ax1').getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-row-id="t1"]')).toBeNull();
    expect(rowEl('t2')).toBeTruthy();
    fireEvent.click(toggle('ax1'));
    expect(rowEl('t1')).toBeTruthy();
  });
});
