// @vitest-environment jsdom
//
// Embedded mode (`?embedded=true`) runs inside the CANOPY workspace, which
// relays the Formula Engine's validate and evaluate POSTs. The formula
// controls work embedded: the Layers footer's Add formula adds a formula
// curve and the curve's Create formula from this curve in Properties is
// enabled — a formula is validated through the Formula Engine at the Canopy
// base (`canopyConnection`, so under a gateway prefix too), and an imported
// workspace keeps its formula curves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { useState, type ReactNode } from 'react';
import { CanopyProvider } from '@slaclab/canopy-react';
import { canopyConnection } from '../api/connection';
import { drawingThemeFor } from '../annotationTheme';
import { DEFAULT_PALETTE_ID, getPalette } from '../palettes';
import type { Axis, Plot, PVTrace } from '../types';
import { useTraceCapabilities } from '../tools/trace/capabilities';
import { FORMULA_CURVE_ITEM_KIND } from '../tools/trace/schema/formula';
import { useTraceDefinition, type TraceModel, type TraceState } from '../tools/trace/tool';
import { createSelectionStore } from '../workbench/selection';
import { TESTIDS } from '../workbench/testids';
import { WorkbenchLayout } from '../workbench/WorkbenchLayout';

const { importFile } = vi.hoisted(() => ({ importFile: { current: null as File | null } }));

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
    resize: () => {},
    dispatchAction: () => {},
    on: () => {},
    off: () => {},
  };
  class MockECharts extends React.Component {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

vi.mock('../io/download', async (orig) => {
  const actual = await orig<typeof import('../io/download')>();
  return { ...actual, pickFile: async () => importFile.current };
});

import { TraceApp } from './TraceApp';

/** The app's own connection (main.tsx): its base follows the page, as deployed. */
function AppCanopy({ children }: { children: ReactNode }) {
  return <CanopyProvider connection={canopyConnection}>{children}</CanopyProvider>;
}

function makeTrace(overrides: Partial<PVTrace> = {}): PVTrace {
  return {
    id: 't1',
    pvName: 'TEST:DCCT',
    displayName: 'Beam current',
    color: '#0f62fe',
    visible: true,
    axisId: 'ax1',
    useLive: false,
    useArchive: false,
    lineWidth: 1,
    lineType: 'step',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'none',
    symbolSize: 4,
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
    backgroundColor: '#ffffff',
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '1h' },
  };
}

function setEmbedded(on: boolean) {
  window.history.replaceState(null, '', on ? '/trace/?embedded=true' : '/');
}

/** TraceApp with one PV curve (opened from the query, so Properties holds it). */
function mountTraceWithCurve(embedded: boolean) {
  const query = `pv=TEST:DCCT&range=-1h${embedded ? '&embedded=true' : ''}`;
  window.history.replaceState(null, '', `/trace/?${query}`);
  return render(<TraceApp />, { wrapper: AppCanopy });
}

/**
 * A Trace workbench holding `plot`, with the formula `f1` selected, and the
 * capability record the mounted tool computes for the current page.
 */
function FormulaWorkbench({ plot }: { plot: Plot }) {
  const [state, setState] = useState<TraceState>({ plots: [plot], activePlotId: plot.id });
  const [selection] = useState(() =>
    createSelectionStore({ initial: { level: 'item', kind: FORMULA_CURVE_ITEM_KIND, id: 'f1' } })
  );
  const capabilities = useTraceCapabilities();
  const model: TraceModel = {
    palette: getPalette(DEFAULT_PALETTE_ID),
    fragmentInput: (p) => ({
      plot: p,
      archiveResults: new Map(),
      liveResults: new Map(),
      formulaResults: new Map(),
      theme: drawingThemeFor('light'),
    }),
    inspect: () => {},
    createFormula: () => {},
  };
  const definition = useTraceDefinition({ state, model, update: setState, selection });
  return (
    <WorkbenchLayout
      definition={definition}
      state={state}
      model={model}
      ui={{ annotationsHidden: new Set<string>(), setAnnotationsHidden: () => {} }}
      update={setState}
      capabilities={capabilities}
      selection={selection}
      toolId="trace"
    />
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

// jsdom lacks the layout APIs Carbon and react-resizable-panels touch on mount.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  window.localStorage.clear();
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
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setEmbedded(false);
  importFile.current = null;
  window.localStorage.clear();
});

function footerAddFormula(): HTMLElement {
  return screen.getByRole('button', { name: /^add formula/i });
}

/** The curve's card holds Create formula; the opening selection opens it. */
function openProperties() {
  if (document.querySelector('.wb-card--open') === null) {
    fireEvent.click(document.querySelector('.wb-outline-row') as HTMLElement);
  }
  expect(document.querySelector('.wb-card--open')).not.toBeNull();
}

function createFormulaButton(): HTMLButtonElement {
  return screen.getByRole('button', {
    name: /create formula from this curve/i,
  }) as HTMLButtonElement;
}

function actionsBar(): HTMLElement {
  return screen.getByTestId(TESTIDS.actionsBar);
}

describe('Layers footer Add formula', () => {
  it('works embedded: enabled, and a click adds a formula curve', () => {
    mountTraceWithCurve(true);
    const button = footerAddFormula();
    expect(button.getAttribute('aria-disabled')).toBeNull();
    const rows = () => document.querySelectorAll('.wb-outline-row').length;
    const before = rows();
    expect(before).toBe(1);
    fireEvent.click(button);
    expect(rows()).toBe(before + 1);
  });

  it('stays enabled standalone', () => {
    mountTraceWithCurve(false);
    expect(footerAddFormula().getAttribute('aria-disabled')).toBeNull();
  });
});

describe('Properties Create formula from this curve', () => {
  it('is enabled embedded for a PV curve', () => {
    mountTraceWithCurve(true);
    openProperties();
    expect(createFormulaButton().disabled).toBe(false);
  });

  it('stays enabled standalone for a PV curve', () => {
    mountTraceWithCurve(false);
    openProperties();
    expect(createFormulaButton().disabled).toBe(false);
  });
});

describe('formula validation', () => {
  const formulaPlot = () =>
    makePlot([
      makeTrace(),
      makeTrace({
        id: 'f1',
        kind: 'formula',
        pvName: '',
        displayName: 'Scaled',
        expression: '{x1} * 2',
        bindings: { x1: 't1' },
      }),
    ]);

  /** The validate POSTs sent so far: URL and parsed body. */
  function validateCalls(): { url: string; body: unknown }[] {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/formula-engine/v1/validate'))
      .map(([url, init]) => ({
        url: String(url),
        body: JSON.parse(String((init as RequestInit).body)),
      }));
  }

  async function settle() {
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
  }

  it('validates through the Formula Engine embedded, with the curve bound to its PV', async () => {
    vi.useFakeTimers();
    setEmbedded(true);
    render(<FormulaWorkbench plot={formulaPlot()} />, { wrapper: AppCanopy });
    await settle();
    const calls = validateCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].url).toBe('/formula-engine/v1/validate');
    expect(
      fetchMock.mock.calls.find(([url]) => url === '/formula-engine/v1/validate')?.[1]
    ).toMatchObject({
      method: 'POST',
    });
    expect(calls[0].body).toMatchObject({ expression: '{x1} * 2', bindings: { x1: 'TEST:DCCT' } });
  });

  it('validates against the Canopy base embedded under a gateway prefix', async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/x/y/trace/?embedded=true');
    render(<FormulaWorkbench plot={formulaPlot()} />, { wrapper: AppCanopy });
    await settle();
    expect(validateCalls().map((c) => c.url)).toContain('/x/y/formula-engine/v1/validate');
  });

  it('validates through the Formula Engine standalone (control)', async () => {
    vi.useFakeTimers();
    render(<FormulaWorkbench plot={formulaPlot()} />, { wrapper: AppCanopy });
    await settle();
    expect(fetchMock).toHaveBeenCalledWith('/formula-engine/v1/validate', expect.anything());
  });
});

describe('workspace import when embedded', () => {
  it('keeps formula curves and PV curves', async () => {
    setEmbedded(true);
    const workspace = {
      schemaVersion: 1,
      savedAt: '2026-10-01T00:00:00Z',
      theme: 'light',
      plots: [
        makePlot([
          makeTrace({ id: 'imp-pv', displayName: 'Imported PV curve' }),
          makeTrace({
            id: 'imp-f',
            kind: 'formula',
            pvName: '',
            displayName: 'Imported formula curve',
            expression: '{x1} + 1',
            bindings: { x1: 'imp-pv' },
          }),
        ]),
      ],
    };
    importFile.current = new File([JSON.stringify(workspace)], 'ws.trc.json', {
      type: 'application/json',
    });
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<TraceApp />, { wrapper: AppCanopy });
    fireEvent.click(within(actionsBar()).getByRole('button', { name: /^import/i }));
    await waitFor(() => expect(screen.getAllByText('Imported PV curve').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Imported formula curve').length).toBeGreaterThan(0);
    // The imported formula is evaluated through the Formula Engine, its binding resolved to the PV.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/formula-engine/v1/evaluate', expect.anything())
    );
    const evaluate = fetchMock.mock.calls.find(([url]) => url === '/formula-engine/v1/evaluate')!;
    expect(JSON.parse(String((evaluate[1] as RequestInit).body))).toMatchObject({
      spec: { expression: '{x1} + 1', bindings: { x1: 'TEST:DCCT' } },
    });
  });
});

describe('under the host bar (embedded=true&hostbar=1): the host draws the actions', () => {
  it('renders no actions bar, while embedded=true alone keeps it', async () => {
    mountTraceWithCurve(true);
    await act(async () => {});
    expect(actionsBar()).toBeTruthy();
    cleanup();
    window.history.replaceState(null, '', '/trace/?pv=TEST:DCCT&range=-1h&embedded=true&hostbar=1');
    render(<TraceApp />, { wrapper: AppCanopy });
    await act(async () => {});
    expect(screen.queryByTestId(TESTIDS.actionsBar)).toBeNull();
  });

  it('Ctrl+O still opens the import with the bar absent', async () => {
    window.history.replaceState(null, '', '/trace/?embedded=true&hostbar=1');
    importFile.current = new File(
      [
        JSON.stringify({
          schemaVersion: 1,
          savedAt: '2026-10-01T00:00:00Z',
          theme: 'light',
          plots: [makePlot([makeTrace({ id: 'imp-pv', displayName: 'Imported PV curve' })])],
        }),
      ],
      'ws.trc.json',
      { type: 'application/json' }
    );
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<TraceApp />, { wrapper: AppCanopy });
    expect(screen.queryByTestId(TESTIDS.actionsBar)).toBeNull();
    const event = new KeyboardEvent('keydown', {
      key: 'o',
      code: 'KeyO',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getAllByText('Imported PV curve').length).toBeGreaterThan(0));
  });
});
