// @vitest-environment jsdom
// Annotation layer through the catalog: one svg per
// grid, each drawing in its axis's grid; pointer input in the grid under the
// pointer with a live gesture kept in its start grid; a new drawing's axis from
// `ownerAxisAt`; `hiddenReason` skips; the measure card through the host's
// `MeasureProvider`, re-rendered by `frames`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { drawingThemeFor } from '../annotationTheme';
import { createProjectionStore, type Projection } from '../plot/geometry';
import type { GridProjection } from './catalog/types';
import type { Annotation } from './model';
import { AnnotationLayer, type AnnotationLayerProps } from './AnnotationLayer';
import { DEFAULT_TOOL_PREFS, type AnnotationToolPrefs } from './tools';
import { firePointer, projectionOf } from '../plot/testUtils';
import { BUILTIN_CATALOG } from './catalog';
import { TIME_X_AXIS } from './catalog/xAxis';

const TRACE_LAYER = { catalog: BUILTIN_CATALOG, xAxis: TIME_X_AXIS };

afterEach(cleanup);

// Two stacked grids sharing x = t/10: grid 0 at (0, 0) 200 x 100 draws 'a'
// (y = 100 - v), grid 1 at (0, 120) 200 x 100 draws 'b' (y = 220 - v).
function grid(top: number, axisId: string): GridProjection {
  const base = top + 100;
  return {
    tToX: (t) => t / 10,
    xToT: (x) => x * 10,
    vToY: (v, id) => (id === axisId ? base - v : NaN),
    yToV: (y, id) => (id === axisId ? base - y : NaN),
    gridRect: { left: 0, top, width: 200, height: 100 },
    axisIds: [axisId],
  };
}
const G0 = grid(0, 'a');
const G1 = grid(120, 'b');
function splitProjection(): Projection {
  return projectionOf(G0, G1);
}

function ann(over: Partial<Annotation> & Pick<Annotation, 'id' | 'kind' | 'points'>): Annotation {
  return { axisId: 'a', color: '#4589ff', width: 2, text: '', ...over };
}

function mount(
  props: Partial<Omit<AnnotationLayerProps, 'prefs' | 'config'>> & {
    prefs?: Partial<AnnotationToolPrefs>;
    config?: Partial<AnnotationLayerProps['config']>;
  } = {}
) {
  const store = createProjectionStore(splitProjection);
  const state = { annotations: props.annotations ? [...props.annotations] : [] };
  const onCommit = vi.fn();
  function Harness() {
    const [list, setList] = useState<Annotation[]>(state.annotations);
    state.annotations = list;
    return (
      <div style={{ position: 'relative' }}>
        <AnnotationLayer
          projectionStore={store}
          axes={[{ id: 'a' }, { id: 'b' }]}
          theme={drawingThemeFor('dark')}
          {...props}
          config={{ ...TRACE_LAYER, ...props.config }}
          annotations={list}
          prefs={{ ...DEFAULT_TOOL_PREFS, ...props.prefs }}
          onCommit={(fn, label) => {
            onCommit(fn, label);
            setList((l) => fn(l));
          }}
        />
      </div>
    );
  }
  const utils = render(<Harness />);
  act(() => store.bump());
  const svgs = () =>
    [...utils.container.querySelectorAll('svg[data-annotation-layer]')] as SVGSVGElement[];
  const fire = (el: EventTarget, type: string, x: number, y: number) =>
    act(() => {
      firePointer(el, type, { x, y });
    });
  return { ...utils, store, svgs, fire, state, onCommit };
}

describe('AnnotationLayer multi-grid render', () => {
  it('renders one svg per grid, at its rect, each drawing in its axis grid', () => {
    const { svgs } = mount({
      annotations: [
        ann({ id: 'ha', kind: 'hline', points: [{ t: 0, v: 40 }], axisId: 'a' }),
        ann({ id: 'hb', kind: 'hline', points: [{ t: 0, v: 40 }], axisId: 'b' }),
        ann({ id: 'v', kind: 'vline', points: [{ t: 500, v: 0 }], axisId: 'off' }),
        ann({ id: 'hoff', kind: 'hline', points: [{ t: 0, v: 40 }], axisId: 'off' }),
      ],
    });
    const [s0, s1] = svgs();
    expect(svgs()).toHaveLength(2);
    expect(s0.style.top).toBe('0px');
    expect(s1.style.top).toBe('120px');
    expect(s1.style.height).toBe('100px');
    expect(s1.querySelector('g')?.getAttribute('transform')).toBe('translate(0 -120)');
    expect(s0.querySelector('[data-annotation-id="ha"]')).not.toBeNull();
    expect(s1.querySelector('[data-annotation-id="ha"]')).toBeNull();
    const hb = s1.querySelector('[data-annotation-id="hb"] path');
    expect(hb?.getAttribute('d')).toBe('M0 180H200');
    // x-only drawing on an axis no grid draws: grid 0. A v-bearing one is skipped.
    expect(s0.querySelector('[data-annotation-id="v"]')).not.toBeNull();
    expect(document.querySelector('[data-annotation-id="hoff"]')).toBeNull();
  });

  it('skips drawings for which hiddenReason returns non-null', () => {
    const { container } = mount({
      annotations: [
        ann({ id: 'keep', kind: 'hline', points: [{ t: 0, v: 40 }] }),
        ann({ id: 'gone', kind: 'hline', points: [{ t: 0, v: 50 }] }),
      ],
      config: { hiddenReason: (a) => (a.id === 'gone' ? 'x source changed' : null) },
    });
    expect(container.querySelector('[data-annotation-id="keep"]')).not.toBeNull();
    expect(container.querySelector('[data-annotation-id="gone"]')).toBeNull();
  });

  it('skips drawings whose kind the catalog lacks', () => {
    const { container } = mount({
      annotations: [ann({ id: 'x', kind: 'mystery', points: [{ t: 0, v: 40 }] })],
    });
    expect(container.querySelector('[data-annotation-id="x"]')).toBeNull();
  });
});

describe('AnnotationLayer multi-grid input', () => {
  it('a new drawing takes the axis ownerAxisAt returns, inverted in the grid under the pointer', () => {
    const ownerAxisAt = vi.fn((_x: number, py: number) => (py >= 120 ? 'b' : 'a'));
    const h = mount({ prefs: { tool: 'hline' }, config: { ownerAxisAt } });
    const [, s1] = h.svgs();
    h.fire(s1, 'pointerdown', 50, 170);
    h.fire(s1, 'pointerup', 50, 170);
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    const [line] = h.state.annotations;
    expect(line.axisId).toBe('b');
    expect(line.points[0].v).toBeCloseTo(50, 6);
    expect(ownerAxisAt).toHaveBeenCalledWith(50, 170, null);
  });

  it('places nothing when ownerAxisAt returns null', () => {
    const h = mount({ prefs: { tool: 'hline' }, config: { ownerAxisAt: () => null } });
    const [s0] = h.svgs();
    h.fire(s0, 'pointerdown', 50, 50);
    h.fire(s0, 'pointerup', 50, 50);
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.state.annotations).toHaveLength(0);
  });

  it('keeps a live gesture in its start grid', () => {
    const h = mount({ prefs: { tool: 'box' } });
    const [s0, s1] = h.svgs();
    h.fire(s0, 'pointerdown', 20, 80);
    // The drag ends over grid 1; the point still inverts through grid 0 (y = 100 - v).
    h.fire(s1, 'pointermove', 100, 130);
    h.fire(s1, 'pointerup', 100, 130);
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    const [box] = h.state.annotations;
    expect(box.axisId).toBe('a');
    expect(box.points[0].v).toBeCloseTo(20, 6);
    expect(box.points[1].v).toBeCloseTo(-30, 6);
    expect(box.points[1].t).toBe(1000);
  });

  it('re-expresses a snap on another grid through the hit grid into the drawing grid', () => {
    // A fixed-axis handle drag on 'a' (grid 0) snapping to a sample on 'b' (grid 1):
    // the hit's pixel y comes from grid 1 and is inverted on 'a' in grid 0.
    const snap = { snap: vi.fn(() => ({ t: 300, v: 60, axisId: 'b', traceId: 'c2' })) };
    const h = mount({
      prefs: { magnet: true },
      selectedId: 'bx',
      annotations: [
        ann({
          id: 'bx',
          kind: 'box',
          points: [
            { t: 0, v: 10 },
            { t: 500, v: 50 },
          ],
        }),
      ],
      config: { snap },
    });
    const [s0] = h.svgs();
    const handle = s0.querySelector('[data-annotation-id="bx"] [data-handle="1"]') as Element;
    h.fire(handle, 'pointerdown', 50, 50);
    h.fire(s0, 'pointermove', 40, 60);
    h.fire(s0, 'pointerup', 40, 60);
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    const [box] = h.state.annotations;
    expect(box.axisId).toBe('a');
    // grid 1: y = 220 - 60 = 160; on 'a' in grid 0 that pixel is v = 100 - 160 = -60.
    expect(box.points[1]).toEqual({ t: 300, v: -60 });
  });
});

describe('AnnotationLayer measure card', () => {
  it('renders the card through the host MeasureProvider and re-renders it on frames', () => {
    let version = 0;
    const listeners = new Set<() => void>();
    const frames = {
      subscribe: (cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      getVersion: () => version,
    };
    const card = vi.fn(() => [`frame ${version}`]);
    const { container } = mount({
      annotations: [
        ann({
          id: 'm',
          kind: 'measure',
          points: [
            { t: 0, v: 10 },
            { t: 500, v: 50 },
          ],
        }),
      ],
      config: { measure: { card }, frames },
    });
    const text = () =>
      container.querySelector('[data-annotation-id="m"] [data-measure-card] text')?.textContent;
    expect(text()).toBe('frame 0');
    act(() => {
      version = 1;
      for (const cb of listeners) cb();
    });
    expect(text()).toBe('frame 1');
  });
});
