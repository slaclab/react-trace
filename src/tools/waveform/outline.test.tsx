// @vitest-environment jsdom
//
// Waveform's binding half and ToolDefinition, rendered through the properties
// panel:
//
// - sections Live (n/8, the axis unit tag), Reference (0–1) and X (0–1) under
//   the Signals, Reference and X axis PV headings, cards with status and chip
//   text from the derived model;
// - `ops.add` probes with the waveform kind rule and commits through
//   `edit.addPv`, returning its refusal; adding to Reference sets a PV
//   reference;
// - `ops.move`, `moveRefusal` and the Plot on select share one rule ("Live is
//   full (8/8)"; an occupied X axis PV swaps);
// - removing an earlier curve keeps a later curve's style;
// - the view-model is kept while the model is structurally unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { useLayoutEffect, useMemo, useState } from 'react';
import { drawingThemeFor } from '../../annotationTheme';
import { FakeHare, SCALAR, WAVEFORM } from '../shared/fakeHare.test-util';
import { liveFullMessage } from './edit';
import {
  deriveWaveformModel,
  unitMessage,
  type WaveformMetaMap,
  type WaveformRingSummary,
} from './model';
import type { WaveformPlotInput } from './plotOption';
import {
  defaultWaveformState,
  MAX_LIVE,
  normalizeWaveformState,
  type WaveformState,
} from './query';
import { PanelHarness } from '../../workbench/__fixtures__/PanelHarness';
import {
  SelectionProvider,
  createSelectionStore,
  type SelectionStore,
} from '../../workbench/selection';
import { TESTIDS } from '../../workbench/testids';
import type { ToolBinding } from '../../workbench/types';
import { SNAPSHOT_MOVE_REFUSAL, waveformBinding, waveformOutline } from './outline';
import { ROLLING_ITEM_ID, SNAPSHOT_ITEM_ID, waveformItemId, waveformMoveRefusal } from './schema';
import {
  WAVEFORM_SCHEMA,
  createWaveformProbe,
  useWaveformDefinition,
  type WaveformProbe,
  type WaveformToolModel,
} from './tool';
import type { ProbeResult } from '../shared/pvTracker';

type State = WaveformState;
type Group = 'live' | 'reference' | 'xsource';

const A = 'WF:A';
const B = 'WF:B';
const C = 'WF:C';
const R = 'WF:REF';
const XS = 'WF:S';

const ring = (length: number, connected = true): WaveformRingSummary => ({
  connected,
  length,
  resetEpoch: 0,
  arrival: 1,
});

function stateOf(patch: Partial<State>): State {
  return normalizeWaveformState({ ...defaultWaveformState(), ...patch });
}

let latest: State;
let binding: ToolBinding<State, WaveformToolModel>;
let store: SelectionStore;
let rings: Record<string, WaveformRingSummary | undefined>;
let meta: WaveformMetaMap;
let probe: WaveformProbe & { probe: ReturnType<typeof vi.fn> };
let setTick: (n: number) => void = () => {};

function modelOf(state: State): WaveformToolModel {
  const waveform = deriveWaveformModel({ state, rings, meta, metaTimedOut: true });
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

function Harness({ initial, onOutline }: { initial: State; onOutline?: () => void }) {
  const [state, setState] = useState(initial);
  const [tick, setTickState] = useState(0);
  // A new model object every tick, as a data tick hands the app.
  const model = useMemo(() => {
    void tick;
    return modelOf(state);
  }, [state, tick]);
  const definition = useWaveformDefinition({ state, update: setState, probe });
  useLayoutEffect(() => {
    latest = state;
    binding = definition.binding;
  });
  useLayoutEffect(() => {
    setTick = setTickState;
  }, []);
  onOutline?.();
  const common = {
    definition,
    state,
    model,
    ui: {},
    update: setState,
    capabilities: { elog: false },
  };
  return (
    <SelectionProvider store={store}>
      <PanelHarness {...common} catalog={[]} />
    </SelectionProvider>
  );
}

function mount(initial: State) {
  return render(<Harness initial={initial} />);
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function section(id: Group): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-section-id="${id}"]`);
  if (!el) throw new Error(`no section ${id}`);
  return el;
}

function count(id: Group): string {
  return section(id).querySelector('.wb-outline-section__count')?.textContent ?? '';
}

function rowEl(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
  if (!el) throw new Error(`no row ${id}`);
  return el;
}

function statusOf(el: HTMLElement): string {
  return el.querySelector('.wb-outline-row__status')?.getAttribute('aria-label') ?? '';
}

async function typeAndEnter(id: Group, pv: string) {
  const input = within(section(id)).getByTestId(TESTIDS.outlineAddInput) as HTMLInputElement;
  fireEvent.change(input, { target: { value: pv } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await flush();
}

function addRefusal(id: Group): string {
  return within(section(id)).getByTestId(TESTIDS.outlineAddRefusal).textContent ?? '';
}

function select(group: Group, pv: string) {
  act(() => {
    store.select({ level: 'item', kind: group, id: waveformItemId(group, pv) }, 'user');
  });
}

const accept = async (): Promise<ProbeResult> => ({
  ok: true,
  info: { pv: '', status: 'ok', units: '' },
});

beforeEach(() => {
  store = createSelectionStore();
  rings = { [A]: ring(4), [B]: ring(4), [C]: ring(4), [R]: ring(4), [XS]: ring(4) };
  meta = {
    [A]: { egu: 'mm' },
    [B]: { egu: 'mm' },
    [C]: { egu: 'mm' },
    [R]: { egu: 'mm' },
    [XS]: { egu: 'm' },
  };
  probe = { probe: vi.fn(accept), endProbe: vi.fn() };
});

afterEach(() => {
  cleanup();
});

describe('waveform outline: sections and rows', () => {
  it('shows Live n/8 with the axis unit, Reference 0–1 and X 0–1', () => {
    mount(stateOf({ pvs: [A, B], reference: { kind: 'pv', pv: R }, xs: XS }));
    expect(count('live')).toBe(`2/${MAX_LIVE}`);
    expect(count('reference')).toBe('1/1');
    expect(count('xsource')).toBe('1/1');
    // The axis unit rides on the view-model; the panel shows it as Axes › Y axis › Unit.
    expect(binding.outline(latest, modelOf(latest)).sections[0].unit).toBe('mm');
    expect(document.getElementById('axis-unit')?.textContent).toBe('mm');
    expect(rowEl(waveformItemId('live', A))).toBeTruthy();
    expect(rowEl(waveformItemId('reference', R))).toBeTruthy();
    expect(rowEl(waveformItemId('xsource', XS))).toBeTruthy();
    // Full single sections take no add row; Live keeps one while it has room.
    expect(within(section('reference')).queryByTestId(TESTIDS.outlineAddInput)).toBeNull();
    expect(within(section('xsource')).queryByTestId(TESTIDS.outlineAddInput)).toBeNull();
    expect(within(section('live')).getByTestId(TESTIDS.outlineAddInput)).toBeTruthy();
  });

  it('titles the sections Live, Reference and X under their group headings', () => {
    const state = stateOf({});
    const outline = waveformOutline(state, modelOf(state).waveform);
    expect(outline.sections.map((s) => s.title)).toEqual(['Live', 'Reference', 'X']);
    expect(outline.sections.map((s) => s.add?.placeholder)).toEqual([
      'Add Live PV',
      'Add Reference PV',
      'Add X axis PV',
    ]);
    mount(state);
    const headings = [...document.querySelectorAll('.wb-group__heading')].map((h) => h.textContent);
    expect(headings).toEqual(['Signals', 'Reference', 'X axis PV']);
  });

  it('lists an empty tool as 0/8, 0/1, 0/1 with three add rows', () => {
    mount(stateOf({}));
    expect(count('live')).toBe(`0/${MAX_LIVE}`);
    expect(count('reference')).toBe('0/1');
    expect(count('xsource')).toBe('0/1');
    for (const id of ['live', 'reference', 'xsource'] as const) {
      expect(within(section(id)).getByTestId(TESTIDS.outlineAddInput)).toBeTruthy();
    }
  });

  it('a unit-refused curve shows its message', () => {
    meta = { ...meta, [B]: { egu: 'V' } };
    mount(stateOf({ pvs: [A, B] }));
    const b = rowEl(waveformItemId('live', B));
    expect(b.querySelector('.wb-outline-row__status--refused')).not.toBeNull();
    expect(statusOf(b)).toBe(`Status: ${unitMessage(B, 'V', 'mm')}`);
    expect(statusOf(rowEl(waveformItemId('live', A)))).toBe('Status: ok');
  });

  it("a row's chip from the model is its status text", () => {
    rings = { ...rings, [B]: ring(4, false) };
    mount(stateOf({ pvs: [A, B] }));
    const b = rowEl(waveformItemId('live', B));
    expect(b.querySelector('.wb-outline-row__status--error')).not.toBeNull();
    expect(statusOf(b)).toBe('Status: disconnected');
  });

  it('card slots come from the item: Live has swatch and eye, X axis PV neither', () => {
    mount(stateOf({ pvs: [A], xs: XS }));
    const a = rowEl(waveformItemId('live', A));
    expect(a.querySelector('.wb-outline-row__swatch')).not.toBeNull();
    expect(a.querySelector('.wb-outline-row__eye')).not.toBeNull();
    const x = rowEl(waveformItemId('xsource', XS));
    expect(x.querySelector('.wb-outline-row__swatch')).toBeNull();
    expect(x.querySelector('.wb-outline-row__eye')).toBeNull();
  });

  it('a snapshot reference is the `snapshot` row, with swatch and no eye', () => {
    const state = stateOf({
      pvs: [A],
      reference: { kind: 'snapshot', frames: { [A]: new Float64Array(4) }, time: 0 },
    });
    mount(state);
    const snap = rowEl(SNAPSHOT_ITEM_ID);
    expect(snap.textContent).toContain('Snapshot');
    expect(snap.querySelector('.wb-outline-row__swatch')).not.toBeNull();
    expect(snap.querySelector('.wb-outline-row__eye')).toBeNull();
  });

  it('a rolling reference is the `rolling` row, labelled with its window, swatch and no eye', () => {
    mount(stateOf({ pvs: [A], reference: { kind: 'rolling', seconds: 45 } }));
    const roll = rowEl(ROLLING_ITEM_ID);
    expect(roll.textContent).toContain('Rolling mean 45 s');
    expect(roll.querySelector('.wb-outline-row__swatch')).not.toBeNull();
    expect(roll.querySelector('.wb-outline-row__eye')).toBeNull();
  });

  it('the row label is the pinned Label, else the PV', () => {
    mount(stateOf({ pvs: [A, B], styles: { [B]: { label: 'Bee' } } }));
    expect(rowEl(waveformItemId('live', A)).textContent).toContain(A);
    expect(rowEl(waveformItemId('live', B)).textContent).toContain('Bee');
  });
});

describe('waveform outline: ops.add', () => {
  it('probes the PV and commits it to Live', async () => {
    mount(stateOf({ pvs: [A] }));
    await typeAndEnter('live', B);
    expect(probe.probe).toHaveBeenCalledWith(B);
    expect(latest.pvs).toEqual([A, B]);
    expect(count('live')).toBe(`2/${MAX_LIVE}`);
  });

  it("returns the probe's refusal and adds nothing", async () => {
    probe.probe.mockResolvedValueOnce({ ok: false, message: 'WF:SC is a scalar PV' });
    mount(stateOf({ pvs: [A] }));
    await typeAndEnter('live', 'WF:SC');
    expect(addRefusal('live')).toBe('WF:SC is a scalar PV');
    expect(latest.pvs).toEqual([A]);
  });

  it('refuses a full Live at once, without a probe', async () => {
    const pvs = Array.from({ length: MAX_LIVE }, (_, i) => `WF:L${i}`);
    mount(stateOf({ pvs }));
    const result = await binding.ops.add('live', 'WF:NEW');
    expect(result).toEqual({ message: liveFullMessage() });
    expect(probe.probe).not.toHaveBeenCalled();
  });

  it('refuses a duplicate at once', async () => {
    mount(stateOf({ pvs: [A] }));
    expect(await binding.ops.add('live', ` ${A} `)).toEqual({ message: `${A} is already in Live` });
    expect(probe.probe).not.toHaveBeenCalled();
  });

  it('commits against the latest state after the probe: a section filled meanwhile refuses', async () => {
    let release: (r: ProbeResult) => void = () => {};
    probe.probe.mockImplementationOnce(
      () =>
        new Promise<ProbeResult>((resolve) => {
          release = resolve;
        })
    );
    mount(stateOf({ pvs: [A] }));
    const pending = binding.ops.add('xsource', B);
    await act(async () => {
      await binding.ops.add('xsource', C);
    });
    expect(latest.xs).toBe(C);
    let result: unknown;
    await act(async () => {
      release({ ok: true, info: { pv: B, status: 'ok', units: '' } });
      result = await pending;
    });
    expect(result).toEqual({ message: 'X axis PV is full (1/1)' });
    expect(latest.xs).toBe(C);
  });

  it('adding to Reference sets a PV reference, replacing a snapshot', async () => {
    mount(
      stateOf({
        pvs: [A],
        reference: { kind: 'snapshot', frames: { [A]: new Float64Array(4) }, time: 0 },
      })
    );
    let result: unknown;
    await act(async () => {
      result = await binding.ops.add('reference', R);
    });
    expect(result).toBeUndefined();
    expect(probe.probe).toHaveBeenCalledWith(R);
    expect(latest.reference).toEqual({ kind: 'pv', pv: R });
    expect(rowEl(waveformItemId('reference', R))).toBeTruthy();
  });

  it('adding to X sets the X axis PV', async () => {
    mount(stateOf({ pvs: [A] }));
    await typeAndEnter('xsource', XS);
    expect(latest.xs).toBe(XS);
  });
});

describe('waveform outline: the waveform kind probe', () => {
  it('accepts a waveform PV and refuses a scalar one', async () => {
    vi.useFakeTimers();
    try {
      const hare = new FakeHare();
      const real = createWaveformProbe(hare);
      probe = { probe: vi.fn((pv: string) => real.probe(pv)), endProbe: vi.fn(real.endProbe) };
      mount(stateOf({}));

      const input = within(section('live')).getByTestId(TESTIDS.outlineAddInput);
      fireEvent.change(input, { target: { value: 'WF:SC' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      act(() => hare.initial([['WF:SC', 'mm', SCALAR]]));
      await flush();
      expect(addRefusal('live')).toContain('WF:SC is a scalar PV');
      expect(latest.pvs).toEqual([]);

      const again = within(section('live')).getByTestId(TESTIDS.outlineAddInput);
      fireEvent.change(again, { target: { value: A } });
      fireEvent.keyDown(again, { key: 'Enter' });
      act(() => hare.initial([[A, 'mm', WAVEFORM]]));
      await flush();
      expect(latest.pvs).toEqual([A]);
      // The probe's hold ends at the commit; the controller owns the listener.
      expect(hare.subscribed()).toEqual([]);
      real.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('waveform outline: move and remove', () => {
  it('Plot on swaps an occupied X axis PV', () => {
    mount(stateOf({ pvs: [A, B], xs: XS }));
    select('live', A);
    const group = document.getElementById('group') as HTMLSelectElement;
    expect(group.value).toBe('live');
    fireEvent.change(group, { target: { value: 'xsource' } });
    expect(latest.xs).toBe(A);
    expect(latest.pvs).toEqual([XS, B]);
    expect(rowEl(waveformItemId('xsource', A))).toBeTruthy();
    expect(rowEl(waveformItemId('live', XS))).toBeTruthy();
  });

  it('ops.move swaps an occupied X axis PV the same way', () => {
    mount(stateOf({ pvs: [A, B], xs: XS }));
    act(() => binding.ops.move(waveformItemId('live', B), 'xsource'));
    expect(latest.xs).toBe(B);
    expect(latest.pvs).toEqual([A, XS]);
  });

  it('moveRefusal and the Plot on select share "Live is full (8/8)"', () => {
    const pvs = Array.from({ length: MAX_LIVE }, (_, i) => `WF:L${i}`);
    mount(stateOf({ pvs, xs: XS }));
    const id = waveformItemId('xsource', XS);
    expect(binding.moveRefusal(id, 'live')).toBe(liveFullMessage());
    expect(binding.moveRefusal(id, 'live')).toBe(waveformMoveRefusal(latest, id, 'live'));
    act(() => binding.ops.move(id, 'live'));
    expect(latest.xs).toBe(XS);
    expect(latest.pvs).toEqual(pvs);

    select('xsource', XS);
    const group = document.getElementById('group') as HTMLSelectElement;
    expect(group.value).toBe('xsource');
    const live = [...group.options].find((o) => o.value === 'live');
    expect(live?.disabled).toBe(true);
    expect(live?.title).toBe(liveFullMessage());
    select('live', pvs[0]);
    const liveGroup = document.getElementById('group') as HTMLSelectElement;
    const option = [...liveGroup.options].find((o) => o.value === 'xsource');
    expect(option?.disabled).toBe(false);
    expect(binding.moveRefusal(waveformItemId('live', pvs[0]), 'xsource')).toBeNull();
  });

  it('a snapshot moves nowhere', () => {
    mount(
      stateOf({
        pvs: [A],
        reference: { kind: 'snapshot', frames: { [A]: new Float64Array(4) }, time: 0 },
      })
    );
    expect(binding.moveRefusal(SNAPSHOT_ITEM_ID, 'live')).toBe(SNAPSHOT_MOVE_REFUSAL);
    expect(binding.moveRefusal(SNAPSHOT_ITEM_ID, 'reference')).toBeNull();
    act(() => binding.ops.move(SNAPSHOT_ITEM_ID, 'live'));
    expect(latest.reference?.kind).toBe('snapshot');
  });

  it("removing an earlier curve keeps a later curve's style", () => {
    mount(stateOf({ pvs: [A, B], styles: { [B]: { color: '#123456', label: 'Bee' } } }));
    fireEvent.click(within(section('live')).getByRole('button', { name: `Remove ${A}` }));
    expect(latest.pvs).toEqual([B]);
    expect(latest.styles[B]).toEqual({ color: '#123456', label: 'Bee' });
    const b = rowEl(waveformItemId('live', B));
    expect(b.textContent).toContain('Bee');
    select('live', B);
    expect(document.getElementById('label')).toHaveProperty('value', 'Bee');
  });

  it('removing the snapshot clears the reference', () => {
    mount(
      stateOf({
        pvs: [A],
        reference: { kind: 'snapshot', frames: { [A]: new Float64Array(4) }, time: 0 },
      })
    );
    act(() => binding.ops.remove(SNAPSHOT_ITEM_ID));
    expect(latest.reference).toBeNull();
  });

  it('removing the X axis PV empties it', () => {
    mount(stateOf({ pvs: [A], xs: XS }));
    fireEvent.click(within(section('xsource')).getByRole('button', { name: `Remove ${XS}` }));
    expect(latest.xs).toBe('');
  });
});

describe('waveform outline: rate rule', () => {
  it('returns the same view-model while the model is structurally unchanged', () => {
    const state = stateOf({ pvs: [A, B], xs: XS });
    const b = waveformBinding({
      getState: () => state,
      update: () => {},
      probe: { probe: accept, endProbe: () => {} },
    });
    const first = b.outline(state, modelOf(state));
    // A data tick: a new model object of the same content.
    expect(b.outline(state, modelOf(state))).toBe(first);
    // A new state object of the same content keeps it too.
    const copy = { ...state };
    expect(b.outline(copy, modelOf(copy))).toBe(first);
    // A status change is a new view-model.
    rings = { ...rings, [B]: ring(4, false) };
    const changed = b.outline(state, modelOf(state));
    expect(changed).not.toBe(first);
    expect(changed).toEqual(waveformOutline(state, modelOf(state).waveform));
  });

  it('a model tick of the same content re-renders no row', () => {
    mount(stateOf({ pvs: [A, B] }));
    const before = rowEl(waveformItemId('live', A));
    const outlineBefore = binding.outline(latest, modelOf(latest));
    act(() => setTick(1));
    act(() => setTick(2));
    expect(rowEl(waveformItemId('live', A))).toBe(before);
    expect(binding.outline(latest, modelOf(latest))).toBe(outlineBefore);
  });

  it('exports the schema built once', () => {
    // The three curve sections, then the drawings section under Drawings.
    expect(Object.keys(WAVEFORM_SCHEMA.sections)).toEqual([
      'live',
      'reference',
      'xsource',
      'annotations',
    ]);
    expect(WAVEFORM_SCHEMA.sections.annotations.group).toBe('Drawings');
  });
});
