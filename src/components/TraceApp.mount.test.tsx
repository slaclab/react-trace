// @vitest-environment jsdom
//
// TraceApp opens from the page query: the CANOPY preset mounts one plot with
// three archive + live traces, and no query mounts one empty plot. Network is
// stubbed (fetch never settles, WebSocket is inert) and echarts is mocked so
// the chart option each plot renders can be inspected.
//
// The tooltip is HTML, so a PV name or display name such as `<img ...>` must be
// escaped there while the legend (drawn as text by echarts) keeps it raw, and a
// trace color that is not a plain color literal is never interpolated.
//
// On the workbench: standalone and embedded,
// Trace is one sidebar (Layers + Properties) beside the plot canvas, under
// the actions bar — no brand header, no Live/Archive counts, no side
// panels.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TESTIDS } from '../workbench/testids';
import type { Axis, Plot, PVTrace } from '../types';

type ChartOption = {
  legend: { data: (string | undefined)[] };
  series: { name?: string }[];
  tooltip: { formatter: (params: { axisValue: number }[]) => string };
};

const { rendered } = vi.hoisted(() => ({ rendered: [] as ChartOption[] }));

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
  class MockECharts extends React.Component<{ option: ChartOption }> {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      rendered.push(this.props.option);
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

import { TraceApp } from './TraceApp';
import { SinglePlot } from './PlotArea';
import { WithCanopy } from '../test/canopy';

const PRESET =
  'pv=TEST:DIAG:BPM:01:POSITION:X&pv=TEST:DIAG:BPM:02:POSITION:X&pv=TEST:DIAG:BPM:03:POSITION:X&range=-1h';
const PRESET_PVS = [
  'TEST:DIAG:BPM:01:POSITION:X',
  'TEST:DIAG:BPM:02:POSITION:X',
  'TEST:DIAG:BPM:03:POSITION:X',
];
const XSS = '<img src=x onerror=alert(1)>';

/** Opens a plot-wide section of the properties panel (they start closed). */
function openPlotSection(id: string) {
  const head = document.querySelector<HTMLElement>(
    `.wb-plot-section[data-section="${id}"] .wb-plot-section__head`
  );
  if (!head) throw new Error(`no plot section ${id}`);
  fireEvent.click(head);
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class InertWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: InertWebSocket[] = [];
  readyState = 0;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    InertWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  addEventListener() {}
  removeEventListener() {}
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  rendered.length = 0;
  window.localStorage.clear();
  InertWebSocket.instances = [];
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  );
  fetchMock = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', InertWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

function mountAt(url: string) {
  window.history.replaceState(null, '', url);
  return render(<TraceApp />, { wrapper: WithCanopy });
}

function lastOption(): ChartOption {
  expect(rendered.length).toBeGreaterThan(0);
  return rendered[rendered.length - 1];
}

function tooltipHtml(option: ChartOption): string {
  return option.tooltip.formatter([{ axisValue: Date.now() }]);
}

describe('TraceApp mount', () => {
  it('opens the preset query as one plot with three traces', () => {
    mountAt(`/trace/?${PRESET}&embedded=true`);
    for (const pv of PRESET_PVS) expect(screen.getAllByText(pv).length).toBeGreaterThan(0);
    expect(lastOption().legend.data).toEqual(PRESET_PVS);
  });

  it('opens the axes and options a plot config in the query names', () => {
    const plot = encodeURIComponent(
      JSON.stringify({
        v: 1,
        showLegend: false,
        axes: [
          { name: 'Position' },
          {
            name: 'Current',
            orientation: 'right',
            logScale: true,
            autoScale: false,
            min: 0.1,
            max: 100,
          },
        ],
        traces: [{}, { axis: 1 }],
      })
    );
    mountAt(`/trace/?${PRESET}&plot=${plot}&embedded=true`);
    const option = lastOption() as ChartOption & {
      legend: { show: boolean };
      yAxis: { type: string; name: string; position: string; min?: number; max?: number }[];
    };
    expect(option.legend.show).toBe(false);
    expect(option.yAxis.map((a) => [a.name, a.type, a.position, a.min, a.max])).toEqual([
      ['Position', 'value', 'left', undefined, undefined],
      ['Current', 'log', 'right', 0.1, 100],
    ]);
  });

  it('opens one empty plot without a query', () => {
    mountAt('/trace/');
    expect(lastOption().legend.data).toEqual([]);
    expect(screen.queryByText('TEST:TEST:31:KVAC')).toBeNull();
    expect(screen.getAllByText('Plot 1').length).toBeGreaterThan(0);
  });

  it('escapes a markup PV name in the tooltip and keeps it raw in the legend', () => {
    const { container } = mountAt(`/trace/?pv=${encodeURIComponent(XSS)}&range=-1h`);
    const option = lastOption();
    expect(option.legend.data).toEqual([XSS]);
    const html = tooltipHtml(option);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(container.querySelector('img')).toBeNull();
  });
});

const SAVE_IMPORT_PRINT = [/^save/i, /^import/i, /^print/i];

describe('TraceApp on the workbench', () => {
  for (const embedded of [false, true]) {
    const mode = embedded ? 'embedded' : 'standalone';

    it(`${mode}: one sidebar beside the plot canvas, no brand header or counts`, () => {
      const { container } = mountAt(`/trace/?${PRESET}${embedded ? '&embedded=true' : ''}`);
      expect(container.querySelectorAll('.wb-workbench')).toHaveLength(1);
      expect(container.querySelectorAll('.wb-sidebar')).toHaveLength(1);
      // The plot is the canvas slot.
      const canvas = container.querySelector('.wb-workbench__canvas');
      expect(canvas?.querySelector('.plot-area')).not.toBeNull();
      // The retired chrome is gone.
      expect(container.querySelector('header')).toBeNull();
      expect(container.querySelector('.cds--header')).toBeNull();
      expect(screen.queryByText('TRACE')).toBeNull();
      expect(container.querySelector('.trace-header__counts')).toBeNull();
      expect(screen.queryByText(/\bLive\b.*\bArchive\b/)).toBeNull();
      expect(container.querySelector('.layers-panel, .properties-panel')).toBeNull();
      expect(container.querySelector('.trace-resize-handle')).toBeNull();
      // One properties panel: the Signals list, then the plot-wide sections.
      const panel = container.querySelector('.wb-sidebar .wb-panel');
      expect(panel?.getAttribute('aria-label')).toBe('Plot properties');
      expect(panel?.querySelector('.wb-group[data-group="signals"]')).not.toBeNull();
      expect(
        [...(panel?.querySelectorAll<HTMLElement>('.wb-plot-section') ?? [])].map(
          (s) => s.dataset.section
        )
      ).toEqual(['acquisition', 'axes', 'display', 'statistics']);
    });

    it(`${mode}: the actions bar carries Save, Import and Print`, () => {
      mountAt(`/trace/?${PRESET}${embedded ? '&embedded=true' : ''}`);
      const bar = screen.getByTestId(TESTIDS.actionsBar);
      for (const name of SAVE_IMPORT_PRINT) {
        expect(within(bar).getByRole('button', { name })).toBeTruthy();
      }
    });
  }

  it('under the host bar: no actions bar; the workbench still renders', () => {
    const { container } = mountAt(`/trace/?${PRESET}&embedded=true&hostbar=1`);
    expect(screen.queryByTestId(TESTIDS.actionsBar)).toBeNull();
    expect(container.querySelector('.wb-workbench__actions')).toBeNull();
    expect(container.querySelectorAll('.wb-sidebar')).toHaveLength(1);
  });

  it('under the host bar: Ctrl+P still prints with the bar absent', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    mountAt(`/trace/?${PRESET}&embedded=true&hostbar=1`);
    const event = new KeyboardEvent('keydown', {
      key: 'p',
      code: 'KeyP',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    // Print captures the on-screen plots first, then opens the dialog.
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it('lists the curves of the active plot under Signals and opens the first card', () => {
    const { container } = mountAt(`/trace/?${PRESET}&embedded=true`);
    const rows = [...container.querySelectorAll('.wb-outline-row')].map((r) => r.textContent);
    expect(rows).toHaveLength(3);
    PRESET_PVS.forEach((pv, i) => expect(rows[i]).toContain(pv));
    // The opening selection opens the first curve's card.
    const open = container.querySelectorAll('.wb-card--open');
    expect(open).toHaveLength(1);
    const pvName = open[0].querySelector<HTMLInputElement>('#pv-name');
    expect(pvName?.value).toBe(PRESET_PVS[0]);
  });

  it('opens no card when the plot has no curve; the plot fields are in its sections', () => {
    const { container } = mountAt('/trace/');
    expect(container.querySelector('.wb-card--open')).toBeNull();
    expect(document.getElementById('plot-title')).toBeNull();
    openPlotSection('display');
    expect(document.getElementById('plot-title')).not.toBeNull();
  });

  it('re-roots Layers on the plot made active on the canvas', () => {
    mountAt(`/trace/?${PRESET}&embedded=true`);
    expect(document.querySelectorAll('.wb-outline-row')).toHaveLength(3);
    act(() => {
      fireEvent.click(screen.getByTitle(/add plot/i));
    });
    // The new plot is active: its Layers hold no curve.
    expect(document.querySelectorAll('.wb-outline-row')).toHaveLength(0);
  });

  it('picking a time range turns autoscroll back on, as before', () => {
    mountAt('/trace/');
    openPlotSection('axes');
    const autoscroll = () => document.getElementById('autoscroll') as HTMLButtonElement;
    act(() => {
      fireEvent.click(autoscroll());
    });
    expect(autoscroll().getAttribute('aria-checked')).toBe('false');
    act(() => {
      fireEvent.change(document.getElementById('time-range') as HTMLSelectElement, {
        target: { value: '-4h' },
      });
    });
    expect(autoscroll().getAttribute('aria-checked')).toBe('true');
  });

  it('Create formula from this curve adds a formula on it and selects it', () => {
    const { container } = mountAt(`/trace/?pv=TEST:DCCT&range=-1h`);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /create formula from this curve/i }));
    });
    const rows = [...container.querySelectorAll('.wb-outline-row')].map((r) => r.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('f(TEST:DCCT)');
    // The formula is selected: Properties shows its expression.
    const expression = document.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(expression?.value).toBe('{x1}');
  });

  it('Inspect data opens the Data Insight dock on the curve', () => {
    const { container } = mountAt(`/trace/?pv=TEST:DCCT&range=-1h`);
    expect(container.querySelector('.insight-dock')).toBeNull();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /inspect data/i }));
    });
    expect(container.querySelector('.wb-workbench__canvas .insight-dock')).not.toBeNull();
  });
});

function makeTrace(overrides: Partial<PVTrace> = {}): PVTrace {
  return {
    id: 't1',
    pvName: 'TEST:DCCT',
    displayName: '',
    color: '#0f62fe',
    visible: true,
    axisId: 'ax1',
    useLive: false,
    useArchive: false,
    lineWidth: 2,
    lineType: 'step',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'circle',
    symbolSize: 10,
    data: [],
    ...overrides,
  };
}

function makePlot(traces: PVTrace[]): Plot {
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
    traces,
    axes: [axis],
    backgroundColor: 'default',
    showLegend: true,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
  };
}

function renderPlot(traces: PVTrace[]): ChartOption {
  render(
    <SinglePlot
      plot={makePlot(traces)}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
    />,
    { wrapper: WithCanopy }
  );
  return lastOption();
}

describe('SinglePlot tooltip HTML', () => {
  it('escapes a markup display name and keeps it raw in legend and series', () => {
    const option = renderPlot([makeTrace({ displayName: XSS })]);
    expect(option.legend.data).toEqual([XSS]);
    expect(option.series.some((s) => s.name === XSS)).toBe(true);
    const html = tooltipHtml(option);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });

  it('keeps a hex or rgb(a) color', () => {
    expect(tooltipHtml(renderPlot([makeTrace({ color: '#0f62fe' })]))).toContain(
      '<span style="color:#0f62fe">TEST:DCCT</span>'
    );
    cleanup();
    expect(tooltipHtml(renderPlot([makeTrace({ color: 'rgba(15, 98, 254, 0.5)' })]))).toContain(
      '<span style="color:rgba(15, 98, 254, 0.5)">TEST:DCCT</span>'
    );
  });

  it('does not interpolate a color containing a quote', () => {
    const evil = '#fff" onmouseover="alert(1)';
    const html = tooltipHtml(renderPlot([makeTrace({ color: evil })]));
    expect(html).not.toContain('onmouseover');
    expect(html).toContain('<span>TEST:DCCT</span>');
  });
});
