import { describe, expect, it } from 'vitest';
import { defaultWaveformState, type WaveformState } from './query';
import {
  CANVAS_ADD,
  CANVAS_NONE_DRAWABLE,
  CANVAS_WAITING,
  ELEMENT_LABEL,
  NOT_IN_SNAPSHOT,
  ROLLING_COLLECTING,
  axisUnitOf,
  clockTime,
  deltaWaitingMessage,
  deriveWaveformModel,
  unitMessage,
  type WaveformMetaMap,
  type WaveformPvMeta,
  type WaveformModelInput,
  type WaveformRingSummary,
} from './model';

const A = 'BPM:X';
const B = 'BPM:Y';
const C = 'COR:H';
const R = 'REF:X';
const S = 'BPM:S';

function state(over: Partial<WaveformState> = {}): WaveformState {
  return { ...defaultWaveformState(), ...over };
}

function ring(length: number | null, over: Partial<WaveformRingSummary> = {}): WaveformRingSummary {
  return {
    connected: true,
    length,
    resetEpoch: 0,
    arrival: length === null ? null : 1000,
    ...over,
  };
}

function input(over: Partial<WaveformModelInput> & { state: WaveformState }): WaveformModelInput {
  return { rings: {}, meta: {}, metaTimedOut: false, ...over };
}

const mm = { egu: 'mm' };
const V = { egu: 'V' };
const none = { egu: '' };

describe('axis unit', () => {
  it('is undecided until every live and reference PV has metadata', () => {
    const s = state({ pvs: [A, B], reference: { kind: 'pv', pv: R } });
    expect(axisUnitOf(s, { [A]: mm, [B]: mm })).toEqual({ decided: false, unit: null });
    expect(axisUnitOf(s, { [A]: mm, [B]: mm, [R]: mm })).toEqual({ decided: true, unit: 'mm' });
  });

  it('is decided by the timeout with the metadata that arrived', () => {
    const s = state({ pvs: [A, B] });
    expect(axisUnitOf(s, { [B]: V }, true)).toEqual({ decided: true, unit: 'V' });
  });

  it('ignores the X source when deciding', () => {
    const s = state({ pvs: [A], xs: S });
    expect(axisUnitOf(s, { [A]: mm })).toEqual({ decided: true, unit: 'mm' });
  });

  it('is the first non-empty EGU in state order, live then reference', () => {
    const s = state({ pvs: [A, B], reference: { kind: 'pv', pv: R } });
    expect(axisUnitOf(s, { [A]: none, [B]: V, [R]: mm }).unit).toBe('V');
    expect(axisUnitOf(s, { [A]: none, [B]: none, [R]: mm }).unit).toBe('mm');
    expect(axisUnitOf(s, { [A]: none, [B]: none, [R]: none })).toEqual({
      decided: true,
      unit: null,
    });
  });

  it('keeps a PV of another unit in its section, not drawn, with the message', () => {
    const s = state({ pvs: [A, B] });
    const m = deriveWaveformModel(
      input({ state: s, meta: { [A]: mm, [B]: V }, rings: { [A]: ring(4), [B]: ring(4) } })
    );
    expect(m.unit).toBe('mm');
    expect(m.live.map((r) => r.pv)).toEqual([A, B]);
    expect(m.live[0]).toMatchObject({ status: 'ok', drawable: true });
    expect(m.live[1]).toMatchObject({
      status: 'refused',
      drawable: false,
      message: `${B} is in V; the axis is mm. Open a new Waveform tab (+) for it.`,
    });
    expect(m.live[1].message).toBe(unitMessage(B, 'V', 'mm'));
  });

  it('accepts a PV with no EGU on any axis', () => {
    const s = state({ pvs: [A, B] });
    const m = deriveWaveformModel(
      input({ state: s, meta: { [A]: mm, [B]: none }, rings: { [A]: ring(4), [B]: ring(4) } })
    );
    expect(m.live[1]).toMatchObject({ status: 'ok', drawable: true });
  });

  it('decides regardless of connection, length or visibility', () => {
    const s = state({ pvs: [A, B], hidden: { [A]: true } });
    const m = deriveWaveformModel(
      input({
        state: s,
        meta: { [A]: mm, [B]: V },
        rings: { [A]: ring(null, { connected: false }), [B]: ring(4) },
      })
    );
    expect(m.unit).toBe('mm');
    expect(m.live[1].status).toBe('refused');
  });

  it('admits a refused curve when the unit changes', () => {
    const meta = { [A]: mm, [B]: V };
    const rings = { [A]: ring(4), [B]: ring(4) };
    const before = deriveWaveformModel(input({ state: state({ pvs: [A, B] }), meta, rings }));
    expect(before.live[1].status).toBe('refused');
    const after = deriveWaveformModel(input({ state: state({ pvs: [B] }), meta, rings }));
    expect(after.unit).toBe('V');
    expect(after.live[0]).toMatchObject({ pv: B, status: 'ok', drawable: true });
  });

  it('refuses the same curve whatever order the first frames arrive in', () => {
    const s = state({ pvs: [A, B, C] });
    const meta: WaveformMetaMap = { [A]: V, [B]: mm, [C]: V };
    // Frames (and the metadata that rides with them) arrive C, B, A in one run
    // and A, B, C in the other; the last step of each has all three.
    const steps = (order: string[]) => {
      const rings: Record<string, WaveformRingSummary> = {};
      const seen: Record<string, WaveformPvMeta | undefined> = {};
      let last = deriveWaveformModel(input({ state: s }));
      for (const pv of order) {
        rings[pv] = ring(16);
        seen[pv] = meta[pv];
        last = deriveWaveformModel(input({ state: s, meta: { ...seen }, rings: { ...rings } }));
      }
      return last;
    };
    const forward = steps([A, B, C]);
    const reversed = steps([C, B, A]);
    expect(forward.unit).toBe('V');
    expect(reversed.unit).toBe('V');
    const refused = (m: typeof forward) =>
      m.live.filter((r) => r.status === 'refused').map((r) => r.pv);
    expect(refused(forward)).toEqual([B]);
    expect(refused(reversed)).toEqual([B]);
    expect(reversed).toEqual(forward);
  });

  it('draws nothing while undecided and says it is waiting', () => {
    const s = state({ pvs: [A, B] });
    const m = deriveWaveformModel(input({ state: s, meta: { [A]: mm }, rings: { [A]: ring(4) } }));
    expect(m.unitDecided).toBe(false);
    expect(m.live[0]).toMatchObject({ status: 'pending', drawable: false });
    expect(m.canvas).toEqual({ kind: 'waiting', message: CANVAS_WAITING });
  });

  it('refuses a PV reference of another unit', () => {
    const s = state({ pvs: [A], reference: { kind: 'pv', pv: R } });
    const m = deriveWaveformModel(
      input({ state: s, meta: { [A]: mm, [R]: V }, rings: { [A]: ring(4), [R]: ring(4) } })
    );
    expect(m.reference).toMatchObject({ kind: 'pv', pv: R, status: 'refused', drawable: false });
    expect(m.reference?.message).toBe(unitMessage(R, 'V', 'mm'));
  });
});

describe('live row status and chips', () => {
  const meta = { [A]: mm };

  it('reads a missing ring as pending', () => {
    const m = deriveWaveformModel(input({ state: state({ pvs: [A] }), meta }));
    expect(m.live[0]).toMatchObject({ status: 'pending', drawable: false, length: null });
  });

  it('marks a disconnected curve and hides it', () => {
    const m = deriveWaveformModel(
      input({ state: state({ pvs: [A] }), meta, rings: { [A]: ring(null, { connected: false }) } })
    );
    expect(m.live[0]).toMatchObject({ status: 'error', chip: 'disconnected', drawable: false });
  });

  it('reads a connected empty array as an informational "empty"', () => {
    const m = deriveWaveformModel(
      input({ state: state({ pvs: [A] }), meta, rings: { [A]: ring(0) } })
    );
    expect(m.live[0]).toMatchObject({ status: 'ok', chip: 'empty', drawable: false, length: 0 });
  });

  it('reports the length of a drawable curve', () => {
    const m = deriveWaveformModel(
      input({ state: state({ pvs: [A] }), meta, rings: { [A]: ring(128) } })
    );
    expect(m.live[0]).toMatchObject({ status: 'ok', chip: null, drawable: true, length: 128 });
  });

  it('does not draw a hidden curve', () => {
    const m = deriveWaveformModel(
      input({ state: state({ pvs: [A], hidden: { [A]: true } }), meta, rings: { [A]: ring(4) } })
    );
    expect(m.live[0]).toMatchObject({ hidden: true, drawable: false });
  });
});

describe('reference and Δ', () => {
  const meta = { [A]: mm, [B]: mm, [R]: mm };

  it('draws no live curve while Δ waits for a reference frame', () => {
    const s = state({ pvs: [A], reference: { kind: 'pv', pv: R }, delta: true });
    const m = deriveWaveformModel(
      input({ state: s, meta, rings: { [A]: ring(4), [R]: ring(null) } })
    );
    const msg = `Δ needs a reference frame — waiting for ${R}`;
    expect(deltaWaitingMessage(R)).toBe(msg);
    expect(m.live[0].drawable).toBe(false);
    expect(m.reference).toMatchObject({ chip: msg, status: 'pending' });
    expect(m.delta).toEqual({ on: true, waiting: msg });
    expect(m.canvas).toEqual({ kind: 'delta-waiting', message: msg });
  });

  it('subtracts a PV reference of the same length and hides a mismatched curve', () => {
    const s = state({ pvs: [A, B], reference: { kind: 'pv', pv: R }, delta: true });
    const m = deriveWaveformModel(
      input({ state: s, meta, rings: { [A]: ring(8), [B]: ring(6), [R]: ring(8) } })
    );
    expect(m.live[0]).toMatchObject({ drawable: true, status: 'ok' });
    expect(m.live[1]).toMatchObject({
      drawable: false,
      status: 'error',
      chip: 'length mismatch',
      message: '6 elements; reference has 8',
    });
    expect(m.reference?.chip).toBeNull();
    expect(m.delta).toEqual({ on: true, waiting: null });
  });

  it('marks the reference as the odd one out against every live curve', () => {
    const s = state({ pvs: [A, B], reference: { kind: 'pv', pv: R }, delta: true });
    const m = deriveWaveformModel(
      input({ state: s, meta, rings: { [A]: ring(8), [B]: ring(8), [R]: ring(5) } })
    );
    expect(m.reference).toMatchObject({ status: 'error', chip: 'length mismatch', length: 5 });
  });

  it('ignores length in raw mode', () => {
    const s = state({ pvs: [A], reference: { kind: 'pv', pv: R } });
    const m = deriveWaveformModel(input({ state: s, meta, rings: { [A]: ring(8), [R]: ring(5) } }));
    expect(m.live[0].drawable).toBe(true);
    expect(m.reference).toMatchObject({ drawable: true, chip: null });
  });

  it('holds a disconnected PV reference frame with its time', () => {
    const at = new Date(2026, 9, 14, 9, 5, 7).getTime();
    const s = state({ pvs: [A], reference: { kind: 'pv', pv: R }, delta: true });
    const m = deriveWaveformModel(
      input({
        state: s,
        meta,
        rings: { [A]: ring(4), [R]: ring(4, { connected: false, arrival: at }) },
      })
    );
    expect(clockTime(at)).toBe('09:05:07');
    expect(m.reference).toMatchObject({
      status: 'stale',
      chip: 'disconnected, holding frame from 09:05:07',
    });
    expect(m.live[0].drawable).toBe(true);
  });

  it('counts a snapshot entry only when the ring was not reset after the snapshot', () => {
    const time = 5000;
    const s = state({
      pvs: [A, B, C],
      delta: true,
      reference: {
        kind: 'snapshot',
        time,
        frames: { [A]: new Float64Array(4), [B]: new Float64Array(4) },
      },
    });
    const m = deriveWaveformModel(
      input({
        state: s,
        meta: { [A]: mm, [B]: mm, [C]: mm },
        rings: {
          [A]: ring(4, { resetEpoch: time }),
          [B]: ring(4, { resetEpoch: time + 1 }),
          [C]: ring(4, { resetEpoch: 0 }),
        },
      })
    );
    expect(m.live[0]).toMatchObject({ drawable: true, chip: null });
    expect(m.live[1]).toMatchObject({ drawable: false, status: 'stale', chip: NOT_IN_SNAPSHOT });
    expect(m.live[2]).toMatchObject({ drawable: false, status: 'stale', chip: NOT_IN_SNAPSHOT });
    expect(NOT_IN_SNAPSHOT).toBe('not in snapshot — take a new snapshot');
    expect(m.reference).toMatchObject({
      kind: 'snapshot',
      pv: null,
      status: 'ok',
      curves: 2,
      time,
    });
    expect(m.delta.waiting).toBeNull();
  });

  it('draws a curve without a snapshot entry raw when Δ is off', () => {
    const s = state({
      pvs: [A],
      reference: { kind: 'snapshot', time: 10, frames: {} },
    });
    const m = deriveWaveformModel(
      input({ state: s, meta: { [A]: mm }, rings: { [A]: ring(4, { resetEpoch: 20 }) } })
    );
    expect(m.live[0]).toMatchObject({ drawable: true, chip: null });
  });

  it('hides a curve whose snapshot entry has another length in Δ', () => {
    const s = state({
      pvs: [A],
      delta: true,
      reference: { kind: 'snapshot', time: 10, frames: { [A]: new Float64Array(3) } },
    });
    const m = deriveWaveformModel(input({ state: s, meta: { [A]: mm }, rings: { [A]: ring(4) } }));
    expect(m.live[0]).toMatchObject({
      drawable: false,
      chip: 'length mismatch',
      message: '4 elements; snapshot has 3',
    });
  });
});

describe('rolling reference', () => {
  const meta = { [A]: mm, [B]: mm };
  const rollingState = (delta: boolean) =>
    state({ pvs: [A, B], reference: { kind: 'rolling', seconds: 60 }, delta });

  it('reads collecting until some curve’s window holds two frames; Δ never waits for a frame', () => {
    const rings = { [A]: ring(4), [B]: ring(4) };
    const fresh = deriveWaveformModel(
      input({ state: rollingState(true), meta, rings, rolling: { [A]: 1 } })
    );
    expect(fresh.reference).toMatchObject({
      kind: 'rolling',
      status: 'pending',
      chip: ROLLING_COLLECTING,
      seconds: 60,
      spread: true,
      curves: 1,
      drawable: false,
    });
    expect(fresh.live[0]).toMatchObject({ drawable: true, status: 'ok' });
    expect(fresh.live[1]).toMatchObject({
      drawable: false,
      status: 'pending',
      chip: ROLLING_COLLECTING,
    });
    expect(fresh.delta).toEqual({ on: true, waiting: null });
    expect(fresh.canvas).toEqual({ kind: 'ready' });

    const warm = deriveWaveformModel(
      input({ state: rollingState(false), meta, rings, rolling: { [A]: 3, [B]: 2 } })
    );
    expect(warm.reference).toMatchObject({
      kind: 'rolling',
      status: 'ok',
      chip: null,
      curves: 2,
      drawable: true,
    });
    expect(warm.live.every((r) => r.drawable)).toBe(true);
  });

  it('a snapshot frozen from a rolling mean carries its window and a σ', () => {
    const s = state({
      pvs: [A],
      reference: {
        kind: 'snapshot',
        frames: { [A]: new Float64Array(4) },
        spread: { [A]: new Float64Array(4) },
        time: 5,
        rolling: 30,
      },
    });
    const m = deriveWaveformModel(input({ state: s, meta, rings: { [A]: ring(4) } }));
    expect(m.reference).toMatchObject({ kind: 'snapshot', seconds: 30, spread: true, curves: 1 });
    const plain = state({
      pvs: [A],
      reference: { kind: 'snapshot', frames: { [A]: new Float64Array(4) }, time: 5 },
    });
    expect(
      deriveWaveformModel(input({ state: plain, meta, rings: { [A]: ring(4) } })).reference
    ).toMatchObject({ spread: false });
  });
});

describe('X source', () => {
  const meta = { [A]: mm, [B]: mm, [S]: { egu: 'm' } };

  it('is the element index without an X source', () => {
    const m = deriveWaveformModel(
      input({ state: state({ pvs: [A] }), meta, rings: { [A]: ring(4) } })
    );
    expect(m.x).toBeNull();
    expect(m.xAxis).toEqual({ mode: 'index', label: ELEMENT_LABEL, length: null });
  });

  it('is usable when connected, non-empty, numeric and the length of a candidate', () => {
    const s = state({ pvs: [A, B], xs: S });
    const m = deriveWaveformModel(
      input({ state: s, meta, rings: { [A]: ring(8), [B]: ring(6), [S]: ring(8) } })
    );
    expect(m.xAxis).toEqual({ mode: 'source', label: 'm', length: 8 });
    expect(m.x).toMatchObject({ pv: S, status: 'ok', chip: null, usable: true, length: 8 });
    expect(m.live[0].drawable).toBe(true);
    expect(m.live[1]).toMatchObject({
      drawable: false,
      chip: 'length mismatch',
      message: '6 elements; X axis PV has 8',
    });
  });

  it('titles the axis with the X item Label first', () => {
    const s = state({ pvs: [A], xs: S, xLabel: 's-position' });
    const m = deriveWaveformModel(input({ state: s, meta, rings: { [A]: ring(8), [S]: ring(8) } }));
    expect(m.xAxis.label).toBe('s-position');
  });

  it('falls back to "Element" without an EGU', () => {
    const s = state({ pvs: [A], xs: S });
    const m = deriveWaveformModel(
      input({ state: s, meta: { [A]: mm, [S]: none }, rings: { [A]: ring(8), [S]: ring(8) } })
    );
    expect(m.xAxis).toEqual({ mode: 'source', label: ELEMENT_LABEL, length: 8 });
  });

  const unusable: [string, WaveformRingSummary | undefined, string][] = [
    ['disconnected', ring(null, { connected: false }), 'disconnected'],
    ['empty', ring(0), 'empty'],
    ['not numeric', ring(8, { numeric: false }), 'not numeric'],
    ['no data yet', undefined, 'waiting for data'],
    ['of no candidate length', ring(7), 'length 7 matches no curve'],
  ];
  for (const [name, summary, chip] of unusable) {
    it(`puts every curve on index with "Element" when ${name}`, () => {
      const s = state({ pvs: [A, B], xs: S });
      const rings: Record<string, WaveformRingSummary> = { [A]: ring(8), [B]: ring(6) };
      if (summary) rings[S] = summary;
      const m = deriveWaveformModel(input({ state: s, meta, rings }));
      expect(m.xAxis).toEqual({ mode: 'index', label: ELEMENT_LABEL, length: null });
      expect(m.x).toMatchObject({ pv: S, usable: false, chip });
      expect(m.live.every((r) => r.drawable)).toBe(true);
    });
  }

  it('does not count a unit-refused or Δ-mismatched curve as a candidate', () => {
    const s = state({ pvs: [A, B], xs: S, reference: { kind: 'pv', pv: R }, delta: true });
    const m = deriveWaveformModel(
      input({
        state: s,
        meta: { ...meta, [B]: V, [R]: mm },
        rings: { [A]: ring(8), [B]: ring(6), [R]: ring(4), [S]: ring(6) },
      })
    );
    // A mismatches the reference, B is refused: no candidate has length 6.
    expect(m.x).toMatchObject({ usable: false, chip: 'length 6 matches no curve' });
    expect(m.xAxis.mode).toBe('index');
  });

  it('stays on index when the X axis is set to Index', () => {
    const s = state({ pvs: [A, B], xs: S, xAxis: 'index' });
    const m = deriveWaveformModel(
      input({ state: s, meta, rings: { [A]: ring(8), [B]: ring(6), [S]: ring(8) } })
    );
    expect(m.xAxis).toEqual({ mode: 'index', label: ELEMENT_LABEL, length: null });
    expect(m.live.every((r) => r.drawable)).toBe(true);
  });
});

describe('canvas state (message order)', () => {
  const meta = { [A]: mm, [B]: V };

  it('asks for a PV when there is no live PV', () => {
    const m = deriveWaveformModel(input({ state: state() }));
    expect(m.canvas).toEqual({ kind: 'add', message: CANVAS_ADD });
    expect(CANVAS_ADD).toBe('Add a waveform PV');
  });

  it('says no curve can be drawn, with counts, when frames arrived but none is drawable', () => {
    const s = state({ pvs: [A, B], hidden: { [A]: true } });
    const m = deriveWaveformModel(input({ state: s, meta, rings: { [B]: ring(4) } }));
    expect(m.canvas).toEqual({
      kind: 'none-drawable',
      message: CANVAS_NONE_DRAWABLE,
      counts: { live: 2, hidden: 1, refused: 1 },
    });
    expect(CANVAS_NONE_DRAWABLE).toBe('No curve can be drawn — see the Waveforms list');
  });

  it('waits for data when no frame arrived yet', () => {
    const m = deriveWaveformModel(input({ state: state({ pvs: [A] }), meta }));
    expect(m.canvas).toEqual({ kind: 'waiting', message: CANVAS_WAITING });
    expect(CANVAS_WAITING).toBe('waiting for data');
  });

  it('is ready once a curve is drawable', () => {
    const m = deriveWaveformModel(
      input({ state: state({ pvs: [A] }), meta, rings: { [A]: ring(4) } })
    );
    expect(m.canvas).toEqual({ kind: 'ready' });
  });
});

describe('purity', () => {
  it('derives an equal model from equal inputs and holds no frame data', () => {
    const s = state({
      pvs: [A],
      reference: { kind: 'snapshot', time: 1, frames: { [A]: new Float64Array(4) } },
    });
    const i = input({ state: s, meta: { [A]: mm }, rings: { [A]: ring(4) } });
    const m1 = deriveWaveformModel(i);
    const m2 = deriveWaveformModel(i);
    expect(m2).toEqual(m1);
    expect(JSON.parse(JSON.stringify(m1))).toEqual(m1);
  });
});
