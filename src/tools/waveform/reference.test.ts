import { describe, expect, it } from 'vitest';
import { defaultWaveformState, type WaveformState } from './query';
import { referenceFor, referenceSuffix } from './reference';

const A = 'WF:A';
const f = (...v: number[]) => Float64Array.from(v);
const state = (patch: Partial<WaveformState>): WaveformState => ({
  ...defaultWaveformState(),
  pvs: [A],
  ...patch,
});

describe('referenceFor', () => {
  it('is null without a reference or before it has a frame', () => {
    expect(referenceFor(state({}), { reference: f(1) }, A)).toBeNull();
    const pv = state({ reference: { kind: 'pv', pv: 'WF:R' } });
    expect(referenceFor(pv, { reference: null }, A)).toBeNull();
    const rolling = state({ reference: { kind: 'rolling', seconds: 60 } });
    expect(referenceFor(rolling, { reference: null }, A)).toBeNull();
    expect(referenceFor(rolling, { reference: null, rolling: {} }, A)).toBeNull();
  });

  it('a PV reference is one frame for every curve, without a spread', () => {
    const s = state({ reference: { kind: 'pv', pv: 'WF:R' } });
    expect(referenceFor(s, { reference: f(1, 2) }, A)).toEqual({ values: f(1, 2), spread: null });
  });

  it('a snapshot gives the curve its own entry and its σ when frozen from a rolling mean', () => {
    const plain = state({ reference: { kind: 'snapshot', frames: { [A]: f(1) }, time: 0 } });
    expect(referenceFor(plain, { reference: null }, A)).toEqual({ values: f(1), spread: null });
    expect(referenceFor(plain, { reference: null }, 'WF:B')).toBeNull();
    const frozen = state({
      reference: {
        kind: 'snapshot',
        frames: { [A]: f(1) },
        spread: { [A]: f(0.1) },
        time: 0,
        rolling: 60,
      },
    });
    expect(referenceFor(frozen, { reference: null }, A)).toEqual({ values: f(1), spread: f(0.1) });
    expect(referenceSuffix(frozen)).toBe('(snapshot of rolling 60 s)');
    expect(referenceSuffix(plain)).toBe('(snapshot)');
  });

  it('a rolling reference reads the published window statistics', () => {
    const s = state({ reference: { kind: 'rolling', seconds: 30 } });
    const rolling = { [A]: { mean: f(2), std: f(0.5), frames: 3, spanMs: 200 } };
    expect(referenceFor(s, { reference: null, rolling }, A)).toEqual({
      values: f(2),
      spread: f(0.5),
    });
    expect(referenceSuffix(s)).toBe('(rolling 30 s)');
  });
});
