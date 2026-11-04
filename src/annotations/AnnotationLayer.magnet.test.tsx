// @vitest-environment jsdom
// Annotation layer, magnet: with the plot's magnet on, the
// overlay's pointer path hands reduceToolsIn the nearest sample (snapToSample):
// a first anchor adopts the snapped curve's axis and trace and the exact sample
// value; a second anchor (or a handle) snapped to a curve on another axis is
// re-expressed on the drawing's own axis. With the magnet off, nothing snaps:
// the primary axis is recorded and no trace.
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { drawingThemeFor } from '../annotationTheme';
import type { LinePoint } from '../components/traceGaps';
import { createProjectionStore, type Projection } from '../plot/geometry';
import { snapToSample, type SnapTrace } from '../tools/trace/drawing/snap';
import type { Annotation } from './model';
import { AnnotationLayer } from './AnnotationLayer';
import { DEFAULT_TOOL_PREFS, type AnnotationToolPrefs } from './tools';
import { firePointer, projectionOf } from '../plot/testUtils';
import { BUILTIN_CATALOG } from './catalog';
import { TIME_X_AXIS } from './catalog/xAxis';

// Grid at (60, 20), 400 x 200; x = 60 + t/10. Axis 'a' (primary): y = 220 - v.
// Axis 'b': y = 220 - v/2.
const GRID = { left: 60, top: 20, width: 400, height: 200 };
const vToY = (v: number, axisId: string) =>
  axisId === 'a' ? 220 - v : axisId === 'b' ? 220 - v / 2 : NaN;
const yToV = (y: number, axisId: string) =>
  axisId === 'a' ? 220 - y : axisId === 'b' ? (220 - y) * 2 : NaN;
function fakeProjection(): Projection {
  return projectionOf({
    tToX: (t) => GRID.left + t / 10,
    xToT: (x) => (x - GRID.left) * 10,
    vToY,
    yToV,
    gridRect: GRID,
    axisIds: ['a', 'b'],
  });
}

// Curve 'c1' on axis 'a': a sample at t=1000 (x=160) with an unquantized value.
const V1 = 50.123456789;
const Y1 = vToY(V1, 'a');
// Curve 'c2' on axis 'b': a sample at t=3000 (x=360).
const V2 = 200.987654321;
const Y2 = vToY(V2, 'b');
const TRACE_DATA: ReadonlyMap<string, readonly LinePoint[]> = new Map<string, LinePoint[]>([
  [
    'c1',
    [
      [0, 10],
      [1000, V1],
      [2000, null],
    ],
  ],
  [
    'c2',
    [
      [2500, 150],
      [3000, V2],
    ],
  ],
]);
const TRACES: SnapTrace[] = [
  { id: 'c1', axisId: 'a' },
  { id: 'c2', axisId: 'b' },
];

afterEach(() => cleanup());

// Trace's sample magnet over the curves (its host config's snap source).
const TRACE_LAYER = { catalog: BUILTIN_CATALOG, xAxis: TIME_X_AXIS };

const MAGNET = {
  ...TRACE_LAYER,
  snap: {
    snap: (x: number, y: number, grid: Projection) => snapToSample(TRACE_DATA, TRACES, grid, x, y),
  },
};

function mountLayer(
  prefsIn: Partial<AnnotationToolPrefs>,
  annotations: Annotation[] = [],
  selectedId: string | null = null
) {
  const store = createProjectionStore(fakeProjection);
  const state = { annotations };
  const ctl: { setPrefs?: (p: Partial<AnnotationToolPrefs>) => void } = {};
  function Harness() {
    const [list, setList] = useState<Annotation[]>(annotations);
    const [prefs, setPrefs] = useState<AnnotationToolPrefs>({ ...DEFAULT_TOOL_PREFS, ...prefsIn });
    ctl.setPrefs = (p) => setPrefs((q) => ({ ...q, ...p }));
    state.annotations = list;
    return (
      <div style={{ position: 'relative' }}>
        <AnnotationLayer
          projectionStore={store}
          annotations={list}
          axes={[{ id: 'a' }, { id: 'b' }]}
          theme={drawingThemeFor('dark')}
          prefs={prefs}
          selectedId={selectedId}
          config={MAGNET}
          onCommit={(fn) => setList((l) => fn(l))}
          onPrefs={(patch) => setPrefs((p) => ({ ...p, ...patch }))}
        />
      </div>
    );
  }
  const utils = render(<Harness />);
  act(() => store.bump());
  const root = () => utils.container.querySelector('svg[data-annotation-layer]') as SVGSVGElement;
  const fire = (el: EventTarget, type: string, x: number, y: number) =>
    act(() => {
      firePointer(el, type, { x, y });
    });
  const click = (x: number, y: number) => {
    fire(root(), 'pointerdown', x, y);
    fire(root(), 'pointerup', x, y);
  };
  const setPrefs = (p: Partial<AnnotationToolPrefs>) => act(() => ctl.setPrefs?.(p));
  return { ...utils, root, fire, click, state, setPrefs };
}

describe('AnnotationLayer magnet: first anchor', () => {
  it('snaps a placement 10 px from a sample and records its axis, trace and exact value', () => {
    const h = mountLayer({ tool: 'note', magnet: true });
    h.click(160, Y1 + 10);
    expect(h.state.annotations).toHaveLength(1);
    const [a] = h.state.annotations;
    expect(a.axisId).toBe('a');
    expect(a.traceId).toBe('c1');
    // Exact sample, no quantization.
    expect(a.points[0].t).toBe(1000);
    expect(a.points[0].v).toBe(V1);
  });

  it('adopts the snapped curve axis when it is not the primary', () => {
    const h = mountLayer({ tool: 'hline', magnet: true });
    h.click(366, Y2 - 6);
    const [a] = h.state.annotations;
    expect(a.axisId).toBe('b');
    expect(a.traceId).toBe('c2');
    expect(a.points[0].v).toBe(V2);
  });

  it('with the magnet off, records the primary axis and no trace', () => {
    const h = mountLayer({ tool: 'note', magnet: false });
    h.click(160, Y1 + 10);
    const [a] = h.state.annotations;
    expect(a.axisId).toBe('a');
    expect(a.traceId).toBeUndefined();
    expect(a.points[0].v).not.toBe(V1);
    expect(a.points[0].v).toBeCloseTo(220 - (Y1 + 10), 4);
    expect(a.points[0].t).toBe(1000);
  });

  it('with the magnet off, a press over a secondary-axis curve still records the primary axis', () => {
    const h = mountLayer({ tool: 'hline', magnet: false });
    h.click(360, Y2);
    const [a] = h.state.annotations;
    expect(a.axisId).toBe('a');
    expect(a.traceId).toBeUndefined();
    expect(a.points[0].v).toBeCloseTo(220 - Y2, 2); // free value: 6 significant digits
  });

  it('beyond the snap radius the magnet records the free point on the primary axis', () => {
    const h = mountLayer({ tool: 'note', magnet: true });
    h.click(260, 60);
    const [a] = h.state.annotations;
    expect(a.axisId).toBe('a');
    expect(a.traceId).toBeUndefined();
    expect(a.points[0]).toEqual({ t: 2000, v: 160 });
  });

  it('ignores gap markers', () => {
    // (160 + 100 = 260) is t=2000, a [t, null] gap on c1: no snap there.
    const h = mountLayer({ tool: 'note', magnet: true });
    h.click(260, 200);
    const [a] = h.state.annotations;
    expect(a.traceId).toBeUndefined();
  });
});

describe('AnnotationLayer magnet: second anchor', () => {
  it('re-expresses a second anchor snapped on another axis on the drawing axis', () => {
    const h = mountLayer({ tool: 'trend', magnet: true });
    // First anchor on c2 (axis b), second on c1 (axis a).
    h.click(360, Y2 + 5);
    expect(h.state.annotations).toHaveLength(0);
    h.click(160, Y1 - 5);
    expect(h.state.annotations).toHaveLength(1);
    const [a] = h.state.annotations;
    expect(a.axisId).toBe('b');
    expect(a.traceId).toBe('c2');
    expect(a.points[0]).toEqual({ t: 3000, v: V2 });
    expect(a.points[1].t).toBe(1000);
    // yToV on the drawing's axis at the sample's pixel: same screen point.
    expect(a.points[1].v).toBeCloseTo(yToV(Y1, 'b'), 9);
    expect(vToY(a.points[1].v, 'b')).toBeCloseTo(Y1, 9);
  });

  it('keeps the exact value for a second anchor snapped on the same axis', () => {
    const h = mountLayer({ tool: 'trend', magnet: true });
    h.click(160, Y1 + 3);
    h.click(64, vToY(10, 'a') + 4);
    const [a] = h.state.annotations;
    expect(a.axisId).toBe('a');
    expect(a.points[0]).toEqual({ t: 1000, v: V1 });
    expect(a.points[1]).toEqual({ t: 0, v: 10 });
  });

  it('a dragged handle snapped on another axis lands on the drawing axis', () => {
    const line: Annotation = {
      id: 'tb',
      kind: 'trend',
      points: [
        { t: 500, v: 20 },
        { t: 3500, v: 300 },
      ],
      axisId: 'b',
      color: '#4589ff',
      width: 2,
      text: '',
    };
    const h = mountLayer({ tool: 'cursor', magnet: true }, [line], 'tb');
    const handle = h.container.querySelector('[data-annotation-id="tb"] [data-handle="1"]');
    expect(handle).not.toBeNull();
    h.fire(handle!, 'pointerdown', 410, vToY(300, 'b'));
    h.fire(h.root(), 'pointermove', 165, Y1 + 2);
    h.fire(h.root(), 'pointerup', 165, Y1 + 2);
    const [a] = h.state.annotations;
    expect(a.axisId).toBe('b');
    expect(a.points[1].t).toBe(1000);
    expect(a.points[1].v).toBeCloseTo(yToV(Y1, 'b'), 9);
  });
});

describe('AnnotationLayer magnet: per-plot toggle', () => {
  it('follows the prefs magnet flag as it is flipped', () => {
    const h = mountLayer({ tool: 'note', magnet: false, stay: true });
    h.click(160, Y1 + 10);
    expect(h.state.annotations[0].traceId).toBeUndefined();
    h.setPrefs({ magnet: true });
    h.click(160, Y1 + 10);
    expect(h.state.annotations[1].traceId).toBe('c1');
    expect(h.state.annotations[1].points[0].v).toBe(V1);
    h.setPrefs({ magnet: false });
    h.click(160, Y1 + 10);
    expect(h.state.annotations[2].traceId).toBeUndefined();
  });

  it('two plots keep independent magnets', () => {
    const on = mountLayer({ tool: 'note', magnet: true });
    on.click(160, Y1 + 10);
    expect(on.state.annotations[0].traceId).toBe('c1');
    cleanup();
    const off = mountLayer({ tool: 'note', magnet: false });
    off.click(160, Y1 + 10);
    expect(off.state.annotations[0].traceId).toBeUndefined();
  });
});
