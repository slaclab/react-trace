// @vitest-environment jsdom
//
// Waveform's field schemas, rendered through the properties panel: the plot-wide
// Acquisition (Persistence 1–16 with the bars help, Average 1–64, More:
// Element range / Decimation / Update-rate cap), Axes (Y axis: Unit,
// Auto-scale, Min, Max, Log scale; X axis: Plot against, Auto-scale, Min,
// Max), Display, Statistics and the chart source, each with its summary; the
// Reference settings under its card (Source, Subtract reference only with a
// reference or Δ on, Rolling mean, Window, Spread band, Draw as); the cards
// (Live: Signal {Label · Plot on · Visible}, Style {Colour · Line · Width ·
// Dash}; Reference: Signal {Label · Visible}, Style {Colour · Width}; X:
// Signal {Label · Plot on}), with record-key dots and the Plot on select's
// disabled option from the shared move rule.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { drawingThemeFor } from '../../annotationTheme';
import { liveFullMessage } from './edit';
import { clockTime, deriveWaveformModel, type WaveformRingSummary } from './model';
import { toolCodeFragment, type WaveformPlotInput } from './plotOption';
import {
  defaultWaveformState,
  MAX_LIVE,
  normalizeWaveformState,
  type WaveformState,
} from './query';
import { PanelHarness } from '../../workbench/__fixtures__/PanelHarness';
import { SelectionProvider, createSelectionStore } from '../../workbench/selection';
import type { FieldDef, Selection, Target, ToolDefinition } from '../../workbench/types';
import { AXES, CARD_BLOCKS, DASH_LABELS, GROUPS, PLOT_SECTIONS } from '../vocabulary';
import { commitElementRange, ELEMENT_RANGE_ERROR } from './fields/elementRangeText';
import { waveformOutline } from './outline';
import {
  axesSummary,
  commitDecimation,
  DEFAULT_LINE_WIDTH,
  parseWaveformItemId,
  referenceSourceText,
  SNAPSHOT_ITEM_ID,
  statisticsSummary,
  waveformItemId,
  waveformMoveRefusal,
  waveformSchema,
  type WaveformSchemaModel,
  type WaveformUi,
} from './schema';
import { autoYColor } from '../shared/colors';

type State = WaveformState;
type Model = WaveformSchemaModel;

const A = 'WF:A';
const B = 'WF:B';
const R = 'WF:REF';
const XS = 'WF:S';

const ring = (length: number): WaveformRingSummary => ({
  connected: true,
  length,
  resetEpoch: 0,
  arrival: 1,
});

function frameOf(n: number, offset = 0): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = offset + i;
  return out;
}

function modelOf(state: State): Model {
  const waveform = deriveWaveformModel({
    state,
    rings: { [A]: ring(4), [B]: ring(4), [R]: ring(4), [XS]: ring(4) },
    meta: { [A]: { egu: 'mm' }, [B]: { egu: 'mm' }, [R]: { egu: 'mm' }, [XS]: { egu: 'm' } },
    metaTimedOut: true,
  });
  const fragmentInput = (s: State): WaveformPlotInput => ({
    state: s,
    model: waveform,
    frames: {
      live: { [A]: { frame: frameOf(4) }, [B]: { frame: frameOf(4, 1) } },
      reference: s.reference?.kind === 'pv' ? frameOf(4, 2) : null,
      x: s.xs !== '' ? frameOf(4, 10) : null,
    },
    widthPx: 600,
    theme: drawingThemeFor('light'),
  });
  return { waveform, fragmentInput };
}

const schema = waveformSchema<Model, WaveformUi>();

const definition: ToolDefinition<State, Model, WaveformUi> = {
  schema,
  binding: {
    // The real view-model; the structural ops are not under test here.
    outline: (state, model) => waveformOutline(state, model.waveform),
    ops: { add: async () => undefined, remove: () => {}, move: () => {} },
    moveRefusal: () => null,
  },
};

function makeState(overrides: Partial<State> = {}): State {
  return normalizeWaveformState({ ...defaultWaveformState(), pvs: [A, B], ...overrides });
}

function createStore(initial: State) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(fn: (s: State) => State) {
      state = fn(state);
      listeners.forEach((l) => l());
    },
  };
}

type Store = ReturnType<typeof createStore>;

function Harness({ store }: { store: Store }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return (
    <PanelHarness
      definition={definition}
      state={state}
      model={modelOf(state)}
      ui={{}}
      update={store.update}
      capabilities={{ elog: true }}
      toolId="waveform"
    />
  );
}

function mount(state: State, selection: Selection = null): Store {
  const store = createStore(state);
  render(
    <SelectionProvider store={createSelectionStore({ initial: selection })}>
      <Harness store={store} />
    </SelectionProvider>
  );
  return store;
}

const item = (group: 'live' | 'reference' | 'xsource', pv: string): Selection => ({
  level: 'item',
  kind: group,
  id: waveformItemId(group, pv),
});
const snapshotItem: Selection = { level: 'item', kind: 'reference', id: SNAPSHOT_ITEM_ID };

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function dot(label: string): HTMLElement | null {
  return screen.queryByRole('img', { name: `${label} modified` });
}

function reset(label: string) {
  fireEvent.click(screen.getByRole('button', { name: `Reset ${label}` }));
}

/** The plot-wide sections in panel order. */
function plotSections(): (string | null)[] {
  return Array.from(document.querySelectorAll('.wb-plot-section')).map((s) =>
    s.getAttribute('data-section')
  );
}

/** A plot-wide section's closed-state summary. */
function summaryOf(id: string): string | null | undefined {
  return document.querySelector(`.wb-plot-section[data-section="${id}"] .wb-plot-section__summary`)
    ?.textContent;
}

/** The open card's block ids, in order. */
function cardBlocks(): (string | null)[] {
  return Array.from(document.querySelectorAll('.wb-card__body .wb-block')).map((b) =>
    b.getAttribute('data-block')
  );
}

/** The field ids of a block of the open card (`#id`s in render order). */
function blockFieldIds(block: string): string[] {
  const el = document.querySelector(`.wb-card__body .wb-block[data-block="${block}"]`);
  return Array.from(el?.querySelectorAll('[id]') ?? [])
    .map((e) => e.id)
    .filter((id) => schemaIds.has(id));
}

const schemaIds = new Set(
  Object.values(schema.items)
    .flatMap((o) => o.tabs)
    .flatMap((t) => t.fields)
    .map((f) => f.id)
);

function openMore() {
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
}

function radio(name: string): HTMLElement {
  return screen.getByRole('radio', { name });
}

function snapshot(time: number, pvs: string[]) {
  return {
    kind: 'snapshot' as const,
    frames: Object.fromEntries(pvs.map((pv) => [pv, frameOf(4)])),
    time,
  };
}

function ctxOf(state: State, target: Target, update: Store['update'] = () => {}) {
  return {
    state,
    model: modelOf(state),
    update,
    selection: null,
    target,
    capabilities: { elog: true },
    ui: {},
  };
}

function fieldOf(kind: string, id: string): FieldDef<State, Model, WaveformUi> {
  const field = schema.items[kind].tabs.flatMap((t) => t.fields).find((f) => f.id === id);
  if (field === undefined) throw new Error(`no ${kind} field ${id}`);
  return field;
}

afterEach(cleanup);

// ---------------------------------------------------------------- targets --

describe('Waveform schema — targets and the move rule', () => {
  it('round-trips item ids; the snapshot is the reference item with no PV', () => {
    expect(parseWaveformItemId(waveformItemId('live', 'A:B:C'))).toEqual({
      group: 'live',
      pv: 'A:B:C',
    });
    expect(parseWaveformItemId(SNAPSHOT_ITEM_ID)).toEqual({ group: 'reference', pv: null });
    expect(parseWaveformItemId('nope')).toBeNull();
    expect(parseWaveformItemId('trig:X')).toBeNull();
    expect(parseWaveformItemId('live:')).toBeNull();
  });

  it('refuses a move into a full Live only, with the full-Live text', () => {
    const pvs = Array.from({ length: MAX_LIVE }, (_, i) => `WF:${i}`);
    const full = makeState({ pvs, reference: { kind: 'pv', pv: R }, xs: XS });
    expect(waveformMoveRefusal(full, waveformItemId('reference', R), 'live')).toBe(
      liveFullMessage()
    );
    expect(waveformMoveRefusal(full, waveformItemId('xsource', XS), 'live')).toBe(
      'Live is full (8/8)'
    );
    // An occupied Reference or X axis PV swaps rather than refusing.
    expect(waveformMoveRefusal(full, waveformItemId('live', 'WF:0'), 'reference')).toBeNull();
    expect(waveformMoveRefusal(full, waveformItemId('live', 'WF:0'), 'xsource')).toBeNull();
    expect(waveformMoveRefusal(full, SNAPSHOT_ITEM_ID, 'live')).toBeNull();
  });

  it('caps the sections and puts each under its group heading', () => {
    expect(schema.sections.live.capacity).toBe(8);
    expect(schema.sections.reference.capacity).toBe(1);
    expect(schema.sections.xsource.capacity).toBe(1);
    expect(schema.sections.live.group).toBe(GROUPS.signals);
    expect(schema.sections.reference.group).toBe(GROUPS.reference);
    expect(schema.sections.xsource.group).toBe(GROUPS.xPv);
    // The Live and X axes are the Axes section's; those sections hold no fields.
    expect(schema.sections.live.tabs).toEqual([]);
    expect(schema.sections.xsource.tabs).toEqual([]);
  });

  it('has no Code block on any section or item', () => {
    const tabs = [...Object.values(schema.sections), ...Object.values(schema.items)].flatMap(
      (o) => o.tabs
    );
    expect(tabs.map((t) => t.id)).not.toContain('code');
  });
});

// ------------------------------------------------------------------- tool --

describe('Waveform schema — plot-wide sections', () => {
  it('has Acquisition, Axes, Display and Statistics, then the chart source', () => {
    expect(schema.tool.tabs.map((t) => t.id)).toEqual([
      'acquisition',
      'axes',
      'display',
      'statistics',
      'code',
    ]);
    expect(schema.tool.tabs.map((t) => t.label)).toEqual(
      Object.values(PLOT_SECTIONS).map((s) => s.label)
    );
    mount(makeState());
    expect(plotSections()).toEqual(['acquisition', 'axes', 'display', 'statistics']);
  });

  it('summarises each section in one short line', () => {
    mount(makeState({ persist: 4, avg: 2, crosshair: true }));
    expect(summaryOf('acquisition')).toBe('persistence 4 · average 2');
    expect(summaryOf('axes')).toBe('Y auto · X index');
    expect(summaryOf('display')).toBe('legend · grid · crosshair · tooltip');
    expect(summaryOf('statistics')).toBe('off');
  });

  it('summarises the axes: a fixed range, log, the X axis PV', () => {
    expect(axesSummary(makeState({ yScale: { auto: false, min: 0, max: 10 } }))).toBe(
      'Y 0–10 · X index'
    );
    expect(axesSummary(makeState({ yScale: { log: true }, xs: XS }))).toBe('Y auto log · X pv');
    expect(
      axesSummary(makeState({ xs: XS, xAxis: 'index', xScale: { auto: false, max: 40 } }))
    ).toBe('Y auto · X index auto–40');
    const on = makeState({ stats: true });
    expect(statisticsSummary(on)).toBe(`on · ${on.metrics.length} metrics`);
  });

  it('writes Persistence within 1–16 and says bars show only the latest frame', () => {
    const store = mount(makeState());
    const input = byId('persistence')!;
    fireEvent.change(input, { target: { value: '8' } });
    expect(store.getState().persist).toBe(8);
    fireEvent.change(input, { target: { value: '17' } });
    expect(store.getState().persist).toBe(8);
    fireEvent.change(input, { target: { value: '0' } });
    expect(store.getState().persist).toBe(8);
    expect(screen.getByText(/Bars curves show only the latest frame/)).toBeTruthy();
    expect(dot('Persistence')).toBeNull();
  });

  it('writes Average within 1–64', () => {
    const store = mount(makeState());
    fireEvent.change(byId('average')!, { target: { value: '64' } });
    expect(store.getState().avg).toBe(64);
    fireEvent.change(byId('average')!, { target: { value: '65' } });
    expect(store.getState().avg).toBe(64);
  });

  it('keeps Element range, Decimation and Update-rate cap in Acquisition’s closed More', () => {
    mount(makeState());
    expect(byId('element-range')).toBeNull();
    expect(byId('decimation')).toBeNull();
    expect(byId('update-rate')).toBeNull();
    openMore();
    const acquisition = document.querySelector('.wb-plot-section[data-section="acquisition"]')!;
    for (const id of ['element-range', 'decimation', 'update-rate']) {
      expect(acquisition.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it('commits an Element range on blur; an invalid one shows the reason; reset clears it', () => {
    const store = mount(makeState());
    openMore();
    const first = byId('element-range') as HTMLInputElement;
    const last = byId('element-range-last') as HTMLInputElement;
    expect(first.value).toBe('');
    expect(dot('Element range')).toBeNull();

    fireEvent.change(first, { target: { value: '10' } });
    fireEvent.change(last, { target: { value: '20' } });
    expect(store.getState().elems).toBeNull();
    fireEvent.blur(last);
    expect(store.getState().elems).toEqual({ first: 10, last: 20 });
    expect(dot('Element range')).not.toBeNull();

    fireEvent.change(first, { target: { value: '30' } });
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(store.getState().elems).toEqual({ first: 10, last: 20 });
    expect(screen.getByText(ELEMENT_RANGE_ERROR)).toBeTruthy();

    reset('Element range');
    expect(store.getState().elems).toBeNull();
    expect(dot('Element range')).toBeNull();
    expect((byId('element-range') as HTMLInputElement).value).toBe('');
  });

  it('parses Element range text: open sides, whole indices from 0, First ≤ Last', () => {
    expect(commitElementRange('', '')).toBeNull();
    expect(commitElementRange(' 5 ', '')).toEqual({ first: 5 });
    expect(commitElementRange('', '9')).toEqual({ last: 9 });
    expect(commitElementRange('3', '3')).toEqual({ first: 3, last: 3 });
    expect(commitElementRange('4', '3')).toBe('invalid');
    expect(commitElementRange('-1', '')).toBe('invalid');
    expect(commitElementRange('1.5', '')).toBe('invalid');
    expect(commitElementRange('a', '')).toBe('invalid');
  });

  it('writes Decimation as 0 (off) or 256–100000 and Update-rate cap as 1–10 Hz', () => {
    expect(commitDecimation(0)).toBe(0);
    expect(commitDecimation(-5)).toBe(0);
    expect(commitDecimation(100)).toBeNull();
    expect(commitDecimation(256)).toBe(256);
    expect(commitDecimation(100_001)).toBeNull();
    expect(commitDecimation(null)).toBeNull();

    const store = mount(makeState());
    openMore();
    fireEvent.change(byId('decimation')!, { target: { value: '1000' } });
    expect(store.getState().dec).toBe(1000);
    fireEvent.change(byId('decimation')!, { target: { value: '0' } });
    expect(store.getState().dec).toBe(0);
    fireEvent.change(byId('update-rate')!, { target: { value: '2' } });
    expect(store.getState().hz).toBe(2);
    fireEvent.change(byId('update-rate')!, { target: { value: '11' } });
    expect(store.getState().hz).toBe(2);
  });

  it('Axes › Y axis: the automatic Unit; Min/Max only while Auto-scale is off', () => {
    const store = mount(makeState());
    const axes = document.querySelector('.wb-plot-section[data-section="axes"]')!;
    expect(
      Array.from(axes.querySelectorAll('.wb-block__subheading')).map((h) => h.textContent)
    ).toEqual([AXES.y, AXES.x]);
    expect(byId('axis-unit')?.textContent).toBe('mm');
    expect(byId('axis-min')).toBeNull();

    fireEvent.click(byId('axis-autoscale')!);
    expect(store.getState().yScale).toEqual({ auto: false });
    fireEvent.change(byId('axis-min')!, { target: { value: '-2' } });
    expect(store.getState().yScale?.min).toBe(-2);
    expect(dot('Min')).not.toBeNull();
    reset('Min');
    expect(store.getState().yScale?.min).toBeUndefined();

    fireEvent.change(byId('axis-max')!, { target: { value: '7' } });
    fireEvent.click(byId('axis-autoscale')!);
    expect(store.getState().yScale).toEqual({ max: 7 });
    expect(byId('axis-max')).toBeNull();

    fireEvent.click(byId('axis-logscale')!);
    expect(store.getState().yScale).toEqual({ max: 7, log: true });
  });

  it('Axes › X axis: Plot against; X axis PV is disabled with its reason until there is one', () => {
    mount(makeState());
    expect(byId('x-axis')?.getAttribute('aria-label')).toBe('Plot against');
    expect(radio('Element #').getAttribute('aria-checked')).toBe('true');
    expect((radio(GROUPS.xPv) as HTMLButtonElement).disabled).toBe(true);
    expect(radio(GROUPS.xPv).getAttribute('title')).toBe('Add an X axis PV first.');
    cleanup();

    const store = mount(makeState({ xs: XS }));
    expect(radio(GROUPS.xPv).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(radio('Element #'));
    expect(store.getState().xAxis).toBe('index');
  });

  it('Axes › X axis: the scale, Min/Max only while Auto-scale is off', () => {
    const store = mount(makeState({ xs: XS }));
    expect(byId('x-axis-min')).toBeNull();
    fireEvent.click(byId('x-axis-autoscale')!);
    expect(store.getState().xScale).toEqual({ auto: false });
    fireEvent.change(byId('x-axis-max')!, { target: { value: '40' } });
    expect(store.getState().xScale).toEqual({ auto: false, max: 40 });
    expect(dot('Max')).not.toBeNull();
  });

  it('Display: Legend, Grid, Crosshair, Data tooltip, Mouse drag — written without a dot', () => {
    const store = mount(makeState());
    const display = document.querySelector('.wb-plot-section[data-section="display"]')!;
    expect(Array.from(display.querySelectorAll('[id]')).map((e) => e.id)).toEqual(
      expect.arrayContaining(['legend', 'grid', 'crosshair', 'tooltip', 'drag'])
    );
    expect(byId('drag')?.getAttribute('aria-label')).toBe('Mouse drag');
    for (const id of ['legend', 'grid', 'crosshair', 'tooltip']) fireEvent.click(byId(id)!);
    const s = store.getState();
    expect([s.legend, s.grid, s.crosshair, s.tooltip]).toEqual([false, false, true, false]);
    for (const label of ['Legend', 'Grid', 'Crosshair', 'Data tooltip']) {
      expect(dot(label)).toBeNull();
    }
    fireEvent.click(radio('Pan'));
    expect(store.getState().drag).toBe('pan');
    expect(summaryOf('display')).toBe('crosshair · pan');
  });

  it('holds the shared Statistics fields: Show statistics, Metrics and Reset metrics', () => {
    const store = mount(makeState({ pvs: ['WF:A'] }));
    expect(byId('metrics')?.tagName).toBe('UL');
    const reset = byId('metrics-reset') as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    expect(byId('stats-dist')).toBeNull();
    fireEvent.click(byId('stats-show')!);
    expect(store.getState().stats).toBe(true);
    fireEvent.click(byId('stats-dist')!);
    expect(store.getState().dist).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Strip chart for mean' }));
    expect(store.getState().metrics.find((m) => m.id === 'mean')?.strip).toBe(true);
    expect((byId('metrics-reset') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(byId('metrics-reset')!);
    expect(store.getState().metrics.some((m) => m.strip)).toBe(false);
    expect(summaryOf('statistics')).toBe(`on · ${store.getState().metrics.length} metrics`);
  });

  it('shows the chart option without series as the chart source', () => {
    const state = makeState({ crosshair: true });
    mount(state);
    expect(byId('waveform-code')?.textContent).toBe(
      toolCodeFragment(modelOf(state).fragmentInput(state))
    );
  });
});

// ------------------------------------------------------------- reference --

describe('Waveform schema — Reference settings', () => {
  it('shows Subtract reference only while a reference exists or Δ is on', () => {
    mount(makeState());
    expect(byId('subtract-reference')).toBeNull();
    cleanup();

    const store = mount(makeState({ reference: { kind: 'pv', pv: R } }));
    const toggle = byId('subtract-reference')!;
    expect(toggle.closest('.wb-outline-section__settings')).not.toBeNull();
    fireEvent.click(toggle);
    expect(store.getState().delta).toBe(true);
    expect(dot('Subtract reference')).toBeNull();
    cleanup();

    mount(makeState({ reference: snapshot(0, [A]), delta: true }));
    expect(byId('subtract-reference')).not.toBeNull();
  });

  it('lists Source first, then Subtract reference, Rolling mean and Draw as', () => {
    mount(makeState({ reference: { kind: 'pv', pv: R } }));
    const settings = byId('reference-source')!.closest('.wb-outline-section__settings')!;
    const ids = Array.from(settings.querySelectorAll('[id]'))
      .map((e) => e.id)
      .filter((id) =>
        ['reference-source', 'subtract-reference', 'rolling', 'draw-as'].includes(id)
      );
    expect(ids).toEqual(['reference-source', 'subtract-reference', 'rolling', 'draw-as']);
  });

  it('Source is read-only "PV <name>"; Draw as writes dashed or band', () => {
    const store = mount(makeState({ reference: { kind: 'pv', pv: R } }));
    expect(byId('reference-source')?.textContent).toBe(`PV ${R}`);
    const draw = byId('draw-as') as HTMLSelectElement;
    expect(draw.value).toBe('dashed');
    fireEvent.change(draw, { target: { value: 'band' } });
    expect(store.getState().drawAs).toBe('band');
    expect(dot('Draw as')).toBeNull();
  });

  it('Rolling mean replaces the reference, Window and Spread band follow it', () => {
    const store = mount(makeState({ pvs: [A], reference: { kind: 'pv', pv: R } }));
    expect(byId('rolling-window')).toBeNull();
    expect(byId('spread')).toBeNull();
    fireEvent.click(byId('rolling')!);
    expect(store.getState().reference).toEqual({ kind: 'rolling', seconds: 60 });
    expect(byId('reference-source')?.textContent).toContain('Rolling mean of the last 60 s');
    const window = byId('rolling-window') as HTMLInputElement;
    expect(window.value).toBe('60');
    fireEvent.change(window, { target: { value: '120' } });
    fireEvent.blur(window);
    expect(store.getState().reference).toEqual({ kind: 'rolling', seconds: 120 });
    const spread = byId('spread') as HTMLSelectElement;
    expect(spread.value).toBe('1');
    fireEvent.change(spread, { target: { value: '3' } });
    expect(store.getState().spread).toBe(3);
    fireEvent.click(byId('rolling')!);
    expect(store.getState().reference).toBeNull();
    expect(byId('reference-source')?.textContent).toBe(
      'None — add a PV, take a snapshot or turn on Rolling mean'
    );
  });

  it('a snapshot reads "Snapshot HH:MM:SS of n curves — this session only"', () => {
    const time = new Date(2026, 9, 14, 9, 5, 7).getTime();
    const state = makeState({ reference: snapshot(time, [A, B]) });
    expect(referenceSourceText(state)).toBe('Snapshot 09:05:07 of 2 curves — this session only');
    expect(clockTime(time)).toBe('09:05:07');
    mount(state);
    expect(byId('reference-source')?.textContent).toBe(
      'Snapshot 09:05:07 of 2 curves — this session only'
    );
    expect(referenceSourceText(makeState({ reference: snapshot(time, [A]) }))).toBe(
      'Snapshot 09:05:07 of 1 curve — this session only'
    );
  });
});

// ------------------------------------------------------------------ items --

describe('Waveform schema — Live cards', () => {
  it('Signal holds Label · Plot on (Visible is the card eye); Style Colour · Line · Width · Dash', () => {
    mount(makeState(), item('live', A));
    expect(cardBlocks()).toEqual([CARD_BLOCKS.signal.id, CARD_BLOCKS.style.id]);
    expect(blockFieldIds('signal')).toEqual(['label', 'group']);
    expect(blockFieldIds('style')).toEqual(['line-type', 'line-width', 'line-style']);
    expect(screen.getByTestId('trace-color-swatch')).toBeTruthy();
    expect(schema.items.live.tabs.map((t) => t.fields.map((f) => f.id))).toEqual([
      ['label', 'group', 'visible'],
      ['colour', 'line-type', 'line-width', 'line-style'],
    ]);
    expect(byId('group')?.closest('.wb-field')?.textContent).toContain('Plot on');
  });

  it('declares the card slots: Visible is the eye, Colour the swatch', () => {
    expect(fieldOf('live', 'visible')).toMatchObject({ kind: 'toggle', row: 'eye' });
    expect(fieldOf('live', 'colour')).toMatchObject({ kind: 'colour', row: 'swatch' });
    expect(fieldOf('reference', 'visible')).toMatchObject({ row: 'eye' });
    expect(fieldOf('reference', 'colour')).toMatchObject({ row: 'swatch' });
    const xs = schema.items.xsource.tabs.flatMap((t) => t.fields).map((f) => f.id);
    expect(xs).toEqual(['label', 'group']);
  });

  it('Label: automatic is the PV; pinning sets the record-key dot; reset deletes it', () => {
    const store = mount(makeState(), item('live', B));
    const label = byId('label') as HTMLInputElement;
    expect(label.value).toBe(B);
    expect(dot('Label')).toBeNull();
    fireEvent.change(label, { target: { value: 'Orbit' } });
    fireEvent.blur(label);
    expect(store.getState().styles[B]).toEqual({ label: 'Orbit' });
    expect(dot('Label')).not.toBeNull();
    reset('Label');
    expect(store.getState().styles[B]).toBeUndefined();
    expect(dot('Label')).toBeNull();
  });

  it('Colour: automatic is the positional colour; picking it still pins it', () => {
    const store = mount(makeState(), item('live', B));
    expect(dot('Colour')).toBeNull();
    expect(screen.getByTestId('trace-color-swatch')).toBeTruthy();
    const colour = fieldOf('live', 'colour');
    if (colour.kind !== 'colour') throw new Error('no colour field');
    const ctx = ctxOf(
      store.getState(),
      { level: 'item', kind: 'live', id: waveformItemId('live', B) },
      store.update
    );
    expect(colour.get(ctx)).toBe(autoYColor(1));
    act(() => colour.set(ctx, autoYColor(1)));
    expect(store.getState().styles[B]).toEqual({ color: autoYColor(1) });
    expect(dot('Colour')).not.toBeNull();
    reset('Colour');
    expect(store.getState().styles[B]).toBeUndefined();
  });

  it('Visible: the card eye hides through the `hidden` record, which is its dot', () => {
    const store = mount(makeState(), item('live', A));
    expect(byId('visible')).toBeNull();
    const card = document.querySelector(`[data-card-id="${waveformItemId('live', A)}"]`)!;
    const eye = card.querySelector('button[aria-label="Hide visible"]') as HTMLButtonElement;
    fireEvent.click(eye);
    expect(store.getState().hidden).toEqual({ [A]: true });

    const visible = fieldOf('live', 'visible');
    const target: Target = { level: 'item', kind: 'live', id: waveformItemId('live', A) };
    expect(visible.modified?.(ctxOf(store.getState(), target))).toBe(true);
    act(() => visible.reset?.(ctxOf(store.getState(), target, store.update)));
    expect(store.getState().hidden).toEqual({});
  });

  it('Plot on: moves to X axis PV; a full Live is a disabled option with the full-Live reason', () => {
    const store = mount(makeState({ xs: XS }), item('live', A));
    const group = byId('group') as HTMLSelectElement;
    expect(group.value).toBe('live');
    fireEvent.change(group, { target: { value: 'xsource' } });
    // Occupied X axis PV swaps: the old X axis PV takes A's Live slot.
    expect(store.getState().xs).toBe(A);
    expect(store.getState().pvs).toEqual([XS, B]);
    cleanup();

    const pvs = Array.from({ length: MAX_LIVE }, (_, i) => `WF:${i}`);
    mount(makeState({ pvs, reference: { kind: 'pv', pv: R } }), item('reference', R));
    // The Reference card has no Plot on: its moves are drags (the binding's moveRefusal).
    expect(byId('group')).toBeNull();
    const s = makeState({ pvs: pvs.slice(0, MAX_LIVE - 1), reference: { kind: 'pv', pv: R } });
    expect(waveformMoveRefusal(s, waveformItemId('reference', R), 'live')).toBeNull();
  });

  it('Plot on lists Live, Reference and X axis PV; Live is disabled with the reason while full', () => {
    const pvs = Array.from({ length: MAX_LIVE }, (_, i) => `WF:${i}`);
    const group = fieldOf('live', 'group');
    if (group.kind !== 'select') throw new Error('no group field');
    const state = makeState({ pvs });
    const ctx = (id: string) => ctxOf(state, { level: 'item', kind: 'live', id });
    // A Live curve moving within Live is never refused.
    expect(group.options(ctx(waveformItemId('live', 'WF:0')))).toEqual([
      { value: 'live', label: 'Live' },
      { value: 'reference', label: 'Reference' },
      { value: 'xsource', label: 'X axis PV' },
    ]);
    // The options read the shared move rule: a PV outside a full Live sees it disabled.
    const withRef = makeState({ pvs, reference: { kind: 'pv', pv: R } });
    const refCtx = { ...ctx(waveformItemId('reference', R)), state: withRef };
    expect(group.options(refCtx)[0]).toEqual({
      value: 'live',
      label: 'Live',
      disabled: 'Live is full (8/8)',
    });
  });

  it('Style: Line, Width and Dash pin per field; defaults are line, 1.5 px, solid', () => {
    const store = mount(makeState(), item('live', A));
    const type = byId('line-type') as HTMLSelectElement;
    const width = byId('line-width') as HTMLInputElement;
    const style = byId('line-style') as HTMLSelectElement;
    expect(type.value).toBe('line');
    expect(Number(width.value)).toBe(DEFAULT_LINE_WIDTH);
    expect(style.value).toBe('solid');
    expect(Array.from(type.options).map((o) => [o.value, o.text])).toEqual([
      ['line', 'Line'],
      ['step', 'Step'],
      ['bars', 'Bars'],
      ['points', 'Points'],
    ]);
    expect(Array.from(style.options).map((o) => [o.value, o.text])).toEqual(
      ['solid', 'dashed', 'dotted', 'dashDot', 'dashDotDot'].map((v) => [v, DASH_LABELS[v]])
    );

    fireEvent.change(type, { target: { value: 'bars' } });
    fireEvent.change(width, { target: { value: '3' } });
    fireEvent.change(style, { target: { value: 'dashDot' } });
    expect(store.getState().styles[A]).toEqual({
      lineType: 'bars',
      width: 3,
      lineStyle: 'dashDot',
    });
    expect(dot('Line')).not.toBeNull();
    reset('Width');
    expect(store.getState().styles[A]).toEqual({ lineType: 'bars', lineStyle: 'dashDot' });
    expect(dot('Width')).toBeNull();
    expect(dot('Dash')).not.toBeNull();

    // Width takes 0.5–20 px; outside it writes nothing.
    fireEvent.change(width, { target: { value: '20' } });
    expect(store.getState().styles[A]?.width).toBe(20);
    fireEvent.change(width, { target: { value: '50' } });
    expect(store.getState().styles[A]?.width).toBe(20);
  });
});

describe('Waveform schema — Reference and X axis PV cards', () => {
  it('Reference (PV): Signal Label (Visible on the eye); Style Colour · Width', () => {
    const store = mount(makeState({ reference: { kind: 'pv', pv: R } }), item('reference', R));
    expect(cardBlocks()).toEqual(['signal', 'style']);
    expect(blockFieldIds('signal')).toEqual(['label']);
    expect(blockFieldIds('style')).toEqual(['line-width']);
    expect(screen.getByTestId('trace-color-swatch')).toBeTruthy();
    expect(byId('line-type')).toBeNull();
    expect(byId('line-style')).toBeNull();
    expect((byId('label') as HTMLInputElement).value).toBe(R);

    fireEvent.change(byId('line-width')!, { target: { value: '2' } });
    expect(store.getState().styles[R]).toEqual({ width: 2 });
    expect(dot('Width')).not.toBeNull();
    const card = document.querySelector(`[data-card-id="${waveformItemId('reference', R)}"]`)!;
    fireEvent.click(card.querySelector('button[aria-label="Hide visible"]')!);
    expect(store.getState().hidden).toEqual({ [R]: true });
  });

  it('Reference (snapshot): styles live on the snapshot; no Visible (no PV to hide)', () => {
    const store = mount(makeState({ reference: snapshot(1000, [A]) }), snapshotItem);
    const card = document.querySelector(`[data-card-id="${SNAPSHOT_ITEM_ID}"]`)!;
    expect(card.querySelector('button[aria-label="Hide visible"]')).toBeNull();
    expect(screen.getByTestId('trace-color-swatch')).toBeTruthy();
    const label = byId('label') as HTMLInputElement;
    fireEvent.change(label, { target: { value: 'Golden orbit' } });
    fireEvent.blur(label);
    const ref = store.getState().reference;
    expect(ref?.kind === 'snapshot' ? ref.style : undefined).toEqual({ label: 'Golden orbit' });
    expect(store.getState().styles).toEqual({});
    expect(dot('Label')).not.toBeNull();
    reset('Label');
    const after = store.getState().reference;
    expect(after?.kind === 'snapshot' ? after.style : 'none').toBeUndefined();
  });

  it('X axis PV: Label (the X axis title) — automatic EGU, pinned as `xLabel` — and Plot on', () => {
    const store = mount(makeState({ xs: XS }), item('xsource', XS));
    expect(cardBlocks()).toEqual(['signal']);
    expect(blockFieldIds('signal')).toEqual(['label', 'group']);
    expect(screen.queryByTestId('trace-color-swatch')).toBeNull();
    expect(screen.getByText('The X axis title')).toBeTruthy();
    expect((byId('group') as HTMLSelectElement).value).toBe('xsource');
    const label = byId('label') as HTMLInputElement;
    expect(label.value).toBe('m');
    fireEvent.change(label, { target: { value: 's position' } });
    fireEvent.blur(label);
    expect(store.getState().xLabel).toBe('s position');
    expect(store.getState().styles).toEqual({});
    expect(dot('Label')).not.toBeNull();
    reset('Label');
    expect(store.getState().xLabel).toBeUndefined();
    expect(dot('Label')).toBeNull();

    fireEvent.change(byId('group')!, { target: { value: 'live' } });
    expect(store.getState().xs).toBe('');
    expect(store.getState().pvs).toEqual([A, B, XS]);
  });
});
