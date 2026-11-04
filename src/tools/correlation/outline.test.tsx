// @vitest-environment jsdom
//
// Correlation's binding half and ToolDefinition, rendered through the
// workbench's properties panel
// over a faked Hare service:
//
// - sections Y (n/8, under Signals, the axis unit on the view-model), X (n/1,
//   under X axis PV) and Trigger (n/1, under Trigger) with the inline
//   `trigger-source` header field, its one control;
// - `pendingTrigger`: choosing PV writes nothing to state, shows the Trigger
//   add row and makes the Source read PV; adding the PV, choosing Timer or
//   Escape clears it;
// - `ops.add` probes through pvs.ts and commits through `edit.addPv`,
//   returning its refusal — PvPicker's add/refusal cases, ported;
// - `ops.move`, `moveRefusal` and the Plot on select share one rule.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { CORRELATION_CATALOG } from '../../annotations/catalog';
import {
  popDrawingHistory,
  withDrawingHistory,
  type DrawingHistoryState,
  type HistoryTag,
} from '../../annotations/history';
import { DRAWING_ITEM_KIND, DRAWINGS_SECTION_KIND } from '../../annotations/host/workbench';
import { UndoKeyListener } from '../../annotations/host/UndoKeyListener';
import type { Annotation } from '../../annotations/model';
import { drawingThemeFor } from '../../annotationTheme';
import type { CorrelationFragmentInput } from './codeFragments';
import { apply, yFullMessage } from './edit';
import { DOWN, FakeHare, SCALAR, WAVEFORM } from '../shared/fakeHare.test-util';
import { useCorrelationPvs } from './pvs';
import {
  defaultCorrelationState,
  MAX_Y,
  normalizeCorrelationState,
  parseCorrelationQuery,
  serializeCorrelationQuery,
  type CorrelationState,
} from './query';
import { useCorrelationStateOut } from './stateOut';
import { PanelHarness } from '../../workbench/__fixtures__/PanelHarness';
import {
  SelectionProvider,
  createSelectionStore,
  type SelectionStore,
} from '../../workbench/selection';
import { TESTIDS } from '../../workbench/testids';
import { CORRELATION_TESTIDS } from './testids';
import type { ToolBinding } from '../../workbench/types';
import { GROUPS } from '../vocabulary';
import { OPEN_IN_WAVEFORM, probeRefusal, waveformQuery } from './outline';
import { ANNOTATIONS_ONLY_REASON, correlationItemId, correlationMoveRefusal } from './schema';
import { DRAWINGS_VISIBLE_FIELD_ID, DRAWING_STAYS_REASON } from '../shared/drawingOutline';
import {
  CORRELATION_SCHEMA,
  useCorrelationDefinition,
  useCorrelationUi,
  type CorrelationModel,
  type CorrelationUiRecord,
} from './tool';
import { METADATA_TIMEOUT_MS, type PvModel } from '../shared/pvTracker';
import { STATE_OUT_DEBOUNCE_MS } from '../shared/publishQuery';

const X = 'SIM:HCM01:SP';
const Y1 = 'SIM:BPM01:X';
const Y2 = 'SIM:BPM02:X';
const Y3 = 'SIM:BPM03:X';

let hare: FakeHare;
let post: ReturnType<typeof vi.spyOn>;
let latest: CorrelationState;
let ui: CorrelationUiRecord;
let binding: ToolBinding<CorrelationState, CorrelationModel>;
let latestModel: CorrelationModel;
let store: SelectionStore;

function fragmentInput(state: CorrelationState): CorrelationFragmentInput {
  return {
    frame: null,
    view: state.view,
    axes: state.axes,
    densityPv: state.dy,
    unitsOf: () => '',
    theme: drawingThemeFor('light'),
    hidden: new Set(Object.keys(state.hidden)),
    width: 600,
    markers: state.markers,
    fit: state.fit,
    legend: state.legend,
    grid: state.grid,
    crosshair: state.crosshair,
    xScale: state.xScale,
    yScale: state.yScale,
    fade: state.fade,
  };
}

// The app's wiring as App.tsx will hold it: the opening state from the URL,
// reported back by stateOut, its PVs tracked over the (fake) Hare service,
// the ui record from `useCorrelationUi`, the definition from `useCorrelationDefinition`.
function Harness({ search }: { search: (p: string) => Promise<string[]> }) {
  const [state, setState] = useState(() => parseCorrelationQuery(window.location.search));
  useCorrelationStateOut(state);
  const pvs = useCorrelationPvs(hare, state);
  const record = useCorrelationUi();
  const model = useMemo<CorrelationModel>(
    () => ({
      pvs: pvs.model,
      fragmentInput,
      unitsOf: (pv) =>
        pvs.model.x?.pv === pv
          ? pvs.model.x.units
          : (pvs.model.ys.find((i) => i.pv === pv)?.units ?? ''),
    }),
    [pvs.model]
  );
  const definition = useCorrelationDefinition({
    state,
    model,
    update: setState,
    pvs,
    ui: record,
    search,
  });
  useLayoutEffect(() => {
    latest = state;
    latestModel = model;
    ui = record;
    binding = definition.binding;
  });
  const common = {
    definition,
    state,
    model,
    ui: record,
    update: setState,
    capabilities: { elog: false },
  };
  return (
    <SelectionProvider store={store}>
      <PanelHarness {...common} catalog={[]} />
    </SelectionProvider>
  );
}

function mount(query: string, search = vi.fn(async () => [] as string[])) {
  window.history.replaceState(null, '', `/x/y/trace/correlation.html?embedded=true&${query}`);
  const opening = window.location.search;
  render(<Harness search={search} />);
  return { opening, search };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function posted(): string[] {
  return post.mock.calls.map((c: unknown[]) => (c[0] as { query: string }).query);
}

function section(id: 'x' | 'y' | 'trig'): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-section-id="${id}"]`);
  if (!el) throw new Error(`no section ${id}`);
  return el;
}

function count(id: 'x' | 'y' | 'trig'): string {
  return section(id).querySelector('.wb-outline-section__count')?.textContent ?? '';
}

function row(role: 'x' | 'y' | 'trig', pv: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-row-id="${correlationItemId(role, pv)}"]`);
  if (!el) throw new Error(`no ${role} row for ${pv}`);
  return el;
}

function statusOf(el: HTMLElement): string {
  return el.querySelector('.wb-outline-row__status')?.getAttribute('aria-label') ?? '';
}

function field(id: 'x' | 'y' | 'trig'): HTMLInputElement {
  return within(section(id)).getByTestId(TESTIDS.outlineAddInput) as HTMLInputElement;
}

function source(): HTMLSelectElement {
  return screen.getByTestId(CORRELATION_TESTIDS.triggerSource) as HTMLSelectElement;
}

async function typeAndEnter(id: 'x' | 'y' | 'trig', pv: string) {
  if (id === 'trig' && source().value !== 'pv') {
    fireEvent.change(source(), { target: { value: 'pv' } });
  }
  fireEvent.change(field(id), { target: { value: pv } });
  fireEvent.keyDown(field(id), { key: 'Enter' });
  await flush();
}

function refusal(id: 'x' | 'y' | 'trig'): HTMLElement {
  return within(section(id)).getByTestId(TESTIDS.outlineAddRefusal);
}

beforeEach(() => {
  vi.useFakeTimers();
  hare = new FakeHare();
  store = createSelectionStore();
  post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

// ------------------------------------------------------------------ outline --

describe('Correlation outline sections', () => {
  it('lists Y n/8 with the axis unit, X 1/1 and Trigger 0/1 with its inline source', async () => {
    mount(`x=${X}&y=${Y1}&y=${Y2}`);
    act(() =>
      hare.initial([
        [X, 'A', SCALAR],
        [Y1, 'mm', SCALAR],
        [Y2, 'mm', SCALAR],
      ])
    );
    await flush();
    expect(count('x')).toBe('1/1');
    expect(count('y')).toBe(`2/${MAX_Y}`);
    expect(count('trig')).toBe('0/1');
    // One section per group: the units show in Axes, and the view-model carries them.
    const vm = binding.outline(latest, latestModel);
    expect(vm.sections.map((s) => [s.id, s.unit])).toEqual([
      ['y', 'mm'],
      ['x', 'A'],
      ['trig', undefined],
    ]);
    expect(document.getElementById('axis-unit')?.textContent).toBe('mm');
    expect(document.getElementById('x-axis-unit')?.textContent).toBe('A');
    expect(within(section('trig')).getByTestId(CORRELATION_TESTIDS.triggerSource)).toBe(source());
    expect(source().value).toBe('timer');
    // No trigger add row until the user chooses PV.
    expect(within(section('trig')).queryByTestId(TESTIDS.outlineAddInput)).toBeNull();
    expect(row('y', Y1)).toBeTruthy();
    expect(statusOf(row('y', Y1))).toBe('Status: ok');
  });

  it('a trigger PV from the state is listed and counts 1/1', () => {
    mount(`x=${X}&y=${Y1}&trig=${Y3}`);
    expect(count('trig')).toBe('1/1');
    expect(row('trig', Y3)).toBeTruthy();
    expect(source().value).toBe('pv');
  });

  it('uses the shared schema with the Source as the Trigger header field', () => {
    const header = CORRELATION_SCHEMA.sections.trig.headerField;
    expect(header?.id).toBe('trigger-source');
    const inTabs = CORRELATION_SCHEMA.sections.trig.tabs.flatMap((t) => t.fields);
    expect(inTabs.map((f) => f.id)).toEqual(['trigger-period', 'trigger-fire']);
  });

  it('shows Signals, X axis PV and Trigger, in that order', () => {
    mount(`x=${X}&y=${Y1}`);
    const headings = [...document.querySelectorAll('.wb-group__heading')].map((h) => h.textContent);
    expect(headings).toEqual([GROUPS.signals, GROUPS.xPv, GROUPS.trigger]);
    expect(section('y').closest('.wb-group')?.getAttribute('data-group')).toBe('signals');
    expect(section('x').closest('.wb-group')?.getAttribute('data-group')).toBe('x-axis-pv');
  });
});

describe('Correlation outline with state from a query (PvPicker port)', () => {
  it('mixed units: the later Y is refused (unit) with its message; state, query and posts unchanged', async () => {
    const query = `x=${X}&y=${Y1}&y=${Y2}&dt=1&n=1000&lookback=1h&view=scatter`;
    const { opening } = mount(query);
    const before = latest;
    act(() => {
      hare.initial([
        [X, 'A', SCALAR],
        [Y2, 'A', SCALAR],
        [Y1, 'mm', SCALAR],
      ]);
    });
    await flush();
    expect(statusOf(row('y', Y1))).toBe('Status: ok');
    expect(statusOf(row('y', Y2))).toBe(
      `Status: ${Y2} is in A; Y axis is mm. Open a new correlation tab (+) for it.`
    );
    advance(STATE_OUT_DEBOUNCE_MS * 10);
    expect(latest).toBe(before);
    expect(serializeCorrelationQuery(latest)).toBe(query);
    expect(window.location.search).toBe(opening);
    expect(post).not.toHaveBeenCalled();
  });

  it('a waveform Y is refused (kind), stays in the state and nothing is posted', async () => {
    const query = `x=${X}&y=${Y1}&y=${Y2}&dt=1&n=1000&lookback=1h&view=scatter`;
    mount(query);
    act(() => {
      hare.initial([
        [X, '', SCALAR],
        [Y1, 'mm', SCALAR],
        [Y2, 'mm', WAVEFORM],
      ]);
    });
    await flush();
    expect(statusOf(row('y', Y2))).toMatch(/waveform/);
    advance(STATE_OUT_DEBOUNCE_MS * 10);
    expect(serializeCorrelationQuery(latest)).toBe(query);
    expect(post).not.toHaveBeenCalled();
  });

  it('a PV without metadata in 3 s goes from pending to stale (unverified)', async () => {
    mount(`x=${X}&y=${Y1}`);
    act(() => hare.initial([[Y1, null, DOWN]]));
    await flush();
    expect(statusOf(row('y', Y1))).toBe('Status: pending');
    advance(METADATA_TIMEOUT_MS);
    expect(statusOf(row('y', Y1))).toBe('Status: stale');
  });
});

// ---------------------------------------------------------------------- add --

describe('Correlation ops.add (PvPicker port)', () => {
  it('a typed waveform is refused inline under its section and not added', async () => {
    mount(`x=${X}&y=${Y1}`);
    await typeAndEnter('y', Y2);
    act(() => hare.initial([[Y2, '', WAVEFORM]]));
    await flush();
    expect(refusal('y').textContent).toMatch(/waveform/);
    expect(latest.ys).toEqual([Y1]);
    advance(STATE_OUT_DEBOUNCE_MS * 2);
    expect(post).not.toHaveBeenCalled();
    expect(hare.subscribed()).not.toContain(Y2);
  });

  it('a typed Y in another unit than the axis is refused with the unit message', async () => {
    mount(`x=${X}&y=${Y1}`);
    act(() => hare.initial([[Y1, 'mm', SCALAR]]));
    await flush();
    await typeAndEnter('y', Y2);
    act(() => hare.initial([[Y2, 'A', SCALAR]]));
    await flush();
    expect(refusal('y').getAttribute('role')).toBe('alert');
    expect(refusal('y').textContent).toBe(
      `${Y2} is in A; Y axis is mm. Open a new correlation tab (+) for it.`
    );
    expect(latest.ys).toEqual([Y1]);
  });

  it('an accepted typed Y is added and posted once, keeping its listener, and the field clears', async () => {
    mount(`x=${X}&y=${Y1}`);
    act(() => hare.initial([[Y1, 'mm', SCALAR]]));
    await flush();
    await typeAndEnter('y', Y2);
    expect(within(section('y')).getByTestId(TESTIDS.outlineAddStatus)).toBeTruthy();
    act(() => hare.initial([[Y2, 'mm', SCALAR]]));
    await flush();
    expect(latest.ys).toEqual([Y1, Y2]);
    expect(statusOf(row('y', Y2))).toBe('Status: ok');
    expect(field('y').value).toBe('');
    advance(STATE_OUT_DEBOUNCE_MS);
    expect(posted()).toHaveLength(1);
    expect(posted()[0]).toContain(`y=${Y2}`);
    expect(hare.log.filter((e) => e.endsWith(Y2))).toEqual([`+${Y2}`]);
  });

  it('a second Enter while checking adds once', async () => {
    mount(`x=${X}&y=${Y1}`);
    await typeAndEnter('y', Y2);
    fireEvent.keyDown(field('y'), { key: 'Enter' });
    await flush();
    expect(within(section('y')).getAllByTestId(TESTIDS.outlineAddStatus)).toHaveLength(1);
    act(() => hare.initial([[Y2, 'mm', SCALAR]]));
    await flush();
    expect(latest.ys).toEqual([Y1, Y2]);
    expect(hare.log.filter((e) => e.endsWith(Y2))).toEqual([`+${Y2}`]);
  });

  it('leaving the field with text adds nothing', async () => {
    mount(`x=${X}&y=${Y1}`);
    fireEvent.change(field('y'), { target: { value: Y2 } });
    fireEvent.blur(field('y'));
    await flush();
    expect(within(section('y')).queryByTestId(TESTIDS.outlineAddStatus)).toBeNull();
    expect(hare.subscribed()).not.toContain(Y2);
  });

  it('a typed PV with no metadata in 3 s is added as unverified', async () => {
    mount(`x=${X}&y=${Y1}`);
    await typeAndEnter('y', Y2);
    advance(METADATA_TIMEOUT_MS);
    await flush();
    expect(latest.ys).toEqual([Y1, Y2]);
    expect(statusOf(row('y', Y2))).toBe('Status: stale');
  });

  it('a search hit is added through the same check', async () => {
    const search = vi.fn(async () => [Y2, Y3]);
    mount(`x=${X}&y=${Y1}`, search);
    fireEvent.change(field('y'), { target: { value: 'SIM:BPM' } });
    advance(300);
    await flush();
    expect(search).toHaveBeenCalledWith('SIM:BPM', expect.anything());
    fireEvent.click(screen.getByRole('option', { name: Y3 }));
    await flush();
    act(() => hare.initial([[Y3, '', SCALAR]]));
    await flush();
    expect(latest.ys).toEqual([Y1, Y3]);
  });

  it('an X is taken only while there is none; a full X shows the note', async () => {
    mount(`y=${Y1}`);
    expect(count('x')).toBe('0/1');
    await typeAndEnter('x', X);
    act(() => hare.initial([[X, '', SCALAR]]));
    await flush();
    expect(latest.x).toBe(X);
    expect(row('x', X)).toBeTruthy();
    expect(within(section('x')).queryByTestId(TESTIDS.outlineAddInput)).toBeNull();
    expect(section('x').textContent).toContain('X is full (1/1)');
    fireEvent.click(within(section('x')).getByRole('button', { name: `Remove ${X}` }));
    expect(latest.x).toBe('');
    expect(field('x')).toBeTruthy();
  });

  it('refuses a full Y and a duplicate before probing (no listener)', async () => {
    const ys = Array.from({ length: MAX_Y }, (_, i) => `SIM:BPM0${i + 1}:X`);
    mount(`x=${X}&${ys.map((y) => `y=${y}`).join('&')}`);
    expect(section('y').textContent).toContain(`Y is full (${MAX_Y}/${MAX_Y})`);
    await expect(binding.ops.add('y', 'SIM:NEW:PV')).resolves.toEqual({
      message: yFullMessage(),
    });
    await expect(binding.ops.add('x', ` ${X} `)).resolves.toEqual({
      message: `${X} is already the X`,
    });
    expect(hare.subscribed()).not.toContain('SIM:NEW:PV');
  });

  it('an empty name adds nothing', async () => {
    mount(`x=${X}`);
    const before = latest;
    await expect(binding.ops.add('y', '   ')).resolves.toBeUndefined();
    expect(latest).toBe(before);
  });
});

// ------------------------------------------------- open in Waveform --

describe('Open in Waveform', () => {
  const WF = 'SIM:WF:01';

  function openPosts(): unknown[] {
    return post.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((m: unknown) => (m as { type?: string }).type === 'canopy:trace-open');
  }

  it("a waveform PV's refusal carries the action; clicking it posts exactly the contract message once", async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    mount(`x=${X}&y=${Y1}`);
    await typeAndEnter('y', WF);
    act(() => hare.initial([[WF, '', WAVEFORM]]));
    await flush();
    expect(refusal('y').textContent).toMatch(/waveform/);
    const action = within(refusal('y')).getByRole('button', { name: OPEN_IN_WAVEFORM });
    expect(openPosts()).toEqual([]);
    fireEvent.click(action);
    expect(openPosts()).toEqual([
      { type: 'canopy:trace-open', tool: 'waveform', query: `pv=${WF}` },
    ]);
    const call = post.mock.calls.find(
      (c: unknown[]) => (c[0] as { type?: string }).type === 'canopy:trace-open'
    ) as unknown[];
    expect(call[1]).toBe(window.location.origin);
    expect(open).not.toHaveBeenCalled();
    expect(latest.ys).toEqual([Y1]);
  });

  it('a scalar (unit) refusal has no action and its text is unchanged', async () => {
    mount(`x=${X}&y=${Y1}`);
    act(() => hare.initial([[Y1, 'mm', SCALAR]]));
    await flush();
    await typeAndEnter('y', Y2);
    act(() => hare.initial([[Y2, 'A', SCALAR]]));
    await flush();
    expect(refusal('y').textContent).toBe(
      `${Y2} is in A; Y axis is mm. Open a new correlation tab (+) for it.`
    );
    expect(within(refusal('y')).queryByRole('button')).toBeNull();
  });

  it('probeRefusal: only reason waveform carries the action', () => {
    expect(probeRefusal(WF, { ok: false, message: 'm', reason: 'scalar' })).toEqual({
      message: 'm',
    });
    expect(probeRefusal(WF, { ok: false, message: 'm' })).toEqual({ message: 'm' });
    const wf = probeRefusal(WF, { ok: false, message: 'm', reason: 'waveform' });
    expect(wf.message).toBe('m');
    expect(wf.action?.label).toBe(OPEN_IN_WAVEFORM);
  });

  it('waveformQuery keeps ":" readable and encodes the rest', () => {
    expect(waveformQuery('SIM:WF:01')).toBe('pv=SIM:WF:01');
    expect(waveformQuery('A B&C')).toBe('pv=A%20B%26C');
  });
});

// ----------------------------------------------------------- pendingTrigger --

describe('pendingTrigger', () => {
  it('choosing PV writes nothing to state, shows the add row and the Source reads PV', async () => {
    mount(`x=${X}&y=${Y1}`);
    const before = latest;
    fireEvent.change(source(), { target: { value: 'pv' } });
    expect(latest).toBe(before);
    expect(ui.pendingTrigger).toBe(true);
    expect(source().value).toBe('pv');
    expect(field('trig')).toBeTruthy();
    act(() => store.select({ level: 'section', kind: 'trig', id: 'trig' }, 'user'));
    // The header control is the Source's one home.
    expect(screen.getAllByTestId(CORRELATION_TESTIDS.triggerSource)).toHaveLength(1);
    expect(document.getElementById('trigger-source')).toBeNull();
    expect(source().value).toBe('pv');
    // Period is the Timer's only.
    expect(document.getElementById('trigger-period')).toBeNull();
    advance(STATE_OUT_DEBOUNCE_MS * 2);
    expect(post).not.toHaveBeenCalled();
  });

  it('adding the trigger PV switches to PV mode and clears the flag', async () => {
    mount(`x=${X}&y=${Y1}`);
    await typeAndEnter('trig', Y3);
    act(() => hare.initial([[Y3, '', SCALAR]]));
    await flush();
    expect(latest.trigger).toEqual({ mode: 'pv', pv: Y3 });
    expect(ui.pendingTrigger).toBe(false);
    expect(row('trig', Y3)).toBeTruthy();
    expect(source().value).toBe('pv');
    // Removing it returns to Timer; the add row does not come back.
    fireEvent.click(within(section('trig')).getByRole('button', { name: `Remove ${Y3}` }));
    expect(latest.trigger).toEqual({ mode: 'timer', dtS: 1 });
    expect(source().value).toBe('timer');
    expect(within(section('trig')).queryByTestId(TESTIDS.outlineAddInput)).toBeNull();
  });

  it('a refused trigger PV keeps the flag and the add row', async () => {
    mount(`x=${X}&y=${Y1}`);
    await typeAndEnter('trig', Y3);
    act(() => hare.initial([[Y3, '', WAVEFORM]]));
    await flush();
    expect(refusal('trig').textContent).toMatch(/waveform/);
    expect(latest.trigger.mode).toBe('timer');
    expect(ui.pendingTrigger).toBe(true);
    expect(field('trig')).toBeTruthy();
  });

  it('choosing Timer clears the flag and the add row', () => {
    mount(`x=${X}&y=${Y1}`);
    fireEvent.change(source(), { target: { value: 'pv' } });
    expect(field('trig')).toBeTruthy();
    fireEvent.change(source(), { target: { value: 'timer' } });
    expect(ui.pendingTrigger).toBe(false);
    expect(source().value).toBe('timer');
    expect(within(section('trig')).queryByTestId(TESTIDS.outlineAddInput)).toBeNull();
    expect(latest.trigger).toEqual({ mode: 'timer', dtS: 1 });
  });

  it('choosing Timer with a trigger PV drops the PV', () => {
    mount(`x=${X}&y=${Y1}&trig=${Y3}`);
    fireEvent.change(source(), { target: { value: 'timer' } });
    expect(latest.trigger).toEqual({ mode: 'timer', dtS: 1 });
    expect(document.querySelector(`[data-row-id="${correlationItemId('trig', Y3)}"]`)).toBeNull();
  });

  it('Escape in the empty Trigger add row clears the flag; state unchanged', () => {
    mount(`x=${X}&y=${Y1}`);
    const before = latest;
    fireEvent.change(source(), { target: { value: 'pv' } });
    fireEvent.keyDown(field('trig'), { key: 'Escape' });
    expect(ui.pendingTrigger).toBe(false);
    expect(source().value).toBe('timer');
    expect(within(section('trig')).queryByTestId(TESTIDS.outlineAddInput)).toBeNull();
    expect(latest).toBe(before);
  });

  it('an Escape an inner control claimed leaves the flag set', () => {
    mount(`x=${X}&y=${Y1}`);
    fireEvent.change(source(), { target: { value: 'pv' } });
    const claimed = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    claimed.preventDefault();
    act(() => {
      document.body.dispatchEvent(claimed);
    });
    expect(ui.pendingTrigger).toBe(true);
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(ui.pendingTrigger).toBe(false);
  });

  it('moving a PV into Trigger clears the flag', () => {
    mount(`x=${X}&y=${Y1}&y=${Y2}`);
    fireEvent.change(source(), { target: { value: 'pv' } });
    act(() => binding.ops.move(correlationItemId('y', Y2), 'trig'));
    expect(latest.trigger).toEqual({ mode: 'pv', pv: Y2 });
    expect(latest.ys).toEqual([Y1]);
    expect(ui.pendingTrigger).toBe(false);
  });
});

// ------------------------------------------------------------ move / remove --

describe('Correlation ops.move, moveRefusal and remove', () => {
  const fullYs = Array.from({ length: MAX_Y }, (_, i) => `SIM:BPM0${i + 1}:X`);

  it('moveRefusal is the Plot on select rule: a full Y refuses', () => {
    mount(`x=${X}&${fullYs.map((y) => `y=${y}`).join('&')}&trig=${Y3}`);
    const itemId = correlationItemId('x', X);
    expect(binding.moveRefusal(itemId, 'y')).toBe(yFullMessage());
    expect(binding.moveRefusal(itemId, 'y')).toBe(correlationMoveRefusal(latest, itemId, 'y'));
    expect(binding.moveRefusal(itemId, 'trig')).toBeNull();
    // The Plot on select disables Y with the same reason.
    act(() => store.select({ level: 'item', kind: 'x', id: itemId }, 'user'));
    const role = document.getElementById('role') as HTMLSelectElement;
    const yOption = within(role).getByRole('option', {
      name: new RegExp(yFullMessage().replace(/[()]/g, '\\$&')),
    }) as HTMLOptionElement;
    expect(yOption.disabled).toBe(true);
  });

  it('a refused move changes nothing', () => {
    mount(`x=${X}&${fullYs.map((y) => `y=${y}`).join('&')}`);
    const before = latest;
    act(() => binding.ops.move(correlationItemId('x', X), 'y'));
    expect(latest).toBe(before);
  });

  it('moving the X onto an occupied Trigger swaps them', () => {
    mount(`x=${X}&y=${Y1}&trig=${Y3}`);
    act(() => binding.ops.move(correlationItemId('x', X), 'trig'));
    expect(latest.x).toBe(Y3);
    expect(latest.trigger).toEqual({ mode: 'pv', pv: X });
  });

  it('the Plot on select moves through the same writer', () => {
    mount(`x=${X}&y=${Y1}&y=${Y2}`);
    const itemId = correlationItemId('y', Y2);
    act(() => store.select({ level: 'item', kind: 'y', id: itemId }, 'user'));
    fireEvent.change(document.getElementById('role') as HTMLSelectElement, {
      target: { value: 'x' },
    });
    expect(latest.x).toBe(Y2);
    expect(latest.ys).toEqual([Y1, X]);
  });

  it('removing a Y releases its listener and clears a density Y on it', async () => {
    mount(`x=${X}&y=${Y1}&y=${Y2}&dy=${Y2}`);
    expect(hare.subscribed()).toContain(Y2);
    fireEvent.click(within(section('y')).getByRole('button', { name: `Remove ${Y2}` }));
    await flush();
    expect(latest.ys).toEqual([Y1]);
    expect(latest.dy).toBe('');
    expect(hare.subscribed()).not.toContain(Y2);
  });
});

// ---------------------------------------------------------------- drawings --
//
// The Drawings section over `state.drawings`, its card (every write through
// `update`, so the drawing ring records it), the
// hide-all eye on `ui.drawingsHidden`, and drawing ids recognised before PV
// ids by `remove` and the move rule. The harness holds the app record
// `{state, drawingHistory}` as App.tsx does, with ⌘Z through UndoKeyListener.

const DOC = 'correlation';
type Tracked = DrawingHistoryState & { drawings: readonly Annotation[] };
interface DrawingApp {
  state: CorrelationState;
  drawingHistory: DrawingHistoryState;
}
const trackedOf = (a: DrawingApp): Tracked => ({ ...a.drawingHistory, drawings: a.state.drawings });
const listsOf = (t: Tracked) => new Map([[DOC, t.drawings]]);

let drawingApp: DrawingApp;

function drawing(id: string, over: Partial<Annotation> = {}): Annotation {
  return {
    id,
    kind: 'hline',
    points: [{ t: 0, v: 1.5 }],
    axisId: Y1,
    color: '#112233',
    width: 1.5,
    text: '',
    ...over,
  };
}

const STUB_PVS: PvModel = { x: null, ys: [], trig: null, axisUnit: null, decided: true };

function DrawingsHarness({ initial, drawnX }: { initial: CorrelationState; drawnX?: string }) {
  const [record, setRecord] = useState<DrawingApp>(() => ({
    state: initial,
    drawingHistory: { history: new Map() },
  }));
  const writeApp = useCallback((fn: (a: DrawingApp) => DrawingApp, tag?: HistoryTag) => {
    const nowMs = Date.now();
    setRecord((prev) => {
      const next = fn(prev);
      if (next === prev) return prev;
      const after = trackedOf(next);
      const out = withDrawingHistory(trackedOf(prev), after, tag, nowMs, listsOf);
      if (out === after) return next;
      return {
        ...next,
        drawingHistory: { history: out.history, annotationMark: out.annotationMark },
      };
    });
  }, []);
  const update = useCallback(
    (fn: (s: CorrelationState) => CorrelationState) =>
      writeApp((a) => {
        const next = apply(a.state, fn);
        return next === a.state ? a : { ...a, state: next };
      }),
    [writeApp]
  );
  const undo = useCallback(
    () =>
      writeApp((a) => {
        const t = trackedOf(a);
        const popped = popDrawingHistory(t, DOC, (s, list) => ({ ...s, drawings: list }));
        if (popped === t) return a;
        return {
          state: { ...a.state, drawings: popped.drawings as Annotation[] },
          drawingHistory: { history: popped.history, annotationMark: popped.annotationMark },
        };
      }, 'undo'),
    [writeApp]
  );
  const record2 = useCorrelationUi();
  const model = useMemo<CorrelationModel>(() => {
    const m: CorrelationModel = { pvs: STUB_PVS, fragmentInput, unitsOf: () => '' };
    if (drawnX !== undefined) m.drawnX = drawnX;
    return m;
  }, [drawnX]);
  const pvs = useMemo(
    () => ({
      probe: async () => ({ ok: false as const, reason: 'kind' as const, message: 'no' }),
      endProbe: () => {},
    }),
    []
  );
  const definition = useCorrelationDefinition({
    state: record.state,
    model,
    update,
    pvs: pvs as unknown as Parameters<typeof useCorrelationDefinition>[0]['pvs'],
    ui: record2,
  });
  useLayoutEffect(() => {
    drawingApp = record;
    latest = record.state;
    ui = record2;
    binding = definition.binding;
  });
  const common = {
    definition,
    state: record.state,
    model,
    ui: record2,
    update,
    capabilities: { elog: false },
  };
  return (
    <SelectionProvider store={store}>
      <PanelHarness {...common} catalog={[]} />
      <UndoKeyListener onUndo={undo} />
    </SelectionProvider>
  );
}

function drawingState(over: Partial<CorrelationState> = {}): CorrelationState {
  return normalizeCorrelationState(
    { ...defaultCorrelationState(), x: X, ys: [Y1, Y2], ...over },
    CORRELATION_CATALOG
  );
}

function mountDrawings(initial: CorrelationState, drawnX?: string) {
  window.history.replaceState(null, '', '/x/y/trace/correlation.html?embedded=true');
  render(<DrawingsHarness initial={initial} drawnX={drawnX} />);
}

function annotations(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-section-id="${DRAWINGS_SECTION_KIND}"]`);
}

function drawingRow(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
  if (!el) throw new Error(`no drawing row ${id}`);
  return el;
}

describe('Correlation binding — drawings', () => {
  it('lists no Drawings section while there are no drawings', () => {
    mountDrawings(drawingState());
    expect(annotations()).toBeNull();
    expect(
      binding
        .outline(latest, { pvs: STUB_PVS, fragmentInput, unitsOf: () => '' })
        .sections.map((s) => s.id)
    ).toEqual(['y', 'x', 'trig']);
  });

  it('lists the drawings after Trigger, in order, as annotation rows', () => {
    mountDrawings(drawingState({ drawings: [drawing('a1'), drawing('a2', { axisId: Y2 })] }));
    const vm = binding.outline(latest, {
      pvs: STUB_PVS,
      fragmentInput,
      unitsOf: () => '',
    });
    expect(vm.sections.map((s) => s.id)).toEqual(['y', 'x', 'trig', DRAWINGS_SECTION_KIND]);
    const section = vm.sections[3];
    expect(section.count).toBe(2);
    expect(section.rows.map((r) => [r.id, r.kind, r.status])).toEqual([
      ['a1', DRAWING_ITEM_KIND, 'ok'],
      ['a2', DRAWING_ITEM_KIND, 'ok'],
    ]);
    expect(annotations()).not.toBeNull();
    expect(annotations()?.closest('.wb-group')?.getAttribute('data-group')).toBe('drawings');
    expect(statusOf(drawingRow('a1'))).toBe('Status: ok');
  });

  it('dims a drawing hidden by context with its reason', () => {
    mountDrawings(drawingState({ drawings: [drawing('a1'), drawing('a2', { axisId: Y2 })] }));
    act(() => binding.ops.remove(correlationItemId('y', Y2)));
    expect(latest.ys).toEqual([Y1]);
    expect(statusOf(drawingRow('a2'))).toBe('Status: series removed');
    expect(drawingRow('a2').querySelector('.wb-outline-row__status--stale')).not.toBeNull();
    expect(statusOf(drawingRow('a1'))).toBe('Status: ok');
  });

  it("compares an X-bound drawing with the model's drawn X, else the state's X", () => {
    const vline = drawing('v1', { kind: 'vline', points: [{ t: 2, v: 0 }], xRef: X });
    mountDrawings(drawingState({ drawings: [vline] }), Y2);
    expect(statusOf(drawingRow('v1'))).toBe('Status: x source changed');
    const fallback = binding.outline(latest, { pvs: STUB_PVS, fragmentInput, unitsOf: () => '' });
    expect(fallback.sections[3].rows[0].status).toBe('ok');
  });

  it('removes a drawing by id before reading a PV item id, and ⌘Z restores it', () => {
    // A drawing id that also parses as a PV item id: the drawing wins.
    const tricky = drawing(correlationItemId('y', Y1));
    const raw = { ...drawingState(), drawings: [tricky] };
    mountDrawings(raw);
    act(() => binding.ops.remove(tricky.id));
    expect(latest.drawings).toEqual([]);
    expect(latest.ys).toEqual([Y1, Y2]);
    act(() => {
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    });
    expect(latest.drawings.map((a) => a.id)).toEqual([tricky.id]);
  });

  it('a drawing never moves; no PV moves into Drawings', () => {
    mountDrawings(drawingState({ drawings: [drawing('a1')] }));
    expect(binding.moveRefusal?.('a1', 'y')).toBe(DRAWING_STAYS_REASON);
    expect(binding.moveRefusal?.(correlationItemId('y', Y1), DRAWINGS_SECTION_KIND)).toBe(
      ANNOTATIONS_ONLY_REASON
    );
    const before = latest;
    act(() => binding.ops.move?.('a1', 'x'));
    act(() => binding.ops.move?.(correlationItemId('y', Y1), DRAWINGS_SECTION_KIND));
    expect(latest).toBe(before);
  });

  it('a card colour edit, then ⌘Z, restores the colour', () => {
    mountDrawings(drawingState({ drawings: [drawing('a1', { color: '#112233' })] }));
    act(() => store.select({ level: 'item', kind: DRAWING_ITEM_KIND, id: 'a1' }, 'user'));
    const input = document.querySelector('.wb-card__body input[type="color"]') as HTMLInputElement;
    expect(input.value).toBe('#112233');
    fireEvent.change(input, { target: { value: '#ff8800' } });
    expect(latest.drawings[0].color).toBe('#ff8800');
    expect(drawingApp.drawingHistory.history.get(DOC)).toHaveLength(1);
    act(() => {
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    });
    expect(latest.drawings[0].color).toBe('#112233');
    expect(
      (document.querySelector('.wb-card__body input[type="color"]') as HTMLInputElement).value
    ).toBe('#112233');
  });

  it('the header eye hides and shows every drawing through ui.drawingsHidden', () => {
    mountDrawings(drawingState({ drawings: [drawing('a1')] }));
    const eye = () => within(annotations()!).getByTestId(DRAWINGS_VISIBLE_FIELD_ID) as HTMLElement;
    expect(ui.drawingsHidden).toBe(false);
    fireEvent.click(eye());
    expect(ui.drawingsHidden).toBe(true);
    fireEvent.click(eye());
    expect(ui.drawingsHidden).toBe(false);
    // Not an undo step, not state.
    expect(drawingApp.drawingHistory.history.get(DOC) ?? []).toHaveLength(0);
  });
});
