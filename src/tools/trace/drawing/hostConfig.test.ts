import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_CATALOG } from '../../../annotations/catalog';
import { TIME_X_AXIS } from '../../../annotations/catalog/xAxis';
import type { GridProjection } from '../../../annotations/catalog/types';
import { snapToSample } from './snap';
import { measureCardLines, measureReadout } from './measure';
import type { Annotation } from '../../../annotations/model';
import { createFrameStore } from '../../../annotations/host/frameStore';
import { createTraceHostConfig, type TraceDrawingData } from './hostConfig';

// x = 60 + t / 10, y = 220 - v on axis 'a'.
const grid: GridProjection = {
  tToX: (t) => 60 + t / 10,
  xToT: (x) => (x - 60) * 10,
  vToY: (v, id) => (id === 'a' ? 220 - v : NaN),
  yToV: (y, id) => (id === 'a' ? 220 - y : NaN),
  gridRect: { left: 60, top: 20, width: 400, height: 200 },
  axisIds: [],
};

function data(over: Partial<TraceDrawingData> = {}): TraceDrawingData {
  return {
    traceData: new Map([
      [
        'c1',
        [
          [1000, 50],
          [2000, 60],
          [3000, 70],
        ],
      ],
    ]),
    traces: [{ id: 'c1', axisId: 'a' }],
    binnedTraceIds: new Set(),
    archiveEndMs: new Map(),
    axes: [{ id: 'a' }, { id: 'b' }],
    ...over,
  } as TraceDrawingData;
}

describe('createTraceHostConfig', () => {
  it('is the built-in catalog on the time axis', () => {
    const cfg = createTraceHostConfig(data());
    expect(cfg.catalog).toBe(BUILTIN_CATALOG);
    expect(cfg.xAxis).toBe(TIME_X_AXIS);
  });

  it('snaps through snapToSample over the data read at call time', () => {
    const d = data();
    const cfg = createTraceHostConfig(d);
    const want = snapToSample(d.traceData, d.traces, grid, 160, 160);
    expect(want).not.toBeNull();
    expect(cfg.snap.snap(160, 160, grid)).toEqual(want);
    // Live: a later frame with no curves finds nothing, same config object.
    cfg.setData(data({ traceData: new Map(), traces: [] }));
    expect(cfg.snap.snap(160, 160, grid)).toBeNull();
  });

  it('owns a new drawing on the primary axis, null without axes', () => {
    const cfg = createTraceHostConfig(data());
    expect(cfg.ownerAxisAt(100, 100, null)).toBe('a');
    cfg.setData(data({ axes: [] }));
    expect(cfg.ownerAxisAt(100, 100, null)).toBeNull();
  });

  it('hides nothing and never sheds', () => {
    const cfg = createTraceHostConfig(data());
    expect(
      cfg.hiddenReason({ id: 'x', kind: 'note', points: [] } as unknown as Annotation)
    ).toBeNull();
    expect(cfg.shed.get()).toEqual({ dropped: 0, trimmed: 0 });
  });

  it('measures with the Trace readout on the primary axis and the axis unit', () => {
    const d = data();
    const cfg = createTraceHostConfig(d);
    const a = {
      id: 'm1',
      kind: 'measure',
      points: [
        { t: 1000, v: 50 },
        { t: 3000, v: 70 },
      ],
      axisId: 'a',
    } as unknown as Annotation;
    const axis = { id: 'a', name: 'A', units: 'mA' };
    const want = measureCardLines(
      measureReadout(a, {
        traceData: d.traceData,
        traces: d.traces,
        primaryAxisId: 'a',
        binnedTraceIds: d.binnedTraceIds,
        archiveEndMs: d.archiveEndMs,
      }),
      'mA'
    );
    expect(cfg.measure.card(a, { axis, xAxis: TIME_X_AXIS })).toEqual(want);
  });
});

describe('createFrameStore', () => {
  it('bumps the version and notifies until unsubscribed', () => {
    const fs = createFrameStore();
    const cb = vi.fn();
    const off = fs.subscribe(cb);
    expect(fs.getVersion()).toBe(0);
    fs.bump();
    expect(fs.getVersion()).toBe(1);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    fs.bump();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
