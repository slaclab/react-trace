// Completeness: every Waveform setting except a snapshot
// reference (and Δ against it) round-trips — a non-default value is serialized,
// parsed back, and comes out the same. The key check below fails as soon as a
// field is added to WaveformState without a non-default value here, so a new
// setting cannot ship without a place on the wire. Drawings round-trip by
// value; their ids are session identity, regenerated when a link is read.

import { describe, expect, it } from 'vitest';
import type { Annotation } from '../../annotations/model';
import { defaultMetrics } from '../../statistics/model';
import { WAVEFORM_METRICS } from './metrics';
import {
  defaultWaveformState,
  normalizeWaveformState,
  parseWaveformQuery,
  serializeWaveformQuery,
  type WaveformState,
} from './query';

const A = 'SIM:WF:X';
const B = 'SIM:WF:Y';
const R = 'SIM:WF:GOLDEN';
const S = 'SIM:WF:S';

// One drawing of each binding shape: on the axis only, and snapped to a curve,
// placed against the X source under Δ, and locked.
function drawings(): Annotation[] {
  return [
    {
      id: 'annotation-a',
      kind: 'hline',
      points: [{ t: 0, v: 1.5 }],
      axisId: 'y',
      color: '#ff00ff',
      width: 2,
      text: 'floor',
    },
    {
      id: 'annotation-b',
      kind: 'note',
      points: [{ t: 12.5, v: -0.25 }],
      axisId: 'y',
      traceId: A,
      color: '#00ff00',
      width: 1.5,
      text: 'kick here',
      locked: true,
      xRef: `src:${S}`,
      delta: true,
    },
  ];
}

// A state with its drawings' ids dropped (they are not on the wire).
function withoutIds(s: WaveformState): unknown {
  return { ...s, drawings: s.drawings.map(({ id: _id, ...rest }) => (void _id, rest)) };
}

// Every field away from its default.
function everything(): WaveformState {
  return {
    pvs: [A, B],
    reference: { kind: 'pv', pv: R },
    xs: S,
    xLabel: 's position',
    xAxis: 'index',
    delta: true,
    persist: 16,
    avg: 64,
    hz: 2,
    elems: { first: 3, last: 40 },
    dec: 1024,
    drawAs: 'band',
    spread: 2,
    legend: false,
    grid: false,
    crosshair: true,
    tooltip: false,
    drag: 'pan',
    stats: true,
    dist: true,
    metrics: [
      ...defaultMetrics(WAVEFORM_METRICS).map((m) => (m.id === 'mean' ? { ...m, strip: true } : m)),
      { id: 'c1', label: 'noise', expr: 'std(y - mean(y))', unit: 'y', on: true, strip: false },
    ],
    yScale: { auto: false, min: -2.5, max: 7.25, log: true },
    xScale: { auto: false, min: 4, max: 31.5 },
    hidden: { [B]: true, [R]: true },
    styles: {
      [A]: {
        label: 'horizontal',
        color: '#ff8800',
        lineType: 'bars',
        width: 2.5,
        lineStyle: 'dotted',
      },
      [B]: { lineType: 'points' },
      [R]: { label: 'golden', color: '#00aaff', width: 3 },
    },
    drawings: drawings(),
  };
}

describe('Waveform query completeness', () => {
  it('sets every state field away from its default', () => {
    const all = everything();
    const defaults = defaultWaveformState() as unknown as Record<string, unknown>;
    const keys = new Set([...Object.keys(defaults), ...Object.keys(all)]);
    for (const key of keys) {
      expect(
        (all as unknown as Record<string, unknown>)[key],
        `${key} must be non-default in the completeness state`
      ).not.toEqual(defaults[key]);
    }
  });

  it('round-trips every setting', () => {
    const all = normalizeWaveformState(everything());
    expect(all).toEqual(everything());
    expect(withoutIds(parseWaveformQuery(serializeWaveformQuery(all)))).toEqual(withoutIds(all));
  });

  it.each([
    ['an open-ended element range', { elems: { first: 5 } }],
    ['an element range open at the start', { elems: { last: 9 } }],
    ['decimation off', { dec: 0 }],
    ['the X source mode with min only', { xAxis: 'source', yScale: { min: 1 } }],
    ['auto-scale with kept min/max', { yScale: { min: 1, max: 2 } }],
    ['the dashed draw and stats only', { drawAs: 'dashed', stats: true }],
  ] as const)('round-trips %s', (_name, over) => {
    const s = normalizeWaveformState({ ...everything(), ...over } as WaveformState);
    expect(withoutIds(parseWaveformQuery(serializeWaveformQuery(s)))).toEqual(withoutIds(s));
  });

  it('does not round-trip a snapshot or Δ against it', () => {
    const s = normalizeWaveformState({
      ...everything(),
      reference: {
        kind: 'snapshot',
        frames: { [A]: new Float64Array([1, 2, 3]) },
        time: 1_700_000_000_000,
        style: { color: '#ffffff' },
      },
    });
    const back = parseWaveformQuery(serializeWaveformQuery(s));
    expect(back.reference).toBeNull();
    expect(back.delta).toBe(false);
    expect(back.hidden).toEqual({ [B]: true });
    expect(back.styles).toEqual({ [A]: s.styles[A], [B]: s.styles[B] });
    // The Δ drawing is session data with the snapshot; the other one is kept.
    expect(back.drawings.map((a) => a.text)).toEqual(['floor']);
  });
});
