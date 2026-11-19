import { describe, expect, it } from 'vitest';
import { drawingThemeFor } from '../../annotationTheme';
import { codeFragment } from '../codeFragment';
import { deriveWaveformModel, type WaveformRingSummary } from './model';
import { defaultWaveformState, type WaveformState } from './query';
import {
  REF_ID,
  SAMPLING_FACTOR,
  WaveformPlotBuffers,
  bandId,
  decimateInto,
  liveId,
  refId,
  selectToolFragment,
  toolCodeFragment,
  trailId,
  heldId,
  waveformPlotOption,
  type WaveformPlotFrames,
  type WaveformPlotInput,
} from './plotOption';
import { autoYColor } from '../shared/colors';

const A = 'WF:A';
const B = 'WF:B';
const R = 'WF:REF';
const XS = 'WF:S';

interface SeriesLike {
  id?: string;
  type?: string;
  name?: string;
  color?: string;
  step?: string | false;
  large?: boolean;
  largeThreshold?: number;
  barGap?: string;
  sampling?: string;
  connectNulls?: boolean;
  encode?: { x?: string; y?: string };
  datasetIndex?: number;
  lineStyle?: { type?: string | number[]; width?: number; opacity?: number };
  areaStyle?: { opacity?: number };
  itemStyle?: { opacity?: number };
}

interface DatasetLike {
  dimensions: string[];
  source: Record<string, Float64Array>;
}

function ramp(n: number, scale = 1, offset = 0): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = offset + i * scale;
  return out;
}

function ring(
  length: number | null,
  extra: Partial<WaveformRingSummary> = {}
): WaveformRingSummary {
  return { connected: true, length, resetEpoch: 0, arrival: length === null ? null : 1, ...extra };
}

function state(patch: Partial<WaveformState> = {}): WaveformState {
  return { ...defaultWaveformState(), pvs: [A], ...patch };
}

interface Build {
  state?: Partial<WaveformState>;
  frames?: Partial<WaveformPlotFrames>;
  widthPx?: number;
  buffers?: WaveformPlotBuffers;
  rings?: Record<string, WaveformRingSummary>;
}

function input(b: Build = {}): WaveformPlotInput {
  const s = state(b.state);
  const live = b.frames?.live ?? { [A]: { frame: ramp(8) } };
  const rings: Record<string, WaveformRingSummary> = {};
  for (const pv of s.pvs) rings[pv] = ring(live[pv]?.frame.length ?? null);
  if (s.reference?.kind === 'pv') rings[s.reference.pv] = ring(b.frames?.reference?.length ?? null);
  if (s.xs !== '') rings[s.xs] = ring(b.frames?.x?.length ?? null);
  Object.assign(rings, b.rings);
  const rolling = b.frames?.rolling;
  const counts =
    rolling === undefined
      ? undefined
      : Object.fromEntries(Object.entries(rolling).map(([pv, r]) => [pv, r?.frames ?? 0]));
  const model = deriveWaveformModel({
    state: s,
    rings,
    meta: {},
    metaTimedOut: true,
    ...(counts !== undefined ? { rolling: counts } : {}),
  });
  return {
    state: s,
    model,
    frames: {
      live,
      reference: b.frames?.reference ?? null,
      x: b.frames?.x ?? null,
      ...(rolling !== undefined ? { rolling } : {}),
      ...(b.frames?.held !== undefined ? { held: b.frames.held } : {}),
    },
    widthPx: b.widthPx ?? 2000,
    theme: drawingThemeFor('dark'),
    ...(b.buffers ? { buffers: b.buffers } : {}),
  };
}

function series(b: Build = {}): SeriesLike[] {
  return waveformPlotOption(input(b)).series as SeriesLike[];
}

function dataset(b: Build = {}): DatasetLike {
  const raw = waveformPlotOption(input(b)).dataset;
  return (Array.isArray(raw) ? raw[0] : raw) as unknown as DatasetLike;
}

function column(b: Build, id: string): Float64Array {
  return dataset(b).source[id];
}

describe('a frozen shot (Freeze this shot)', () => {
  it('draws dotted in the curve’s colour, under the live curve, never in the legend', () => {
    const held = ramp(8, 2);
    const b: Build = { frames: { live: { [A]: { frame: ramp(8) } }, held: { [A]: held } } };
    const all = series(b);
    expect(all.map((s) => s.id)).toEqual([heldId(A), liveId(A)]);
    const frozen = all[0];
    expect(frozen.lineStyle?.type).toBe('dotted');
    expect(frozen.color).toBe(all[1].color);
    expect(column(b, heldId(A))).toBe(held);
    const legend = waveformPlotOption(input(b)).legend as { data: string[] };
    expect(legend.data).toEqual([A]);
  });
});

describe('series ids (stable: pv, trail index, ref)', () => {
  it('ids a live curve by PV, its trails by age and a PV reference as ref', () => {
    const t1 = ramp(8, 1, 1);
    const t2 = ramp(8, 1, 2);
    const ids = series({
      state: { pvs: [A], persist: 3, reference: { kind: 'pv', pv: R } },
      frames: { live: { [A]: { frame: ramp(8), trails: [t2, t1] } }, reference: ramp(8) },
    }).map((s) => s.id);
    expect(ids).toEqual([REF_ID, trailId(A, 2), trailId(A, 1), liveId(A)]);
  });

  it('ids each snapshot entry by its curve', () => {
    const ids = series({
      state: {
        pvs: [A, B],
        reference: { kind: 'snapshot', frames: { [A]: ramp(8), [B]: ramp(8) }, time: 5 },
      },
      frames: { live: { [A]: { frame: ramp(8) }, [B]: { frame: ramp(8) } } },
    }).map((s) => s.id);
    expect(ids).toEqual([refId(A), refId(B), liveId(A), liveId(B)]);
  });

  it('the id set is the same publish after publish', () => {
    const b: Build = {
      state: { pvs: [A, B] },
      frames: { live: { [A]: { frame: ramp(8) }, [B]: { frame: ramp(8) } } },
    };
    expect(series(b).map((s) => s.id)).toEqual(series(b).map((s) => s.id));
  });
});

describe('data: one dataset of columns, no per-point tuples', () => {
  it('holds a shared x column and one Float64Array per series, encoded by id', () => {
    const ds = dataset({
      state: { pvs: [A, B] },
      frames: { live: { [A]: { frame: ramp(8) }, [B]: { frame: ramp(8) } } },
    });
    expect(ds.dimensions).toEqual(['x', liveId(A), liveId(B)]);
    for (const col of Object.values(ds.source)) expect(col).toBeInstanceOf(Float64Array);
    const s = series({
      state: { pvs: [A, B] },
      frames: { live: { [A]: { frame: ramp(8) }, [B]: { frame: ramp(8) } } },
    });
    for (const one of s) {
      expect(one.encode).toEqual({ x: 'x', y: one.id });
      expect((one as { data?: unknown }).data).toBeUndefined();
    }
  });

  it('passes the live frame and the trails by identity (the ring arrays)', () => {
    const frame = ramp(8);
    const t1 = ramp(8, 2);
    const b: Build = { state: { persist: 2 }, frames: { live: { [A]: { frame, trails: [t1] } } } };
    expect(column(b, liveId(A))).toBe(frame);
    expect(column(b, trailId(A, 1))).toBe(t1);
  });

  it('draws at most persist − 1 trails, the newest ones', () => {
    const trails = [ramp(8, 1), ramp(8, 2), ramp(8, 3)];
    const b: Build = {
      state: { persist: 3 },
      frames: { live: { [A]: { frame: ramp(8), trails } } },
    };
    expect(column(b, trailId(A, 1))).toBe(trails[2]);
    expect(column(b, trailId(A, 2))).toBe(trails[1]);
    expect(dataset(b).source[trailId(A, 3)]).toBeUndefined();
  });

  it('draws no trails at persistence 1', () => {
    const ids = series({
      state: { persist: 1 },
      frames: { live: { [A]: { frame: ramp(8), trails: [ramp(8)] } } },
    }).map((s) => s.id);
    expect(ids).toEqual([liveId(A)]);
  });

  it('fades older trails', () => {
    const s = series({
      state: { persist: 3 },
      frames: { live: { [A]: { frame: ramp(8), trails: [ramp(8), ramp(8)] } } },
    });
    const op = (id: string) => s.find((x) => x.id === id)!.lineStyle!.opacity!;
    expect(op(trailId(A, 2))).toBeLessThan(op(trailId(A, 1)));
    expect(op(trailId(A, 1))).toBeLessThan(1);
  });

  it('the index x column is the element numbers', () => {
    expect(Array.from(column({}, 'x'))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('NaN passes through; lines break', () => {
  it('keeps a NaN element and never connects nulls', () => {
    const frame = ramp(8);
    frame[3] = NaN;
    const b: Build = { frames: { live: { [A]: { frame } } } };
    expect(Number.isNaN(column(b, liveId(A))[3])).toBe(true);
    for (const s of series(b)) expect(s.connectNulls).not.toBe(true);
  });
});

describe('minmax sampling', () => {
  const n = 5000;
  it('is on when the array is ≥ 2.5× the device-pixel width and has no NaN', () => {
    const b: Build = {
      state: { dec: 0 },
      frames: { live: { [A]: { frame: ramp(n) } } },
      widthPx: Math.floor(n / SAMPLING_FACTOR),
    };
    expect(SAMPLING_FACTOR).toBe(2.5);
    expect(series(b)[0].sampling).toBe('minmax');
  });

  it('is off when the array is shorter than 2.5× the width', () => {
    const b: Build = {
      state: { dec: 0 },
      frames: { live: { [A]: { frame: ramp(n) } } },
      widthPx: n / SAMPLING_FACTOR + 1,
    };
    expect(series(b)[0].sampling).toBeUndefined();
  });

  it('is off when the frame has a dead element, so the gap shows', () => {
    const frame = ramp(n);
    frame[100] = NaN;
    const b: Build = { state: { dec: 0 }, frames: { live: { [A]: { frame } } }, widthPx: 100 };
    expect(series(b)[0].sampling).toBeUndefined();
  });
});

describe('axes', () => {
  it('Live-axis scale: automatic by default', () => {
    const y = waveformPlotOption(input()).yAxis as {
      type: string;
      min?: number;
      max?: number;
      scale: boolean;
    };
    expect(y.type).toBe('value');
    expect(y.min).toBeUndefined();
    expect(y.max).toBeUndefined();
    expect(y.scale).toBe(true);
  });

  it('Live-axis scale: min/max when auto is off, log when set', () => {
    const y = waveformPlotOption(
      input({ state: { yScale: { auto: false, min: -2, max: 5, log: true } } })
    ).yAxis as {
      type: string;
      min?: number;
      max?: number;
    };
    expect(y).toMatchObject({ type: 'log', min: -2, max: 5 });
  });

  it('Live-axis scale: min/max ignored while auto', () => {
    const y = waveformPlotOption(input({ state: { yScale: { min: -2, max: 5 } } })).yAxis as {
      min?: number;
    };
    expect(y.min).toBeUndefined();
  });

  it('X axis from a usable X source uses its column and title', () => {
    const xs = ramp(8, 0.5, 10);
    const b: Build = { state: { xs: XS, xLabel: 's' }, frames: { x: xs } };
    expect(column(b, 'x')).toBe(xs);
    expect((waveformPlotOption(input(b)).xAxis as { name: string }).name).toBe('s');
  });

  it('X axis on index when the mode is index, even with an X source', () => {
    const b: Build = { state: { xs: XS, xAxis: 'index' }, frames: { x: ramp(8, 0.5, 10) } };
    expect(Array.from(column(b, 'x'))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect((waveformPlotOption(input(b)).xAxis as { name: string }).name).toBe('Element');
  });

  it('legend, grid and crosshair follow the Appearance toggles', () => {
    const o = waveformPlotOption(input({ state: { legend: false, grid: false, crosshair: true } }));
    expect((o.legend as { show: boolean }).show).toBe(false);
    expect((o.yAxis as { splitLine: { show: boolean } }).splitLine.show).toBe(false);
    expect((o.xAxis as { axisPointer: { show: boolean } }).axisPointer.show).toBe(true);
  });

  it('the tooltip works without the crosshair, and hides on its own toggle', () => {
    type Pointer = { axisPointer: { show: boolean; type: string } };
    const on = waveformPlotOption(input({ state: { crosshair: false, tooltip: true } }));
    expect((on.xAxis as Pointer).axisPointer).toMatchObject({ show: true, type: 'none' });
    expect((on.tooltip as { showContent: boolean }).showContent).toBe(true);
    const off = waveformPlotOption(input({ state: { crosshair: true, tooltip: false } }));
    expect((off.xAxis as Pointer).axisPointer).toMatchObject({ show: true, type: 'line' });
    expect((off.tooltip as { showContent: boolean }).showContent).toBe(false);
  });
});

describe('element range and decimation', () => {
  it('the element range applies to every series and the x column', () => {
    const frame = ramp(10);
    const xs = ramp(10, 1, 100);
    const t1 = ramp(10, 2);
    const b: Build = {
      state: { xs: XS, persist: 2, elems: { first: 2, last: 5 } },
      frames: { live: { [A]: { frame, trails: [t1] } }, x: xs },
    };
    expect(Array.from(column(b, 'x'))).toEqual([102, 103, 104, 105]);
    expect(Array.from(column(b, liveId(A)))).toEqual([2, 3, 4, 5]);
    expect(Array.from(column(b, trailId(A, 1)))).toEqual([4, 6, 8, 10]);
    // a view on the ring's storage, never a copy
    expect(column(b, liveId(A)).buffer).toBe(frame.buffer);
  });

  it('the index column starts at the first element of the range', () => {
    expect(Array.from(column({ state: { elems: { first: 6 } } }, 'x'))).toEqual([6, 7]);
  });

  it('decimation caps drawn points after the range', () => {
    const n = 10_000;
    const b: Build = {
      state: { dec: 256, elems: { first: 1000 } },
      frames: { live: { [A]: { frame: ramp(n) } } },
    };
    const y = column(b, liveId(A));
    const x = column(b, 'x');
    expect(y.length).toBeLessThanOrEqual(256);
    expect(x.length).toBe(y.length);
    expect(x[0]).toBe(1000);
    expect(y[0]).toBe(1000);
    expect(x[x.length - 1]).toBe(n - 1);
    expect(y[y.length - 1]).toBe(n - 1);
  });

  it('decimation keeps the extremes and a dead element as a gap', () => {
    const frame = ramp(1000, 0);
    frame[500] = 99;
    frame[700] = NaN;
    const y = column({ state: { dec: 256 }, frames: { live: { [A]: { frame } } } }, liveId(A));
    expect(Math.max(...Array.from(y).filter(Number.isFinite))).toBe(99);
    expect(Array.from(y).some(Number.isNaN)).toBe(true);
  });

  it('decimation off (0) or under the cap draws every element', () => {
    const frame = ramp(5000);
    expect(column({ state: { dec: 0 }, frames: { live: { [A]: { frame } } } }, liveId(A))).toBe(
      frame
    );
    expect(column({ state: { dec: 5000 }, frames: { live: { [A]: { frame } } } }, liveId(A))).toBe(
      frame
    );
  });

  it('decimateInto writes bucket extremes in element order', () => {
    const src = new Float64Array([0, 5, 1, 1, -3, 2, 0, 0]);
    const xs = new Float64Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const outY = new Float64Array(4);
    const outX = new Float64Array(4);
    decimateInto(src, xs, 2, outY, outX);
    expect(Array.from(outY)).toEqual([0, 5, -3, 2]);
    expect(Array.from(outX)).toEqual([0, 3, 4, 7]);
  });
});

describe('line types and bars', () => {
  it('maps line, step and points', () => {
    const s = series({
      state: { pvs: [A, B, R], styles: { [B]: { lineType: 'step' }, [R]: { lineType: 'points' } } },
      frames: {
        live: { [A]: { frame: ramp(8) }, [B]: { frame: ramp(8) }, [R]: { frame: ramp(8) } },
      },
    });
    expect(s[0]).toMatchObject({ type: 'line' });
    expect(s[0].step).toBeFalsy();
    expect(s[1]).toMatchObject({ type: 'line', step: 'middle' });
    expect(s[2]).toMatchObject({ type: 'scatter' });
  });

  it('draws each dash with Trace’s pattern for the same wire value', () => {
    const styles = {
      [A]: { lineStyle: 'dotted' as const },
      [B]: { lineStyle: 'dashDot' as const },
      [R]: { lineStyle: 'dashDotDot' as const },
    };
    const s = series({
      state: { pvs: [A, B, R, XS], styles },
      frames: {
        live: {
          [A]: { frame: ramp(8) },
          [B]: { frame: ramp(8) },
          [R]: { frame: ramp(8) },
          [XS]: { frame: ramp(8) },
        },
      },
    });
    expect(s.map((x) => x.lineStyle?.type)).toEqual([
      'dotted',
      [10, 4, 2, 4],
      [10, 4, 2, 4, 2, 4],
      'solid',
    ]);
  });

  it('bars overlay in one column per element, in large mode, with no trails', () => {
    const s = series({
      state: {
        pvs: [A, B],
        persist: 4,
        styles: { [A]: { lineType: 'bars' }, [B]: { lineType: 'bars' } },
      },
      frames: {
        live: {
          [A]: { frame: ramp(8), trails: [ramp(8), ramp(8)] },
          [B]: { frame: ramp(8), trails: [ramp(8)] },
        },
      },
    });
    expect(s.map((x) => x.id)).toEqual([liveId(A), liveId(B)]);
    for (const bar of s) expect(bar).toMatchObject({ type: 'bar', large: true, barGap: '-100%' });
  });

  it('colours: pinned style, else the automatic colour by position', () => {
    const s = series({
      state: { pvs: [A, B], styles: { [B]: { color: '#123456' } } },
      frames: { live: { [A]: { frame: ramp(8) }, [B]: { frame: ramp(8) } } },
    });
    expect(s[0].color).toBe(autoYColor(0));
    expect(s[1].color).toBe('#123456');
  });

  it('hidden curves are not drawn', () => {
    const ids = series({
      state: { pvs: [A, B], hidden: { [B]: true } },
      frames: { live: { [A]: { frame: ramp(8) }, [B]: { frame: ramp(8) } } },
    }).map((s) => s.id);
    expect(ids).toEqual([liveId(A)]);
  });
});

describe('reference', () => {
  it('draws dashed by default', () => {
    const s = series({
      state: { reference: { kind: 'pv', pv: R } },
      frames: { reference: ramp(8) },
    });
    expect(s[0]).toMatchObject({ id: REF_ID, type: 'line' });
    expect(s[0].lineStyle!.type).toBe('dashed');
    expect(s[0].areaStyle).toBeUndefined();
  });

  it('draws as a band', () => {
    const s = series({
      state: { reference: { kind: 'pv', pv: R }, drawAs: 'band' },
      frames: { reference: ramp(8) },
    });
    expect(s[0].areaStyle).toBeDefined();
  });

  it('Δ subtracts the reference and does not draw it', () => {
    const b: Build = {
      state: { reference: { kind: 'pv', pv: R }, delta: true },
      frames: { live: { [A]: { frame: ramp(8, 2) } }, reference: ramp(8) },
    };
    expect(series(b).map((s) => s.id)).toEqual([liveId(A)]);
    expect(Array.from(column(b, liveId(A)))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('Δ against a snapshot subtracts each curve’s own entry, re-using buffers', () => {
    const frame = ramp(8, 3);
    const buffers = new WaveformPlotBuffers();
    const b: Build = {
      state: { reference: { kind: 'snapshot', frames: { [A]: frame }, time: 5 }, delta: true },
      frames: { live: { [A]: { frame } } },
      buffers,
    };
    const first = column(b, liveId(A));
    expect(Array.from(first)).toEqual(new Array(8).fill(0));
    expect(column(b, liveId(A))).toBe(first);
  });

  it('Δ keeps NaN where either side is NaN', () => {
    const ref = ramp(8);
    ref[2] = NaN;
    const b: Build = {
      state: { reference: { kind: 'pv', pv: R }, delta: true },
      frames: { live: { [A]: { frame: ramp(8) } }, reference: ref },
    };
    expect(Number.isNaN(column(b, liveId(A))[2])).toBe(true);
  });
});

describe('rolling reference and the spread band', () => {
  const mean = ramp(8, 1, 10);
  const std = Float64Array.from({ length: 8 }, () => 0.5);
  const rollingFrames = { [A]: { mean, std, frames: 5, spanMs: 4000 } };
  const rollingRef = { kind: 'rolling' as const, seconds: 60 };

  it('draws each curve’s rolling mean dashed, named "(rolling 60 s)", with its ±1σ band stacked behind', () => {
    const b: Build = {
      state: { reference: rollingRef },
      frames: { live: { [A]: { frame: ramp(8, 1, 10.2) } }, rolling: rollingFrames },
    };
    const s = series(b);
    expect(s.map((x) => x.id)).toEqual([refId(A), bandId(A, 'lo'), bandId(A, 'hi'), liveId(A)]);
    expect(s[0]).toMatchObject({ name: `${A} (rolling 60 s)`, color: autoYColor(0) });
    expect(s[0].lineStyle!.type).toBe('dashed');
    expect(s[1]).toMatchObject({ type: 'line', stack: `band:${A}`, silent: true });
    expect(s[1].areaStyle).toBeUndefined();
    expect(s[2].areaStyle).toBeDefined();
    expect(Array.from(column(b, bandId(A, 'lo')))).toEqual(Array.from(mean, (m) => m - 0.5));
    expect(Array.from(column(b, bandId(A, 'hi')))).toEqual(new Array(8).fill(1));
    const option = waveformPlotOption(input(b));
    expect((option.legend as { data: string[] }).data).toEqual([`${A} (rolling 60 s)`, A]);
  });

  it('in Δ the band sits around zero, scaled by Spread band; none at 0', () => {
    const b: Build = {
      state: { reference: rollingRef, delta: true, spread: 2 },
      frames: { live: { [A]: { frame: ramp(8, 1, 10.2) } }, rolling: rollingFrames },
    };
    expect(series(b).map((x) => x.id)).toEqual([bandId(A, 'lo'), bandId(A, 'hi'), liveId(A)]);
    expect(Array.from(column(b, bandId(A, 'lo')))).toEqual(new Array(8).fill(-1));
    expect(Array.from(column(b, bandId(A, 'hi')))).toEqual(new Array(8).fill(2));
    expect(column(b, liveId(A))[0]).toBeCloseTo(0.2, 12);
    const off: Build = { ...b, state: { ...b.state, spread: 0 } };
    expect(series(off).map((x) => x.id)).toEqual([liveId(A)]);
  });

  it('under decimation the band top is the decimated upper edge; no band on a log axis', () => {
    const n = 5000;
    const live = ramp(n, 0.001, 10);
    const sigma = Float64Array.from({ length: n }, (_, i) => 0.1 + 0.05 * Math.sin(i / 7));
    const b: Build = {
      state: { reference: rollingRef, dec: 256 },
      frames: {
        live: { [A]: { frame: live } },
        rolling: { [A]: { mean: live, std: sigma, frames: 5, spanMs: 1 } },
      },
    };
    const lo = column(b, bandId(A, 'lo'));
    const hi = column(b, bandId(A, 'hi'));
    expect(lo.length).toBe(256);
    const upper = new Float64Array(256);
    const x = ramp(n);
    decimateInto(
      Float64Array.from(live, (v, i) => v + sigma[i]),
      x,
      128,
      upper,
      null
    );
    for (let i = 0; i < 256; i++) {
      expect(hi[i]).toBeGreaterThanOrEqual(0);
      expect(lo[i] + hi[i]).toBeCloseTo(upper[i], 9);
    }
    const log: Build = { ...b, state: { ...b.state, yScale: { log: true } } };
    expect(series(log).map((s) => s.id)).toEqual([refId(A), liveId(A)]);
  });

  it('a curve without a window yet draws neither a reference nor a band; a snapshot frozen from one keeps its band', () => {
    const empty: Build = {
      state: { reference: rollingRef },
      frames: { live: { [A]: { frame: ramp(8) } }, rolling: {} },
    };
    expect(series(empty).map((x) => x.id)).toEqual([liveId(A)]);
    const frozen: Build = {
      state: {
        reference: {
          kind: 'snapshot',
          frames: { [A]: mean },
          spread: { [A]: std },
          time: 1,
          rolling: 60,
        },
      },
      frames: { live: { [A]: { frame: ramp(8) } } },
    };
    const s = series(frozen);
    expect(s.map((x) => x.id)).toEqual([refId(A), bandId(A, 'lo'), bandId(A, 'hi'), liveId(A)]);
    expect(s[0].name).toBe(`${A} (snapshot of rolling 60 s)`);
  });
});

describe('chart source', () => {
  const b: Build = {
    state: { pvs: [A, B], persist: 2, reference: { kind: 'pv', pv: R }, xs: XS },
    frames: {
      live: { [A]: { frame: ramp(8), trails: [ramp(8)] }, [B]: { frame: ramp(8) } },
      reference: ramp(8),
      x: ramp(8),
    },
  };

  it('tool: the option without series', () => {
    const tool = selectToolFragment(input(b)) as Record<string, unknown>;
    expect(tool.series).toBeUndefined();
    expect(tool.xAxis).toBeDefined();
    expect(toolCodeFragment(input(b))).not.toMatch(/series/);
  });

  it('prints through codeFragment with data elided', () => {
    expect(toolCodeFragment(input(b))).toBe(codeFragment(selectToolFragment(input(b))));
    expect(toolCodeFragment(input(b))).toMatch(/points \*\//);
  });
});
