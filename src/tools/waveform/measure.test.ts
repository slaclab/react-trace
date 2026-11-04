// Waveform's measure provider and magnet series: the card is a
// Δx Δy header, then one row per visible live curve over only the elements
// whose plotted x lies in the measured span — at the element index, or at the
// X source's values when the chart plots the source — taken after Δ when Δ
// is on, within the element range.
import { describe, expect, it } from 'vitest';
import type { Annotation } from '../../annotations/model';
import { VALUE_X_AXIS } from '../../annotations/catalog/xAxis';
import { WAVEFORM_AXIS_ID } from './drawings';
import {
  createWaveformMeasure,
  waveformMeasureLines,
  waveformMeasureRows,
  waveformSnapSeries,
  type WaveformDrawingData,
} from './measure';
import { deriveWaveformModel, type WaveformModel, type WaveformRingSummary } from './model';
import { defaultWaveformState, type WaveformState } from './query';
import type { WaveformPlotFrames } from './plotOption';

const A = 'WF:A';
const B = 'WF:B';

function ring(length: number): WaveformRingSummary {
  return { connected: true, length, resetEpoch: 0, arrival: 1 };
}

function stateWith(patch: Partial<WaveformState>): WaveformState {
  return { ...defaultWaveformState(), pvs: [A, B], ...patch };
}

function modelOf(state: WaveformState, patch: Partial<WaveformModel> = {}): WaveformModel {
  const rings: Record<string, WaveformRingSummary> = {};
  const meta: Record<string, { egu: string }> = {};
  for (const pv of state.pvs) {
    rings[pv] = ring(10);
    meta[pv] = { egu: 'mm' };
  }
  return { ...deriveWaveformModel({ state, rings, meta, metaTimedOut: false }), ...patch };
}

/** A = 0, 10, 20, …, 90; B = 1 everywhere. */
function framesOf(x: Float64Array | null = null): WaveformPlotFrames {
  return {
    live: {
      [A]: { frame: Float64Array.from({ length: 10 }, (_, i) => i * 10) },
      [B]: { frame: new Float64Array(10).fill(1) },
    },
    reference: null,
    x,
  };
}

function measure(t0: number, t1: number, v0 = 0, v1 = 5): Annotation {
  return {
    id: 'm1',
    kind: 'measure',
    points: [
      { t: t0, v: v0 },
      { t: t1, v: v1 },
    ],
    axisId: WAVEFORM_AXIS_ID,
    color: '#000000',
    width: 1.5,
    text: '',
  };
}

function data(state: WaveformState, model = modelOf(state), frames = framesOf()) {
  return { state, model, frames } satisfies WaveformDrawingData;
}

describe('waveformMeasureRows', () => {
  it('covers only the elements inside the measured span', () => {
    const s = stateWith({});
    const rows = waveformMeasureRows(measure(2, 4), data(s));
    expect(rows.map((r) => r.pv)).toEqual([A, B]);
    expect(rows[0]).toMatchObject({ n: 3, mean: 30 });
    expect(rows[0].std).toBeCloseTo(10);
    expect(rows[1]).toMatchObject({ n: 3, mean: 1, std: 0 });
  });

  it('reads the span in either drawing direction', () => {
    const s = stateWith({});
    expect(waveformMeasureRows(measure(4, 2), data(s))[0]).toMatchObject({ n: 3, mean: 30 });
  });

  it('skips a hidden curve', () => {
    const s = stateWith({ hidden: { [B]: true } });
    expect(waveformMeasureRows(measure(0, 9), data(s)).map((r) => r.pv)).toEqual([A]);
  });

  it('stays inside the element range', () => {
    const s = stateWith({ elems: { first: 3, last: 5 } });
    expect(waveformMeasureRows(measure(0, 9), data(s))[0]).toMatchObject({ n: 3, mean: 40 });
  });

  it('takes the rows after Δ when Δ is on', () => {
    const snap = Float64Array.from({ length: 10 }, (_, i) => i * 10 - 1);
    const s = stateWith({
      pvs: [A],
      reference: { kind: 'snapshot', frames: { [A]: snap }, time: 1 },
      delta: true,
    });
    const m = modelOf(s, { delta: { on: true, waiting: null } });
    const rows = waveformMeasureRows(measure(0, 9), data(s, m));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ n: 10, mean: 1, std: 0 });
  });

  it('places elements at the X source values when the chart plots the source', () => {
    const s = stateWith({});
    const m = modelOf(s, {
      xAxis: { mode: 'source', label: 'mm', length: 10 },
      x: { pv: 'WF:X', status: 'ok', chip: null, length: 10, egu: 'mm', usable: true },
    } as Partial<WaveformModel>);
    // Element i sits at x = 100 + i.
    const xs = Float64Array.from({ length: 10 }, (_, i) => 100 + i);
    const rows = waveformMeasureRows(measure(101, 102), data(s, m, framesOf(xs)));
    expect(rows[0]).toMatchObject({ n: 2, mean: 15 });
    // In index coordinates the same span holds nothing.
    expect(waveformMeasureRows(measure(101, 102), data(s))[0].n).toBe(0);
  });

  it('ignores non-finite elements', () => {
    const s = stateWith({ pvs: [A] });
    const f = framesOf();
    f.live[A]!.frame[3] = NaN;
    expect(waveformMeasureRows(measure(2, 4), data(s, modelOf(s), f))[0]).toMatchObject({
      n: 2,
      mean: 30,
    });
  });
});

describe('waveformMeasureLines', () => {
  it('is a Δx Δy header, then one row per visible live curve, named when there are several', () => {
    const s = stateWith({ styles: { [A]: { label: 'Alpha' } } });
    const lines = waveformMeasureLines(measure(2, 4, 1, 4), data(s), { unit: 'mm' });
    expect(lines[0]).toBe('Δx = 2\u2003Δy = 3 mm');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('Alpha:\u2003n = 3\u2003x̄ = 30 mm\u2003σ = 10 mm');
    expect(lines[2]).toBe(`${B}:\u2003n = 3\u2003x̄ = 1 mm\u2003σ = 0 mm`);
  });

  it('dashes the statistics of a span with no elements; one curve goes unnamed', () => {
    const s = stateWith({ pvs: [A] });
    const lines = waveformMeasureLines(measure(2.2, 2.4), data(s));
    expect(lines[1]).toBe('n = 0\u2003x̄ = —\u2003σ = —');
  });
});

describe('createWaveformMeasure', () => {
  it('reads the latest data through the getter on every call', () => {
    const s = stateWith({ pvs: [A] });
    let current = data(s);
    const provider = createWaveformMeasure(() => current);
    const ctx = { xAxis: VALUE_X_AXIS, axis: { id: WAVEFORM_AXIS_ID, name: 'y', units: 'mm' } };
    expect(provider.card(measure(2, 4), ctx)[1]).toBe('n = 3\u2003x̄ = 30 mm\u2003σ = 10 mm');
    const next: WaveformPlotFrames = {
      ...framesOf(),
      live: { [A]: { frame: new Float64Array(10).fill(7) } },
    };
    current = data(s, modelOf(s), next);
    expect(provider.card(measure(2, 4), ctx)[1]).toBe('n = 3\u2003x̄ = 7 mm\u2003σ = 0 mm');
  });
});

describe('waveformSnapSeries', () => {
  it('is one series per drawn curve on the y axis, over the element range, NaN as gaps', () => {
    const s = stateWith({ elems: { first: 1, last: 3 } });
    const f = framesOf();
    f.live[A]!.frame[2] = NaN;
    const series = waveformSnapSeries(data(s, modelOf(s), f));
    expect(series.map((x) => [x.id, x.axisId])).toEqual([
      [A, WAVEFORM_AXIS_ID],
      [B, WAVEFORM_AXIS_ID],
    ]);
    expect(series[0].points).toEqual([
      [1, 10],
      [2, null],
      [3, 30],
    ]);
  });
});
