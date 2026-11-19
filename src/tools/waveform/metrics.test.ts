// The Waveform statistics payload's reference columns: `r`,
// `s` and `d` per drawn curve, NaN throughout without a reference, so only
// the metrics that use them read "–".
import { describe, expect, it } from 'vitest';
import { evaluateMetrics } from '../../statistics/evaluate';
import { defaultMetrics } from '../../statistics/model';
import { WAVEFORM_METRICS, waveformStatFrame } from './metrics';
import { deriveWaveformModel } from './model';
import { defaultWaveformState, type WaveformState } from './query';

const A = 'WF:A';
const f = (...v: number[]) => Float64Array.from(v);

function frameOf(state: WaveformState, rolling?: { mean: Float64Array; std: Float64Array }) {
  const model = deriveWaveformModel({
    state,
    rings: { [A]: { connected: true, length: 4, resetEpoch: 0, arrival: 1 } },
    meta: {},
    metaTimedOut: true,
    ...(rolling !== undefined ? { rolling: { [A]: 3 } } : {}),
  });
  const frames = {
    live: { [A]: { frame: f(1, 2, 3, 4) } },
    reference: null,
    x: null,
    ...(rolling !== undefined
      ? { rolling: { [A]: { mean: rolling.mean, std: rolling.std, frames: 3, spanMs: 200 } } }
      : {}),
  };
  return waveformStatFrame(state, model, frames)!;
}

const cell = (state: WaveformState, id: string, rolling?: Parameters<typeof frameOf>[1]) => {
  const metrics = defaultMetrics(WAVEFORM_METRICS).map((m) => ({ ...m, on: true }));
  return evaluateMetrics(WAVEFORM_METRICS, frameOf(state, rolling), metrics).rows[0].cells[id]
    .value;
};

describe('waveformStatFrame reference columns', () => {
  it('fills r, s and d with NaN without a reference: y metrics work, deviation metrics read "–"', () => {
    const state = { ...defaultWaveformState(), pvs: [A] };
    const row = frameOf(state).rows[0];
    expect(Array.from(row.columns.y)).toEqual([1, 2, 3, 4]);
    expect(Array.from(row.columns.r).every(Number.isNaN)).toBe(true);
    expect(Array.from(row.columns.d).every(Number.isNaN)).toBe(true);
    expect(cell(state, 'mean')).toBe(2.5);
    expect(cell(state, 'devrms')).toBeNull();
    expect(cell(state, 'devsig')).toBeNull();
  });

  it('a rolling reference gives r, s and d = raw − r whether or not Δ is drawn; y follows Δ', () => {
    const rolling = { mean: f(1, 1, 1, 1), std: f(0.5, 0.5, 0.5, 2) };
    const plain = {
      ...defaultWaveformState(),
      pvs: [A],
      reference: { kind: 'rolling' as const, seconds: 60 },
    };
    const row = frameOf(plain, rolling).rows[0];
    expect(Array.from(row.columns.y)).toEqual([1, 2, 3, 4]);
    expect(Array.from(row.columns.d)).toEqual([0, 1, 2, 3]);
    expect(Array.from(row.columns.s)).toEqual([0.5, 0.5, 0.5, 2]);
    expect(cell(plain, 'devmax', rolling)).toBe(3);
    // |d|/s = 0, 2, 4, 1.5 → max 4 at element 2.
    expect(cell(plain, 'devsig', rolling)).toBe(4);
    expect(cell(plain, 'worst', rolling)).toBe(2);
    const delta = { ...plain, delta: true };
    const deltaRow = frameOf(delta, rolling).rows[0];
    expect(Array.from(deltaRow.columns.y)).toEqual([0, 1, 2, 3]);
    expect(Array.from(deltaRow.columns.d)).toEqual([0, 1, 2, 3]);
  });

  it('a PV reference gives r and d but no σ, over the element range', () => {
    const state = {
      ...defaultWaveformState(),
      pvs: [A],
      reference: { kind: 'pv' as const, pv: 'WF:R' },
      elems: { first: 1, last: 2 },
    };
    const model = deriveWaveformModel({
      state,
      rings: {
        [A]: { connected: true, length: 4, resetEpoch: 0, arrival: 1 },
        'WF:R': { connected: true, length: 4, resetEpoch: 0, arrival: 1 },
      },
      meta: {},
      metaTimedOut: true,
    });
    const frame = waveformStatFrame(state, model, {
      live: { [A]: { frame: f(1, 2, 3, 4) } },
      reference: f(0, 0, 1, 1),
      x: null,
    })!;
    const row = frame.rows[0];
    expect(Array.from(row.columns.r)).toEqual([0, 1]);
    expect(Array.from(row.columns.d)).toEqual([2, 2]);
    expect(Array.from(row.columns.s).every(Number.isNaN)).toBe(true);
  });
});
