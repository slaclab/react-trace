// @vitest-environment jsdom
//
// Projection + cursor stores.
// SinglePlot owns one projection store per mount and republishes it from the
// ECharts `finished` event and the resize path, never during render; the
// cursor store is written by the wrapper's mousemove and must not re-render
// the plot. Uses the hoisted fake-instance pattern of
// PlotArea.axisInteractions.test.tsx, extended to capture `onEvents`.
import { act, render, renderHook } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SinglePlot } from '../components/PlotArea';
import type { Axis, Plot } from '../types';
import {
  buildProjection,
  createCursorStore,
  createProjectionStore,
  useProjection,
  type CursorStore,
  type Projection,
  type AxisPlacement,
  type ProjectionInstance,
  type ProjectionStore,
} from './geometry';
import { projectionOf } from './testUtils';

// 800x400 canvas, grid insets top 40 / bottom 60 / left 70 / right 20: the
// grid is x 70..780 for times T0..T1 and y 340..40 for values 0..100.
const { fakeInstance, chart, T0, T1 } = vi.hoisted(() => {
  const T0 = 1_000_000;
  const T1 = 1_710_000;
  const chart = {
    renders: 0,
    onEvents: undefined as Record<string, () => void> | undefined,
    disposed: false,
  };
  const isX = (f: unknown) => typeof f === 'object' && f !== null && 'xAxisIndex' in f;
  const fakeInstance = {
    getWidth: () => 800,
    getHeight: () => 400,
    getDom: () => ({}),
    isDisposed: () => chart.disposed,
    getZr: () => ({ setCursorStyle: () => {} }),
    getModel: () => ({
      getComponent: () => ({ axis: { scale: { getExtent: (): [number, number] => [0, 100] } } }),
    }),
    convertToPixel: (f: unknown, v: number) =>
      isX(f) ? 70 + ((v - T0) / (T1 - T0)) * 710 : 340 - (v / 100) * 300,
    convertFromPixel: (f: unknown, px: number) =>
      isX(f) ? T0 + ((px - 70) / 710) * (T1 - T0) : ((340 - px) / 300) * 100,
  };
  return { fakeInstance, chart, T0, T1 };
});

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component<{ onEvents?: Record<string, () => void> }> {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      chart.renders++;
      chart.onEvents = this.props.onEvents;
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

// Capture the stores SinglePlot creates, without widening its props.
const created = vi.hoisted(() => ({
  projection: [] as ProjectionStore[],
  cursor: [] as CursorStore[],
}));
vi.mock('./geometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./geometry')>();
  return {
    ...actual,
    createProjectionStore: (...args: Parameters<typeof actual.createProjectionStore>) => {
      const store = actual.createProjectionStore(...args);
      created.projection.push(store);
      return store;
    },
    createCursorStore: () => {
      const store = actual.createCursorStore();
      created.cursor.push(store);
      return store;
    },
  };
});

function makePlot(): Plot {
  const axis: Axis = {
    id: 'ax1',
    name: 'Y',
    orientation: 'left',
    autoScale: true,
    logScale: false,
    visible: true,
  };
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [],
    axes: [axis],
    backgroundColor: 'default',
    showLegend: false,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '1h' },
  };
}

function mountPlot(onAxisRangesChange?: () => void) {
  const { container, unmount } = render(
    <SinglePlot
      plot={makePlot()}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
      onAxisRangesChange={onAxisRangesChange}
    />
  );
  const wrap = container.querySelector('[data-plot-id="p1"]')!;
  // One SinglePlot mount → exactly one store of each kind.
  expect(created.projection).toHaveLength(1);
  expect(created.cursor).toHaveLength(1);
  return { wrap, projection: created.projection[0], cursor: created.cursor[0], unmount };
}

function fireFinished() {
  act(() => chart.onEvents!.finished());
}

beforeEach(() => {
  created.projection.length = 0;
  created.cursor.length = 0;
  chart.renders = 0;
  chart.onEvents = undefined;
  chart.disposed = false;
});

describe('SinglePlot projection store', () => {
  it('a finished event publishes a new Projection whose tToX matches the converter', () => {
    const { projection } = mountPlot();
    const before = projection.get();
    const seen = vi.fn();
    projection.subscribe(seen);

    fireFinished();

    const p = projection.get();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(p).not.toBeNull();
    expect(p).not.toBe(before);
    const tMid = (T0 + T1) / 2;
    expect(p!.tToX(tMid)).toBe(fakeInstance.convertToPixel({ xAxisIndex: 0 }, tMid));
    expect(p!.tToX(T0)).toBe(70);
    expect(p!.xToT(780)).toBe(T1);
    expect(p!.vToY(50, 'ax1')).toBe(190);
    expect(p!.yToV(40, 'ax1')).toBe(100);
    expect(p!.gridRect).toEqual({ left: 70, top: 40, width: 710, height: 300 });
  });

  it('bumps on finished even when no one listens for axis ranges', () => {
    const { projection } = mountPlot(undefined);
    const seen = vi.fn();
    projection.subscribe(seen);
    fireFinished();
    fireFinished();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('still reports axis ranges on finished', () => {
    const onAxisRangesChange = vi.fn();
    mountPlot(onAxisRangesChange);
    fireFinished();
    expect(onAxisRangesChange).toHaveBeenCalledTimes(1);
  });

  it('keeps get() stable between bumps', () => {
    const { projection } = mountPlot();
    fireFinished();
    expect(projection.get()).toBe(projection.get());
  });

  it('publishes null while the chart instance is disposed', () => {
    const { projection } = mountPlot();
    chart.disposed = true;
    fireFinished();
    expect(projection.get()).toBeNull();
  });

  it('does not re-render the plot when the projection bumps', () => {
    const { projection } = mountPlot();
    const renders = chart.renders;
    act(() => projection.bump());
    fireFinished();
    expect(chart.renders).toBe(renders);
  });
});

describe('SinglePlot cursor store', () => {
  it('a wrapper mousemove writes the cursor and re-renders no SinglePlot', () => {
    const { wrap, cursor } = mountPlot();
    const seen = vi.fn();
    cursor.subscribe(seen);
    const renders = chart.renders;

    // jsdom's wrapper rect is 0,0, so clientX/Y are wrapper-local pixels.
    fireEvent.mouseMove(wrap, { clientX: 120, clientY: 90 });
    fireEvent.mouseMove(wrap, { clientX: 121, clientY: 91 });

    expect(cursor.get()).toEqual({ x: 121, y: 91 });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(chart.renders).toBe(renders);

    fireEvent.mouseLeave(wrap);
    expect(cursor.get()).toBeNull();
    expect(chart.renders).toBe(renders);
  });

  it('ignores mousemoves over plot chrome', () => {
    const { wrap, cursor } = mountPlot();
    const badge = document.createElement('div');
    badge.setAttribute('data-axis-badge', '');
    wrap.appendChild(badge);
    fireEvent.mouseMove(badge, { clientX: 10, clientY: 10 });
    expect(cursor.get()).toBeNull();
  });
});

describe('createProjectionStore / useProjection', () => {
  const projection = (x: number): Projection =>
    projectionOf({
      tToX: () => x,
      xToT: () => x,
      vToY: () => x,
      yToV: () => x,
      gridRect: { left: 0, top: 0, width: 0, height: 0 },
      axisIds: [],
    });

  it('starts empty and caches the source result per bump', () => {
    let n = 0;
    const source = vi.fn(() => projection(++n));
    const store = createProjectionStore(source);
    expect(store.get()).toBeNull();
    expect(source).not.toHaveBeenCalled();
    store.bump();
    const first = store.get();
    expect(store.get()).toBe(first);
    expect(source).toHaveBeenCalledTimes(1);
    store.bump();
    expect(store.get()).not.toBe(first);
  });

  it('unsubscribes', () => {
    const store = createProjectionStore(() => projection(1));
    const cb = vi.fn();
    const off = store.subscribe(cb);
    off();
    store.bump();
    expect(cb).not.toHaveBeenCalled();
  });

  it('re-renders a subscriber on each bump', () => {
    let n = 0;
    const store = createProjectionStore(() => projection(++n));
    const { result } = renderHook(() => useProjection(store));
    expect(result.current).toBeNull();
    act(() => store.bump());
    expect(result.current!.tToX(0)).toBe(1);
    act(() => store.bump());
    expect(result.current!.tToX(0)).toBe(2);
  });
});

describe('createCursorStore', () => {
  it('notifies on change only', () => {
    const store = createCursorStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.set({ x: 1, y: 2 });
    store.set({ x: 1, y: 2 });
    expect(cb).toHaveBeenCalledTimes(1);
    store.set(null);
    store.set(null);
    expect(cb).toHaveBeenCalledTimes(2);
    store.bump();
    expect(cb).toHaveBeenCalledTimes(3);
  });
});

describe('buildProjection', () => {
  const layout = {
    axisIndexMap: new Map([
      ['a', 0],
      ['b', 1],
    ]),
    gridTop: 10,
    gridBottom: 20,
    gridLeft: 30,
    gridRight: 40,
  };
  const inst = (disposed = false): ProjectionInstance => ({
    getWidth: () => 200,
    getHeight: () => 100,
    isDisposed: () => disposed,
    convertToPixel: (f, v) => ('yAxisIndex' in f ? v * 10 + f.yAxisIndex : v + 1),
    convertFromPixel: (f, px) => ('yAxisIndex' in f ? px / 10 : px - 1),
  });

  it('routes each axis id to its yAxisIndex and time to the x axis', () => {
    const p = buildProjection(inst(), layout, [{ id: 'a' }, { id: 'b' }]);
    expect(p.vToY(2, 'a')).toBe(20);
    expect(p.vToY(2, 'b')).toBe(21);
    expect(p.yToV(20, 'a')).toBe(2);
    expect(p.tToX(5)).toBe(6);
    expect(p.xToT(6)).toBe(5);
    expect(p.gridRect).toEqual({ left: 30, top: 10, width: 130, height: 70 });
  });

  it('maps axes that are not visible, unknown, or on a disposed chart to NaN', () => {
    const p = buildProjection(inst(), layout, [{ id: 'a' }]);
    expect(p.vToY(1, 'b')).toBeNaN();
    expect(p.yToV(1, 'nope')).toBeNaN();
    const dead = buildProjection(inst(true), layout, [{ id: 'a' }]);
    expect(dead.tToX(1)).toBeNaN();
    expect(dead.vToY(1, 'a')).toBeNaN();
  });

  it('maps a non-numeric converter result to NaN', () => {
    const odd: ProjectionInstance = {
      ...inst(),
      convertToPixel: () => [1, 2],
    };
    expect(buildProjection(odd, layout, [{ id: 'a' }]).tToX(0)).toBeNaN();
  });
});

// Correlation's split view: one grid per visible Y, stacked. Grid i is
// x 50..350, y (10 + 100 i)..(90 + 100 i); its x axis i maps t -> 50 + t, its
// y axis i maps 0..100 onto the grid's bottom..top.
describe('buildProjection with a split resolver', () => {
  const top = (i: number) => 10 + 100 * i;
  const xIdx = (f: object) => ('xAxisIndex' in f ? (f.xAxisIndex as number) : -1);
  const yIdx = (f: object) => ('yAxisIndex' in f ? (f.yAxisIndex as number) : -1);
  const calls: number[] = [];
  const split: ProjectionInstance = {
    getWidth: () => 400,
    getHeight: () => 300,
    convertToPixel: (f, v) => {
      if (xIdx(f) >= 0) {
        calls.push(xIdx(f));
        return 50 + v;
      }
      return top(yIdx(f)) + 80 - v * 0.8;
    },
    convertFromPixel: (f, px) => (xIdx(f) >= 0 ? px - 50 : (top(yIdx(f)) + 80 - px) / 0.8),
  };
  const layout = {
    axisIndexMap: new Map<string, number>(),
    gridTop: 0,
    gridBottom: 0,
    gridLeft: 0,
    gridRight: 0,
    gridRects: [0, 1, 2].map((i) => ({ left: 50, top: top(i), width: 300, height: 80 })),
  };
  const placement: Record<string, AxisPlacement> = {
    a: { gridIndex: 0, xAxisIndex: 0, yAxisIndex: 0 },
    b: { gridIndex: 1, xAxisIndex: 1, yAxisIndex: 1 },
    c: { gridIndex: 2, xAxisIndex: 2, yAxisIndex: 2 },
  };
  const resolve = (id: string) => placement[id] ?? null;
  const axes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'hidden' }];

  it('builds one grid per placed axis, each with its own rect and axes', () => {
    const p = buildProjection(split, layout, axes, resolve);
    expect(p.grids).toHaveLength(3);
    expect(p.grids.map((g) => g.axisIds)).toEqual([['a'], ['b'], ['c']]);
    expect(p.grids[2].gridRect).toEqual({ left: 50, top: 210, width: 300, height: 80 });
    expect(p.gridOf('b')).toBe(p.grids[1]);
    expect(p.gridOf('hidden')).toBeUndefined();
    // Grid 0's fields stay at the top level.
    expect(p.gridRect).toEqual(p.grids[0].gridRect);
    expect(p.axisIds).toEqual(['a']);
    expect(p.vToY(50, 'a')).toBe(50);
    expect(p.vToY(50, 'c')).toBeNaN();
  });

  it('finds the grid under a pixel, edges included, and none in a gap', () => {
    const p = buildProjection(split, layout, axes, resolve);
    expect(p.gridAt(200, 250)).toBe(p.grids[2]);
    expect(p.gridAt(50, 210)).toBe(p.grids[2]);
    expect(p.gridAt(350, 90)).toBe(p.grids[0]);
    expect(p.gridAt(200, 95)).toBeUndefined();
    expect(p.gridAt(10, 250)).toBeUndefined();
  });

  it('inverts a pixel in grid 2 through grid 2s own axes', () => {
    const p = buildProjection(split, layout, axes, resolve);
    const g = p.gridAt(150, 250);
    expect(g).toBe(p.grids[2]);
    expect(g!.yToV(250, 'c')).toBeCloseTo(50);
    expect(g!.vToY(50, 'c')).toBeCloseTo(250);
    calls.length = 0;
    expect(g!.xToT(150)).toBe(100);
    expect(g!.tToX(100)).toBe(150);
    expect(calls).toEqual([2]);
    // Another grid's axis is unknown here.
    expect(g!.yToV(250, 'a')).toBeNaN();
  });

  it('takes a grid rect from the instance model when the layout gives none', () => {
    const withModel: ProjectionInstance = {
      ...split,
      getModel: () => ({
        getComponent: (type: string, i: number) =>
          type === 'grid'
            ? { coordinateSystem: { getRect: () => ({ x: 5, y: 6 + i, width: 7, height: 8 }) } }
            : undefined,
      }),
    };
    const p = buildProjection(withModel, { ...layout, gridRects: undefined }, axes, resolve);
    expect(p.grids[1].gridRect).toEqual({ left: 5, top: 7, width: 7, height: 8 });
  });
});

describe('buildProjection without a resolver', () => {
  it('returns one grid that is the top-level projection', () => {
    const p = buildProjection(
      {
        getWidth: () => 200,
        getHeight: () => 100,
        convertToPixel: (f, v) => ('yAxisIndex' in f ? v * 10 : v + 1),
        convertFromPixel: (f, px) => ('yAxisIndex' in f ? px / 10 : px - 1),
      },
      {
        axisIndexMap: new Map([['a', 0]]),
        gridTop: 10,
        gridBottom: 20,
        gridLeft: 30,
        gridRight: 40,
      },
      [{ id: 'a' }, { id: 'gone' }]
    );
    expect(p.grids).toHaveLength(1);
    expect(p.grids[0].axisIds).toEqual(['a']);
    expect(p.grids[0].gridRect).toEqual(p.gridRect);
    expect(p.gridOf('a')).toBe(p.grids[0]);
    expect(p.gridOf('gone')).toBeUndefined();
    expect(p.gridAt(30, 10)).toBe(p.grids[0]);
    expect(p.gridAt(29, 10)).toBeUndefined();
    expect(p.grids[0].tToX(5)).toBe(p.tToX(5));
  });
});
