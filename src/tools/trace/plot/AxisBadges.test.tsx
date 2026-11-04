// @vitest-environment jsdom
//
// Axis auto-scale badges. Pins: a badge appears only over a manually scaled axis and
// one click re-enables auto-scale with exactly one write and no min/max; plot
// chrome (`data-axis-badge`, `data-drawing-rail`) never starts a Y-band
// gesture; double-click on a Y band re-enables auto-scale; and capturePlotPng
// still finds the ECharts instance as the wrapper's first child with badges
// mounted. Mounts SinglePlot with the hoisted fake-instance pattern of
// PlotArea.axisInteractions.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { SinglePlot } from '../../../components/PlotArea';
import { capturePlotPng } from '../../../capturePlot';
import { drawingThemeFor } from '../../../annotationTheme';
import type { Axis, Plot } from '../../../types';
import { AXIS_BADGE_SIZE, AxisBadges } from './AxisBadges';
import { createProjectionStore, type Projection } from '../../../plot/geometry';
import { projectionOf } from '../../../plot/testUtils';

// 800x400 canvas, grid insets top 40 / bottom 60 / left 70 / right 20 (one
// left axis): the y-axis spans pixels 340 (value 0) to 40 (value 100).
const { fakeInstance } = vi.hoisted(() => {
  const isX = (f: unknown) => typeof f === 'object' && f !== null && 'xAxisIndex' in f;
  const fakeInstance = {
    getWidth: () => 800,
    getHeight: () => 400,
    getDom: () => ({}),
    isDisposed: () => false,
    getZr: () => ({ setCursorStyle: () => {} }),
    getModel: () => ({
      getComponent: () => ({ axis: { scale: { getExtent: (): [number, number] => [0, 100] } } }),
    }),
    getDataURL: () => 'data:image/png;base64,FAKE',
    convertToPixel: (f: unknown, v: number) => (isX(f) ? 70 + v : 340 - (v / 100) * 300),
    convertFromPixel: (f: unknown, px: number) => (isX(f) ? px - 70 : ((340 - px) / 300) * 100),
  };
  return { fakeInstance };
});

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      return React.createElement('div', { 'data-mock-echarts': '' });
    }
  }
  return { default: MockECharts };
});

// capturePlotPng resolves the instance from the `[data-chart-host] > div`; the
// fake answers only for the element the (mocked) chart rendered.
vi.mock('echarts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('echarts')>();
  return {
    ...actual,
    getInstanceByDom: (el: HTMLElement) =>
      el.hasAttribute('data-mock-echarts') ? fakeInstance : undefined,
  };
});

function makeAxis(extra: Partial<Axis> = {}): Axis {
  return {
    id: 'ax1',
    name: 'Y',
    orientation: 'left',
    autoScale: true,
    logScale: false,
    visible: true,
    ...extra,
  };
}

function makePlot(axes: Axis[] = [makeAxis()]): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [],
    axes,
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

const MANUAL = makeAxis({ autoScale: false, min: 0, max: 100 });

function mountPlot(plot: Plot) {
  const onUpdateAxis = vi.fn();
  const { container, unmount } = render(
    <SinglePlot
      plot={plot}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
      onUpdateAxis={onUpdateAxis}
    />
  );
  const wrap = container.querySelector('[data-plot-id="p1"]') as HTMLElement;
  return { container, wrap, onUpdateAxis, unmount };
}

// --- animation frames, flushed by hand ---------------------------------------

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;

function flushFrames() {
  act(() => {
    for (let round = 0; round < 5 && frames.size > 0; round++) {
      const due = [...frames.values()];
      frames = new Map();
      due.forEach((cb) => cb(performance.now()));
    }
  });
}

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// jsdom reports a 0,0 bounding rect for the wrapper, so clientX/clientY ARE
// canvas-pixel coordinates. x 30 / y 200 is inside the left Y band.
const BAND = { clientX: 30, clientY: 200 };

/** A press on `target` followed by a 100 px window drag and release. */
function dragFrom(target: Element) {
  fireEvent.mouseDown(target, { ...BAND, button: 0 });
  fireEvent.mouseMove(window, { clientX: 30, clientY: 300, buttons: 1 });
  flushFrames();
  fireEvent.mouseUp(window);
  flushFrames();
}

describe('badge visibility', () => {
  it('shows no badge while the axis is auto-scaled', () => {
    const { container, unmount } = mountPlot(makePlot());
    expect(container.querySelector('[data-axis-badge]')).toBeNull();
    unmount();
  });

  it('shows one badge over a manually scaled axis, centred on its axis line above the grid', () => {
    const { container, unmount } = mountPlot(makePlot([MANUAL]));
    const badges = container.querySelectorAll<HTMLElement>('[data-axis-badge]');
    expect(badges).toHaveLength(1);
    expect(badges[0].dataset.axisBadge).toBe('ax1');
    expect(badges[0].textContent).toBe('A');
    // Axis line at grid left (70); badge sits above grid top (40).
    expect(badges[0].style.left).toBe(`${70 - AXIS_BADGE_SIZE / 2}px`);
    expect(parseFloat(badges[0].style.top)).toBeLessThan(40);
    unmount();
  });

  it('badges only the manual axes of a multi-axis plot', () => {
    const plot = makePlot([
      MANUAL,
      makeAxis({ id: 'ax2', orientation: 'right' }),
      makeAxis({ id: 'ax3', orientation: 'right', autoScale: false, min: 1, max: 2 }),
    ]);
    const { container, unmount } = mountPlot(plot);
    const ids = [...container.querySelectorAll<HTMLElement>('[data-axis-badge]')].map(
      (b) => b.dataset.axisBadge
    );
    expect(ids).toEqual(['ax1', 'ax3']);
    unmount();
  });
});

describe('badge click', () => {
  beforeEach(() => vi.clearAllMocks());

  it('produces exactly one onUpdateAxis({ autoScale: true }) and no min/max commit', () => {
    const { container, onUpdateAxis, unmount } = mountPlot(makePlot([MANUAL]));
    const badge = container.querySelector('[data-axis-badge]')!;
    // A real click: press, release, click.
    fireEvent.pointerDown(badge, { ...BAND, button: 0 });
    fireEvent.mouseDown(badge, { ...BAND, button: 0 });
    fireEvent.mouseUp(badge, BAND);
    fireEvent.mouseUp(window);
    fireEvent.click(badge, BAND);
    flushFrames();
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).toHaveBeenCalledWith('ax1', { autoScale: true });
    unmount();
  });

  it('a press-and-drag that starts on the badge never stretches the axis', () => {
    const { container, onUpdateAxis, unmount } = mountPlot(makePlot([MANUAL]));
    dragFrom(container.querySelector('[data-axis-badge]')!);
    expect(onUpdateAxis).not.toHaveBeenCalled();
    unmount();
  });

  it('stops native pointerdown/mousedown propagation', () => {
    const { container, wrap, unmount } = mountPlot(makePlot([MANUAL]));
    const seen: string[] = [];
    const record = (e: Event) => seen.push(e.type);
    wrap.addEventListener('pointerdown', record);
    wrap.addEventListener('mousedown', record);
    const badge = container.querySelector('[data-axis-badge]')!;
    fireEvent.pointerDown(badge, BAND);
    fireEvent.mouseDown(badge, BAND);
    expect(seen).toEqual([]);
    unmount();
  });

  it('a wheel or double-click on the badge writes nothing', () => {
    const { container, onUpdateAxis, unmount } = mountPlot(makePlot([MANUAL]));
    const badge = container.querySelector('[data-axis-badge]')!;
    fireEvent.wheel(badge, { ...BAND, deltaY: 100 });
    fireEvent.dblClick(badge, BAND);
    flushFrames();
    expect(onUpdateAxis).not.toHaveBeenCalled();
    unmount();
  });
});

describe('plot chrome never starts a Y-band gesture', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['data-drawing-rail', 'data-status-line', 'data-axis-badge'])(
    'a mousedown on an element tagged %s over an auto-scaled band produces zero onUpdateAxis',
    (attr) => {
      const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
      const chrome = document.createElement('div');
      chrome.setAttribute(attr, '');
      const inner = document.createElement('span');
      chrome.appendChild(inner);
      wrap.appendChild(chrome);
      dragFrom(inner);
      expect(onUpdateAxis).not.toHaveBeenCalled();
      unmount();
    }
  );

  it('control: the same drag on the bare band does freeze and stretch the axis', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    dragFrom(wrap);
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis.mock.calls[0][1]).toMatchObject({ autoScale: false });
    unmount();
  });

  it('a double-click on chrome over a manual band writes nothing', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot([MANUAL]));
    const rail = document.createElement('div');
    rail.setAttribute('data-drawing-rail', '');
    wrap.appendChild(rail);
    fireEvent.dblClick(rail, BAND);
    expect(onUpdateAxis).not.toHaveBeenCalled();
    unmount();
  });
});

describe('double-click on a Y band', () => {
  beforeEach(() => vi.clearAllMocks());

  it('re-enables auto-scale on a manually scaled axis', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot([MANUAL]));
    // The browser's sequence: two presses with no movement, then dblclick.
    fireEvent.mouseDown(wrap, { ...BAND, button: 0 });
    fireEvent.mouseUp(window);
    fireEvent.mouseDown(wrap, { ...BAND, button: 0 });
    fireEvent.mouseUp(window);
    fireEvent.dblClick(wrap, BAND);
    flushFrames();
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).toHaveBeenCalledWith('ax1', { autoScale: true });
    unmount();
  });

  it('writes nothing when the axis is already auto-scaled', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot());
    fireEvent.dblClick(wrap, BAND);
    expect(onUpdateAxis).not.toHaveBeenCalled();
    unmount();
  });

  it('inside the grid returns every manual axis to auto-scale', () => {
    const { wrap, onUpdateAxis, unmount } = mountPlot(makePlot([MANUAL]));
    fireEvent.dblClick(wrap, { clientX: 400, clientY: 200 });
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).toHaveBeenCalledWith(MANUAL.id, { autoScale: true });
    unmount();
  });
});

describe('PNG capture with badges mounted', () => {
  it('capturePlotPng still finds the ECharts instance', async () => {
    const plot = makePlot([MANUAL]);
    const { wrap, unmount } = mountPlot(plot);
    expect(wrap.querySelector('[data-axis-badge]')).not.toBeNull();
    // Capture resolves the chart through [data-chart-host], not by position
    //, so badge chrome around it cannot hide the instance.
    expect(wrap.querySelector('[data-chart-host] > div')?.hasAttribute('data-mock-echarts')).toBe(
      true
    );
    // Hide-all skips the overlay compose, which needs a decoding Image that
    // jsdom lacks (compose is covered in capture.test.ts); what is under test
    // here is that the instance is found.
    await expect(capturePlotPng(plot, 'dark', false, true)).resolves.toBe(
      'data:image/png;base64,FAKE'
    );
    unmount();
  });
});

describe('AxisBadges standalone', () => {
  const projection = (): Projection =>
    projectionOf({
      tToX: () => NaN,
      xToT: () => NaN,
      vToY: () => NaN,
      yToV: () => NaN,
      gridRect: { left: 150, top: 40, width: 500, height: 300 },
      axisIds: [],
    });
  const layout = {
    sideIndexMap: new Map([
      ['l0', 0],
      ['l1', 1],
      ['r0', 0],
      ['r1', 1],
    ]),
    gridRight: 150,
    axisOffset: 80,
  };
  const axis = (id: string, orientation: 'left' | 'right') => ({
    id,
    name: id,
    orientation,
    autoScale: false,
  });

  it('renders nothing until a projection is published, then follows it', () => {
    const store = createProjectionStore(projection);
    const { container } = render(
      <AxisBadges
        projectionStore={store}
        axes={[axis('l0', 'left')]}
        layout={layout}
        theme={drawingThemeFor('dark')}
        onUpdateAxis={() => {}}
      />
    );
    expect(container.querySelector('[data-axis-badge]')).toBeNull();
    act(() => store.bump());
    expect(container.querySelector('[data-axis-badge]')).not.toBeNull();
  });

  it('places stacked left and right axes on their own axis lines', () => {
    const store = createProjectionStore(projection);
    store.bump();
    const { container } = render(
      <AxisBadges
        projectionStore={store}
        axes={[axis('l0', 'left'), axis('l1', 'left'), axis('r0', 'right'), axis('r1', 'right')]}
        layout={layout}
        theme={drawingThemeFor('dark')}
        onUpdateAxis={() => {}}
      />
    );
    const left = (id: string) =>
      (container.querySelector(`[data-axis-badge="${id}"]`) as HTMLElement).style.left;
    const half = AXIS_BADGE_SIZE / 2;
    expect(left('l0')).toBe(`${150 - half}px`);
    expect(left('l1')).toBe(`${70 - half}px`);
    expect(left('r0')).toBe(`${650 - half}px`);
    expect(left('r1')).toBe(`${730 - half}px`);
  });

  it('renders nothing without an onUpdateAxis writer', () => {
    const store = createProjectionStore(projection);
    store.bump();
    const { container } = render(
      <AxisBadges
        projectionStore={store}
        axes={[axis('l0', 'left')]}
        layout={layout}
        theme={drawingThemeFor('dark')}
      />
    );
    expect(container.querySelector('[data-axis-badge]')).toBeNull();
  });
});
