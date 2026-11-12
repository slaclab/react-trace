// @vitest-environment jsdom
// Status line: the cursor time
// and primary-axis value under the plot, hidden by `showStatusLine: false`, and
// a pointer move re-renders only the line — never the plot's option build.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Axis, Plot } from '../types';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';
import type { FormulaSeriesResult } from '../hooks/useFormulaSeries';
import {
  createCursorStore,
  createProjectionStore,
  isPlotChrome,
  type Projection,
} from '../plot/geometry';
import { projectionOf } from '../plot/testUtils';
import { StatusLine } from './StatusLine';
import { CORRELATION_CATALOG, BUILTIN_CATALOG } from './catalog';
import type { GridProjection } from './catalog/types';
import { VALUE_X_AXIS, TIME_X_AXIS } from './catalog/xAxis';
import { EMBEDDED_UNSAVED_HINT, embeddedHintFor, toolHintIn } from './statusHints';

const { rendered } = vi.hoisted(() => ({ rendered: [] as unknown[] }));

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  const fakeInstance = {
    getWidth: () => 800,
    getHeight: () => 400,
    isDisposed: () => false,
    getZr: () => ({ setCursorStyle: () => {}, on: () => {}, off: () => {} }),
    getModel: () => null,
    convertToPixel: () => 0,
    convertFromPixel: () => 0,
    getDataURL: () => '',
    getDom: () => document.createElement('div'),
    resize: () => {},
    dispatchAction: () => {},
    on: () => {},
    off: () => {},
  };
  class MockECharts extends React.Component<{ option: unknown }> {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      // One entry per render = one buildPlotOption result handed to the chart.
      rendered.push(this.props.option);
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

import { SinglePlot } from '../components/PlotArea';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  rendered.length = 0;
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const T0 = new Date(2026, 9, 14, 12, 34, 56).getTime();

// A linear projection: x px -> T0 + x seconds; y px -> 100 - y on axis-1.
function fakeProjection(): Projection {
  return projectionOf({
    tToX: (t) => (t - T0) / 1000,
    xToT: (x) => T0 + x * 1000,
    vToY: (v, axisId) => (axisId === 'axis-1' ? 100 - v : NaN),
    yToV: (y, axisId) => (axisId === 'axis-1' ? 100 - y : NaN),
    gridRect: { left: 0, top: 0, width: 400, height: 200 },
    axisIds: ['axis-1'],
  });
}

function stores() {
  const projectionStore = createProjectionStore(fakeProjection);
  projectionStore.bump();
  return { projectionStore, cursorStore: createCursorStore() };
}

describe('StatusLine', () => {
  it('renders the formatted cursor time and primary-axis value', () => {
    const { projectionStore, cursorStore } = stores();
    const { container } = render(
      <StatusLine
        catalog={BUILTIN_CATALOG}
        xAxis={TIME_X_AXIS}
        cursorStore={cursorStore}
        projectionStore={projectionStore}
        primaryAxisId="axis-1"
      />
    );
    const line = container.querySelector('[data-status-line]') as HTMLElement;
    expect(line).not.toBeNull();
    expect(isPlotChrome(line)).toBe(true);
    expect(line.style.height).toBe('20px');
    expect(line.textContent?.trim()).toBe('');

    act(() => cursorStore.set({ x: 10, y: 25.5 }));
    expect(line.querySelector('[data-status-time]')?.textContent).toBe('2026-10-14 12:35:06');
    expect(line.querySelector('[data-status-value]')?.textContent).toBe('74.5');

    // Leaving the plot clears the readout.
    act(() => cursorStore.set(null));
    expect(line.querySelector('[data-status-time]')?.textContent).toBe('');
    expect(line.querySelector('[data-status-value]')?.textContent).toBe('');
  });

  it("reads the grid's first axis for a primary axis it does not draw, nothing outside it", () => {
    const { projectionStore, cursorStore } = stores();
    const { container } = render(
      <StatusLine
        catalog={BUILTIN_CATALOG}
        xAxis={TIME_X_AXIS}
        cursorStore={cursorStore}
        projectionStore={projectionStore}
        primaryAxisId="nope"
      />
    );
    act(() => cursorStore.set({ x: 10, y: 10 }));
    expect(container.querySelector('[data-status-time]')?.textContent).toBe('2026-10-14 12:35:06');
    expect(container.querySelector('[data-status-value]')?.textContent).toBe('90');
    act(() => cursorStore.set({ x: 500, y: 10 }));
    expect(container.querySelector('[data-status-time]')?.textContent).toBe('');
  });

  it('renders the tool and embedded hint slots', () => {
    const { projectionStore, cursorStore } = stores();
    const { container } = render(
      <StatusLine
        catalog={BUILTIN_CATALOG}
        xAxis={TIME_X_AXIS}
        cursorStore={cursorStore}
        projectionStore={projectionStore}
        toolHint="Line: drag to draw"
        embeddedHint="Drawings on this plot are not saved in the tile"
      />
    );
    expect(container.querySelector('[data-status-tool-hint]')?.textContent).toBe(
      'Line: drag to draw'
    );
    expect(container.querySelector('[data-status-embedded-hint]')?.textContent).toBe(
      'Drawings on this plot are not saved in the tile'
    );
  });
});

describe('StatusLine hints', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it.each([
    ['hline', 'Horizontal line: click to place'],
    ['vline', 'Vertical line: click to place'],
    ['note', 'Note: click to place, then type'],
    ['trend', 'Trend line: drag or click twice'],
    ['trange', 'Time range: drag or click twice'],
    ['box', 'Box: drag or click twice'],
    ['measure', 'Measure: shift-drag to measure'],
  ] as const)('the %s tool hints "%s"', (tool, hint) => {
    expect(toolHintIn(BUILTIN_CATALOG, tool, { xAxis: TIME_X_AXIS })).toBe(hint);
    const { projectionStore, cursorStore } = stores();
    const { container } = render(
      <StatusLine
        catalog={BUILTIN_CATALOG}
        xAxis={TIME_X_AXIS}
        cursorStore={cursorStore}
        projectionStore={projectionStore}
        tool={tool}
      />
    );
    expect(container.querySelector('[data-status-tool-hint]')?.textContent).toBe(hint);
  });

  it('shows no tool hint for the cursor or no tool', () => {
    expect(toolHintIn(BUILTIN_CATALOG, 'cursor', { xAxis: TIME_X_AXIS })).toBeNull();
    expect(toolHintIn(BUILTIN_CATALOG, undefined, { xAxis: TIME_X_AXIS })).toBeNull();
    const { projectionStore, cursorStore } = stores();
    const { container } = render(
      <StatusLine
        catalog={BUILTIN_CATALOG}
        xAxis={TIME_X_AXIS}
        cursorStore={cursorStore}
        projectionStore={projectionStore}
        tool="cursor"
      />
    );
    expect(container.querySelector('[data-status-tool-hint]')?.textContent).toBe('');
  });

  it('an explicit toolHint overrides the derived one', () => {
    const { projectionStore, cursorStore } = stores();
    const { container } = render(
      <StatusLine
        catalog={BUILTIN_CATALOG}
        xAxis={TIME_X_AXIS}
        cursorStore={cursorStore}
        projectionStore={projectionStore}
        tool="box"
        toolHint="custom"
      />
    );
    expect(container.querySelector('[data-status-tool-hint]')?.textContent).toBe('custom');
  });

  it('embeddedHintFor: only embedded and only off plot 0', () => {
    expect(embeddedHintFor(1, true)).toBe(EMBEDDED_UNSAVED_HINT);
    expect(embeddedHintFor(3, true)).toBe(EMBEDDED_UNSAVED_HINT);
    expect(embeddedHintFor(0, true)).toBeNull();
    expect(embeddedHintFor(undefined, true)).toBeNull();
    expect(embeddedHintFor(1, false)).toBeNull();
    expect(EMBEDDED_UNSAVED_HINT).toBe('Drawings on this plot are not saved in the tile');
  });

  it('embedded: the notice renders on plot 1 but not on plot 0', () => {
    window.history.replaceState(null, '', '/?embedded=true');
    const { projectionStore, cursorStore } = stores();
    const first = render(
      <StatusLine
        catalog={BUILTIN_CATALOG}
        xAxis={TIME_X_AXIS}
        cursorStore={cursorStore}
        projectionStore={projectionStore}
        plotIndex={0}
        embedded
      />
    );
    expect(first.container.querySelector('[data-status-embedded-hint]')).toBeNull();
    const second = render(
      <StatusLine
        catalog={BUILTIN_CATALOG}
        xAxis={TIME_X_AXIS}
        cursorStore={cursorStore}
        projectionStore={projectionStore}
        plotIndex={1}
        embedded
      />
    );
    expect(second.container.querySelector('[data-status-embedded-hint]')?.textContent).toBe(
      EMBEDDED_UNSAVED_HINT
    );
  });

  it('not embedded: no notice on any plot', () => {
    window.history.replaceState(null, '', '/');
    const { projectionStore, cursorStore } = stores();
    const { container } = render(
      <StatusLine
        catalog={BUILTIN_CATALOG}
        xAxis={TIME_X_AXIS}
        cursorStore={cursorStore}
        projectionStore={projectionStore}
        plotIndex={2}
      />
    );
    expect(container.querySelector('[data-status-embedded-hint]')).toBeNull();
  });
});

const AXIS: Axis = {
  id: 'axis-1',
  name: 'Y-Axis 1',
  orientation: 'left',
  autoScale: true,
  logScale: false,
  visible: true,
};

function plot(over: Partial<Plot> = {}): Plot {
  return {
    id: 'plot-1',
    title: 'Plot 1',
    traces: [],
    axes: [AXIS],
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
    ...over,
  };
}

const props = {
  archiveResults: new Map<string, ArchiveSeriesResult>(),
  liveResults: new Map<string, LiveSeriesResult>(),
  formulaResults: new Map<string, FormulaSeriesResult>(),
};

describe('SinglePlot status line', () => {
  it('mounts the line as a sibling below the plot wrapper', () => {
    const { container } = render(<SinglePlot plot={plot()} {...props} />);
    const wrap = container.querySelector('[data-plot-id="plot-1"]') as HTMLElement;
    const line = container.querySelector('[data-status-line]') as HTMLElement;
    expect(line).not.toBeNull();
    expect(wrap.contains(line)).toBe(false);
    expect(wrap.nextElementSibling).toBe(line);
    expect(wrap.parentElement?.style.flexDirection).toBe('column');
  });

  it('is hidden when showStatusLine is false', () => {
    const { container } = render(<SinglePlot plot={plot({ showStatusLine: false })} {...props} />);
    expect(container.querySelector('[data-plot-id="plot-1"]')).not.toBeNull();
    expect(container.querySelector('[data-status-line]')).toBeNull();
  });

  it('ten mousemoves cause zero extra buildPlotOption calls', () => {
    const { container } = render(<SinglePlot plot={plot()} {...props} />);
    const wrap = container.querySelector('[data-plot-id="plot-1"]') as HTMLElement;
    const before = rendered.length;
    expect(before).toBeGreaterThan(0);
    act(() => {
      for (let i = 0; i < 10; i++) {
        fireEvent.mouseMove(wrap, { clientX: 10 + i, clientY: 20 + i });
      }
    });
    act(() => {
      fireEvent.mouseLeave(wrap);
    });
    expect(rendered.length).toBe(before);
  });
});

// Two stacked grids: x px -> x on both; grid 0 (0..100 px
// high) draws 'a' with v = 100 - y, grid 1 (120..220 px) draws 'b' and 'c'
// with v = 220 - y.
function splitStores() {
  const grid = (top: number, axisIds: string[]): GridProjection => ({
    tToX: (t) => t,
    xToT: (x) => x,
    vToY: (v, id) => (axisIds.includes(id) ? top + 100 - v : NaN),
    yToV: (y, id) => (axisIds.includes(id) ? top + 100 - y : NaN),
    gridRect: { left: 0, top, width: 400, height: 100 },
    axisIds,
  });
  const g0 = grid(0, ['a']);
  const g1 = grid(120, ['b', 'c']);
  const projectionStore = createProjectionStore(() => projectionOf(g0, g1));
  projectionStore.bump();
  return { projectionStore, cursorStore: createCursorStore() };
}

describe('StatusLine through the catalog and grids', () => {
  it('formats x through the x-axis descriptor and reads the grid under the pointer', () => {
    const { projectionStore, cursorStore } = splitStores();
    const { container } = render(
      <StatusLine
        catalog={BUILTIN_CATALOG}
        cursorStore={cursorStore}
        projectionStore={projectionStore}
        primaryAxisId="a"
        xAxis={VALUE_X_AXIS}
      />
    );
    const text = (slot: string) => container.querySelector(`[data-status-${slot}]`)?.textContent;
    act(() => cursorStore.set({ x: 12.5, y: 40 }));
    expect(text('time')).toBe('12.5');
    expect(text('value')).toBe('60');
    // Grid 1 does not draw the primary axis: its first axis is read.
    act(() => cursorStore.set({ x: 30, y: 170 }));
    expect(text('time')).toBe('30');
    expect(text('value')).toBe('50');
    // Between the grids: no readout.
    act(() => cursorStore.set({ x: 30, y: 110 }));
    expect(text('time')).toBe('');
    expect(text('value')).toBe('');
  });

  it('reads the focus drawing axis in its grid', () => {
    const { projectionStore, cursorStore } = splitStores();
    const { container } = render(
      <StatusLine
        catalog={BUILTIN_CATALOG}
        cursorStore={cursorStore}
        projectionStore={projectionStore}
        primaryAxisId="a"
        focusAxisId="c"
        xAxis={VALUE_X_AXIS}
      />
    );
    act(() => cursorStore.set({ x: 30, y: 200 }));
    expect(container.querySelector('[data-status-value]')?.textContent).toBe('20');
    // Outside the focus grid the pointer's own grid is read.
    act(() => cursorStore.set({ x: 30, y: 25 }));
    expect(container.querySelector('[data-status-value]')?.textContent).toBe('75');
  });

  it('takes the tool hint from the catalog', () => {
    const { projectionStore, cursorStore } = stores();
    const { container, rerender } = render(
      <StatusLine
        xAxis={TIME_X_AXIS}
        cursorStore={cursorStore}
        projectionStore={projectionStore}
        tool="trange"
        catalog={CORRELATION_CATALOG}
      />
    );
    const hint = () => container.querySelector('[data-status-tool-hint]')?.textContent;
    expect(hint()).toBe('');
    rerender(
      <StatusLine
        xAxis={TIME_X_AXIS}
        cursorStore={cursorStore}
        projectionStore={projectionStore}
        tool="hline"
        catalog={CORRELATION_CATALOG}
      />
    );
    expect(hint()).toBe(toolHintIn(BUILTIN_CATALOG, 'hline', { xAxis: TIME_X_AXIS }));
  });
});
