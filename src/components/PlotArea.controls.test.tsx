// @vitest-environment jsdom
//
// The plot row's right-hand controls group. Standalone (and embedded without
// the host bar) it reads Tab view · Grid view · Add plot. Under the host bar
// the host's tile bar draws the verbs, the layout toggle among them, so only
// Add plot and the range controls stay. Alt+D still opens Data Insight
// through the workbench's shortcut listener (the trace `data-insight` action).
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { PlotArea } from './PlotArea';
import type { Plot } from '../types';
import {
  CanvasActionsProvider,
  createActionRegistry,
  useActionShortcuts,
  type ActionRegistry,
} from '../workbench/useCanvasActions';
import { useTraceCanvasActions, type TraceActionsOptions } from '../tools/trace/actions';
import { traceCapabilities } from '../tools/trace/capabilities';

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  const fake = {
    getWidth: () => 800,
    getHeight: () => 400,
    isDisposed: () => false,
    getZr: () => ({ setCursorStyle: () => {} }),
    getModel: () => ({
      getComponent: () => ({ axis: { scale: { getExtent: (): [number, number] => [0, 100] } } }),
    }),
    convertToPixel: () => 0,
    convertFromPixel: () => 0,
    getOption: () => ({}),
    setOption: () => {},
    dispatchAction: () => {},
    on: () => {},
    off: () => {},
    resize: () => {},
  };
  class MockECharts extends React.Component {
    getEchartsInstance() {
      return fake;
    }
    render() {
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makePlot(id: string): Plot {
  return {
    id,
    title: `Plot ${id}`,
    traces: [],
    axes: [
      {
        id: 'ax1',
        name: 'Y',
        orientation: 'left',
        autoScale: true,
        logScale: false,
        visible: true,
      },
    ],
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

interface Mount {
  viewMode: 'tabs' | 'grid';
  hostBar?: boolean;
  onSetViewMode?: Mock<(m: 'tabs' | 'grid') => void>;
  onAddPlot?: Mock<() => void>;
}

function area({ viewMode, hostBar, onSetViewMode, onAddPlot }: Mount) {
  return (
    <PlotArea
      plots={[makePlot('p1'), makePlot('p2')]}
      activePlotId="p1"
      viewMode={viewMode}
      archiveResultsByPlot={new Map()}
      liveResultsByPlot={new Map()}
      formulaResultsByPlot={new Map()}
      onSetActivePlot={vi.fn()}
      onAddPlot={onAddPlot ?? vi.fn()}
      onRemovePlot={vi.fn()}
      onSetViewMode={onSetViewMode ?? vi.fn()}
      onPopOutPlot={vi.fn()}
      detachedPlotIds={[]}
      onDetachPlot={vi.fn()}
      onReattachPlot={vi.fn()}
      displayWindowByPlotId={new Map()}
      hostBar={hostBar}
    />
  );
}

/** The controls group's own buttons (RangeControls' chips sit in their own site). */
function controlTitles(container: HTMLElement): string[] {
  const group = container.querySelector('.plot-tab-bar__controls')!;
  expect(group).not.toBeNull();
  return [...group.children]
    .filter((el): el is HTMLButtonElement => el.tagName === 'BUTTON')
    .map((b) => b.getAttribute('title') ?? '');
}

function button(container: HTMLElement, title: string): HTMLButtonElement {
  const group = container.querySelector('.plot-tab-bar__controls')!;
  const b = [...group.children].find(
    (el) => el.tagName === 'BUTTON' && el.getAttribute('title') === title
  );
  expect(b, `button titled ${title}`).toBeDefined();
  return b as HTMLButtonElement;
}

describe('plot row controls, standalone', () => {
  it.each(['tabs', 'grid'] as const)('%s view: Tab view · Grid view · Add plot', (viewMode) => {
    const { container } = render(area({ viewMode }));
    expect(controlTitles(container)).toEqual(['Tab view', 'Grid view', 'Add plot']);
  });

  it('keeps the active modifier on the current mode and the pair sets each mode', () => {
    const onSetViewMode = vi.fn<(m: 'tabs' | 'grid') => void>();
    const { container } = render(area({ viewMode: 'tabs', onSetViewMode }));
    expect(button(container, 'Tab view').className).toBe(
      'canopy-btn view-mode-btn view-mode-btn--active'
    );
    expect(button(container, 'Grid view').className).toBe('canopy-btn view-mode-btn');
    fireEvent.click(button(container, 'Grid view'));
    fireEvent.click(button(container, 'Tab view'));
    expect(onSetViewMode.mock.calls).toEqual([['grid'], ['tabs']]);
  });

  it('defaults to standalone when hostBar is absent', () => {
    const { container } = render(
      <PlotArea
        plots={[makePlot('p1')]}
        activePlotId="p1"
        viewMode="tabs"
        archiveResultsByPlot={new Map()}
        liveResultsByPlot={new Map()}
        formulaResultsByPlot={new Map()}
        onSetActivePlot={vi.fn()}
        onAddPlot={vi.fn()}
        onRemovePlot={vi.fn()}
        onSetViewMode={vi.fn()}
        onPopOutPlot={vi.fn()}
        detachedPlotIds={[]}
        onDetachPlot={vi.fn()}
        onReattachPlot={vi.fn()}
        displayWindowByPlotId={new Map()}
      />
    );
    expect(controlTitles(container)).toEqual(['Tab view', 'Grid view', 'Add plot']);
  });
});

describe('plot row controls, under the host bar', () => {
  it.each(['tabs', 'grid'] as const)('%s view: no verbs in-frame, Add plot stays', (viewMode) => {
    const { container } = render(area({ viewMode, hostBar: true }));
    expect(controlTitles(container)).toEqual(['Add plot']);
  });

  it('keeps the range controls in the tab view', () => {
    const { container } = render(area({ viewMode: 'tabs', hostBar: true }));
    expect(container.querySelector('[data-range-site="tab"]')).not.toBeNull();
  });
});

describe('Alt+D still opens Data Insight under the host bar', () => {
  function Shortcuts({ registry }: { registry: ActionRegistry }) {
    useActionShortcuts(registry, { hostBar: true });
    return null;
  }

  it('runs the trace data-insight action with the actions bar absent', () => {
    const inspect = vi.fn<() => void>();
    const options: TraceActionsOptions = {
      handlers: {
        refreshArchive: vi.fn(),
        dataInsight: inspect,
        postElog: vi.fn(),
        save: vi.fn(),
        print: vi.fn(),
        import: vi.fn(),
        exportCsv: vi.fn(),
        exportPng: vi.fn(),
      },
      capabilities: traceCapabilities({ elog: true }),
      embedded: true,
      hostBar: true,
      bugUrl: 'https://example.test/bug',
      docsUrl: 'https://example.test/docs',
      viewMode: { grid: false, toggle: vi.fn() },
    };
    function Canvas() {
      useTraceCanvasActions(options);
      return area({ viewMode: 'tabs', hostBar: true });
    }
    const registry = createActionRegistry();
    render(
      <CanvasActionsProvider registry={registry}>
        <Shortcuts registry={registry} />
        <Canvas />
      </CanvasActionsProvider>
    );
    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', altKey: true });
    expect(inspect).toHaveBeenCalledTimes(1);
  });
});
