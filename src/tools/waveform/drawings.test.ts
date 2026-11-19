// Pins Waveform's drawing glue: the rendered x a drawing binds to, the
// render-time hide reasons, and the gated projection bump.
import { describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../annotations/model';
import {
  createWaveformProjection,
  DELTA_CHANGED,
  WAVEFORM_AXIS_ID,
  waveformHiddenReason,
  waveformProjectionSource,
  X_SOURCE_CHANGED,
  type WaveformChartInstance,
} from './drawings';
import { deriveWaveformModel, type WaveformRingSummary } from './model';
import { renderedXSource } from './plotOption';
import { defaultWaveformState, type WaveformState } from './query';

const A = 'WF:A';
const XS = 'WF:S';

function ring(length: number | null): WaveformRingSummary {
  return { connected: true, length, resetEpoch: 0, arrival: length === null ? null : 1 };
}

function modelOf(patch: Partial<WaveformState>, rings: Record<string, WaveformRingSummary>) {
  const state = { ...defaultWaveformState(), pvs: [A], ...patch };
  return deriveWaveformModel({
    state,
    rings: { [A]: ring(8), ...rings },
    meta: {},
    metaTimedOut: true,
  });
}

function drawing(over: Partial<Annotation> = {}): Annotation {
  return {
    id: 'd1',
    kind: 'vline',
    points: [{ t: 3, v: 0 }],
    axisId: WAVEFORM_AXIS_ID,
    color: '#ff0000',
    width: 1.5,
    text: '',
    xRef: 'index',
    ...over,
  };
}

describe('renderedXSource', () => {
  it('is src:<pv> when the chart plots a usable X source', () => {
    const model = modelOf({ xs: XS }, { [XS]: ring(8) });
    expect(model.xAxis.mode).toBe('source');
    expect(renderedXSource(model, { x: new Float64Array(8) })).toBe(`src:${XS}`);
  });

  it('is index in source mode while the source frame is missing, and a src: drawing hides', () => {
    const model = modelOf({ xs: XS }, { [XS]: ring(8) });
    expect(model.xAxis.mode).toBe('source');
    const rendered = renderedXSource(model, { x: null });
    expect(rendered).toBe('index');
    expect(waveformHiddenReason(drawing({ xRef: `src:${XS}` }), rendered, false)).toBe(
      X_SOURCE_CHANGED
    );
    expect(waveformHiddenReason(drawing({ xRef: 'index' }), rendered, false)).toBeNull();
  });

  it('is index when the mode is index, even with an X source frame', () => {
    const model = modelOf({ xs: XS, xAxis: 'index' }, { [XS]: ring(8) });
    expect(renderedXSource(model, { x: new Float64Array(8) })).toBe('index');
  });

  it('is index with no X source', () => {
    const model = modelOf({}, {});
    expect(renderedXSource(model, { x: null })).toBe('index');
  });
});

describe('waveformHiddenReason', () => {
  it('shows a drawing bound to the rendered x with matching Δ', () => {
    expect(waveformHiddenReason(drawing({ xRef: `src:${XS}` }), `src:${XS}`, false)).toBeNull();
    expect(waveformHiddenReason(drawing({ delta: true }), 'index', true)).toBeNull();
  });

  it('hides as "x source changed" when the bound x differs, and returns when it matches', () => {
    const d = drawing({ xRef: 'index' });
    expect(waveformHiddenReason(d, `src:${XS}`, false)).toBe(X_SOURCE_CHANGED);
    expect(waveformHiddenReason(d, 'index', false)).toBeNull();
  });

  it('hides as "Δ changed" either way Δ flips', () => {
    expect(waveformHiddenReason(drawing({ delta: true }), 'index', false)).toBe(DELTA_CHANGED);
    expect(waveformHiddenReason(drawing(), 'index', true)).toBe(DELTA_CHANGED);
  });

  it('an H-line ignores x but not Δ', () => {
    const h = drawing({ kind: 'hline', xRef: 'index' });
    expect(waveformHiddenReason(h, `src:${XS}`, false)).toBeNull();
    expect(waveformHiddenReason(h, `src:${XS}`, true)).toBe(DELTA_CHANGED);
  });

  it('x source changed takes precedence over Δ changed', () => {
    expect(waveformHiddenReason(drawing({ xRef: 'index' }), `src:${XS}`, true)).toBe(
      X_SOURCE_CHANGED
    );
  });

  it('never mutates the drawing', () => {
    const d = Object.freeze(drawing({ xRef: 'index', delta: true }));
    expect(() => waveformHiddenReason(d, `src:${XS}`, false)).not.toThrow();
  });
});

// A duck-typed chart: grid 0's rect and axis extents through getModel().
function fakeChart(extents: { x: [number, number]; y: [number, number] }) {
  const state = { ...extents, width: 800, height: 400, disposed: false };
  const axis = (key: 'x' | 'y') => ({ axis: { scale: { getExtent: () => state[key] } } });
  const instance: WaveformChartInstance = {
    getWidth: () => state.width,
    getHeight: () => state.height,
    isDisposed: () => state.disposed,
    convertToPixel: (finder, value) => ('xAxisIndex' in finder ? value * 2 : 300 - value),
    convertFromPixel: (finder, px) => ('xAxisIndex' in finder ? px / 2 : 300 - px),
    getModel: () => ({
      getComponent(type: string, idx: number) {
        if (idx !== 0) return undefined;
        if (type === 'grid') {
          return {
            coordinateSystem: { getRect: () => ({ x: 64, y: 36, width: 712, height: 316 }) },
          };
        }
        if (type === 'xAxis') return axis('x');
        if (type === 'yAxis') return axis('y');
        return undefined;
      },
    }),
  };
  return { state, instance };
}

describe('createWaveformProjection', () => {
  it('20 identical frames produce zero bumps after the first', () => {
    const { instance } = fakeChart({ x: [0, 7], y: [0, 10] });
    const proj = createWaveformProjection(() => instance);
    const listener = vi.fn();
    proj.store.subscribe(listener);
    expect(proj.finished()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) expect(proj.finished()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('bumps once when an extent or the size changes, then settles', () => {
    const { state, instance } = fakeChart({ x: [0, 7], y: [0, 10] });
    const proj = createWaveformProjection(() => instance);
    const listener = vi.fn();
    proj.store.subscribe(listener);
    proj.finished();
    state.y = [0, 20];
    for (let i = 0; i < 5; i++) proj.finished();
    expect(listener).toHaveBeenCalledTimes(2);
    state.width = 900;
    for (let i = 0; i < 5; i++) proj.finished();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('reset makes the next frame bump; no chart or a disposed chart never bumps', () => {
    const { state, instance } = fakeChart({ x: [0, 7], y: [0, 10] });
    let live: WaveformChartInstance | null = null;
    const proj = createWaveformProjection(() => live);
    const listener = vi.fn();
    proj.store.subscribe(listener);
    expect(proj.finished()).toBe(false);
    live = instance;
    proj.finished();
    proj.reset();
    expect(proj.finished()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    state.disposed = true;
    state.y = [0, 99];
    expect(proj.finished()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('the bumped projection maps the one grid: value x and the y axis', () => {
    const { instance } = fakeChart({ x: [0, 7], y: [0, 10] });
    const proj = createWaveformProjection(() => instance);
    proj.finished();
    const p = proj.store.get()!;
    expect(p.tToX(3)).toBe(6);
    expect(p.vToY(100, WAVEFORM_AXIS_ID)).toBe(200);
    expect(p.vToY(100, 'other')).toBeNaN();
    expect(p.gridRect).toEqual({ left: 64, top: 36, width: 712, height: 316 });
    expect(p.grids).toHaveLength(1);
  });
});

describe('waveformProjectionSource', () => {
  it('is null without a live chart', () => {
    expect(waveformProjectionSource(() => null)()).toBeNull();
    const { state, instance } = fakeChart({ x: [0, 1], y: [0, 1] });
    state.disposed = true;
    expect(waveformProjectionSource(() => instance)()).toBeNull();
  });
});
