// @vitest-environment jsdom
//
// Mounts the real TraceApp, its plot area stubbed, to pin the canopy-shell
// ErrorBoundary around each part that can crash on its own: the workbench's
// Signals and Properties panes, Data Insight (docked and detached), the
// fullscreen view and a detached plot. A render error in one part shows the
// fallback there while the actions bar and the other parts keep working, and
// the boundary recovers on "Try again" or when one of its reset keys changes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import {
  actionButton,
  axis,
  captured,
  loadWorkspace,
  plot,
  pvTrace,
  resetHarness,
  selectCurve,
  workspace,
} from '../test/traceAppHarness';
import { chartStub } from '../test/chartStub';
import { AXIS_SECTION_KIND } from '../tools/trace/schema/axis';
import type { Outline } from '../workbench/Outline';
import type { PlotSettings } from '../workbench/PlotSettings';
import { TraceApp } from './TraceApp';
import { WithCanopy } from '../test/canopy';

const boom = vi.hoisted(() => ({ signals: false, properties: false, insight: false }));
const insightProps = vi.hoisted(() => ({ current: null as null | { onDetach: () => void } }));

// The in-window plot area is the harness's recording stub, so only the
// fullscreen and detached copies mount a chart (through the CanopyChart stub).
vi.mock('./PlotArea', async (importOriginal) =>
  (await import('../test/traceAppHarness')).mocks.PlotArea(await importOriginal())
);
vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);
vi.mock('../workbench/WorkbenchLayout', async (importOriginal) =>
  (await import('../test/traceAppHarness')).mocks.WorkbenchLayout(await importOriginal())
);
// The two panes render for real until their flag is set.
vi.mock('../workbench/Outline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workbench/Outline')>();
  function ExplodingOutline(props: ComponentProps<typeof Outline>) {
    if (boom.signals) throw new Error('signals pane exploded');
    return createElement(actual.Outline, props);
  }
  return { ...actual, Outline: ExplodingOutline };
});
vi.mock('../workbench/PlotSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workbench/PlotSettings')>();
  function ExplodingPlotSettings(props: ComponentProps<typeof PlotSettings>) {
    if (boom.properties) throw new Error('properties pane exploded');
    return createElement(actual.PlotSettings, props);
  }
  return { ...actual, PlotSettings: ExplodingPlotSettings };
});
vi.mock('./DataInsightTool', () => ({
  DataInsightTool: (props: { onDetach: () => void }) => {
    insightProps.current = props;
    if (boom.insight) throw new Error('data insight exploded');
    return <div data-testid="data-insight" />;
  },
}));

// A stand-in pop-up: a separate document plus the Window members DetachedWindow uses.
function fakePopup() {
  const doc = document.implementation.createHTMLDocument('popup');
  return {
    document: doc,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn(),
  } as unknown as Window;
}
vi.mock(
  '../hooks/useElogConfig',
  async () => (await import('../test/traceAppHarness')).mocks.useElogConfig
);
vi.mock('../io/download', async () => (await import('../test/traceAppHarness')).mocks.download);

const signalsPane = () => document.querySelector('.wb-outline');
const propertiesPane = () => document.querySelector('.wb-plot');
const actionsBar = () => screen.queryByRole('toolbar', { name: 'Tool actions' });

// The fallback sits inside the sidebar pane (the pane CSS in App.css targets
// it there), and the pane's header with its collapse button stays usable.
function expectFallbackInPane() {
  const fallback = document.querySelector('.canopy-error-fallback');
  expect(fallback?.closest('.wb-sidebar__pane')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Collapse Properties' })).toBeTruthy();
}

beforeEach(() => {
  resetHarness();
  boom.signals = false;
  boom.properties = false;
  boom.insight = false;
  insightProps.current = null;
  chartStub.instance = undefined;
  chartStub.props = null;
  chartStub.onRender = undefined;
  // React reports the caught render error on the console.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Signals pane error boundary', () => {
  it('shows the fallback in the crashed pane and keeps the rest of the app', () => {
    boom.signals = true;
    render(<TraceApp />, { wrapper: WithCanopy });

    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText('signals pane exploded')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expectFallbackInPane();
    expect(signalsPane()).toBeNull();
    // The actions bar, the plot area and the Properties pane still render.
    expect(actionsBar()).not.toBeNull();
    expect(captured.plotArea).not.toBeNull();
    expect(propertiesPane()).not.toBeNull();
  });

  it('renders the pane again on "Try again" once the cause is gone', () => {
    boom.signals = true;
    render(<TraceApp />, { wrapper: WithCanopy });

    boom.signals = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(signalsPane()).not.toBeNull();
  });

  it('recovers by itself when a workspace is loaded', async () => {
    boom.signals = true;
    render(<TraceApp />, { wrapper: WithCanopy });
    expect(screen.getByText('Something went wrong')).toBeTruthy();

    boom.signals = false;
    await loadWorkspace(workspace([plot('plot-1', [axis('axis-1')], [pvTrace('t1', 'TEST:PV')])]));
    await act(async () => {});

    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(signalsPane()).not.toBeNull();
  });

  it('recovers when the view mode changes', async () => {
    boom.signals = true;
    render(<TraceApp />, { wrapper: WithCanopy });
    expect(screen.getByText('Something went wrong')).toBeTruthy();

    boom.signals = false;
    await act(async () => captured.plotArea!.onSetViewMode('grid'));

    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(signalsPane()).not.toBeNull();
  });

  it('recovers when the selection changes (the open curve card renders in it)', async () => {
    await renderWithCurve();
    boom.signals = true;
    // Any write renders both panes.
    act(() => captured.layout!.update((s) => ({ ...s })));
    expect(screen.getByText('signals pane exploded')).toBeTruthy();

    boom.signals = false;
    act(() => captured.layout!.selection.reset());

    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(signalsPane()).not.toBeNull();
  });
});

describe('Properties pane error boundary', () => {
  it('shows the fallback in the crashed pane and keeps the rest of the app', () => {
    boom.properties = true;
    render(<TraceApp />, { wrapper: WithCanopy });

    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText('properties pane exploded')).toBeTruthy();
    expect(propertiesPane()).toBeNull();
    expectFallbackInPane();
    // The actions bar, the plot area and the Signals pane still render.
    expect(actionsBar()).not.toBeNull();
    expect(captured.plotArea).not.toBeNull();
    expect(signalsPane()).not.toBeNull();
  });

  it('renders the pane again on "Try again" once the cause is gone', () => {
    boom.properties = true;
    render(<TraceApp />, { wrapper: WithCanopy });

    boom.properties = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(propertiesPane()).not.toBeNull();
  });

  it('recovers when the selection changes', () => {
    boom.properties = true;
    render(<TraceApp />, { wrapper: WithCanopy });
    expect(screen.getByText('properties pane exploded')).toBeTruthy();

    boom.properties = false;
    const axisId = captured.plotArea!.plots[0].axes[0].id;
    act(() =>
      captured.layout!.selection.select(
        { level: 'section', kind: AXIS_SECTION_KIND, id: axisId },
        'user'
      )
    );

    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(propertiesPane()).not.toBeNull();
  });

  it('recovers by itself when a workspace is loaded', async () => {
    boom.properties = true;
    render(<TraceApp />, { wrapper: WithCanopy });
    expect(screen.getByText('Something went wrong')).toBeTruthy();

    boom.properties = false;
    await loadWorkspace(workspace([plot('plot-1', [axis('axis-1')], [pvTrace('t1', 'TEST:PV')])]));
    await act(async () => {});

    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(propertiesPane()).not.toBeNull();
  });

  it('recovers when the active plot changes', () => {
    render(<TraceApp />, { wrapper: WithCanopy });
    act(() => captured.plotArea!.onAddPlot());
    const [first] = captured.plotArea!.plots;
    boom.properties = true;
    act(() => captured.layout!.update((s) => ({ ...s })));
    expect(screen.getByText('properties pane exploded')).toBeTruthy();

    boom.properties = false;
    act(() => captured.plotArea!.onSetActivePlot(first.id));

    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(propertiesPane()).not.toBeNull();
  });
});

/** Mount Trace with one curve, its card open. */
async function renderWithCurve() {
  render(<TraceApp />, { wrapper: WithCanopy });
  await loadWorkspace(workspace([plot('plot-1', [axis('axis-1')], [pvTrace('t1', 'TEST:PV')])]));
  await act(async () => {});
  selectCurve('t1');
}

describe('docked Data Insight', () => {
  function openInsight() {
    fireEvent.click(actionButton('Data Insight'));
  }

  it('can be closed from its fallback', () => {
    boom.insight = true;
    render(<TraceApp />, { wrapper: WithCanopy });
    openInsight();
    expect(screen.getByText('data insight exploded')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close Data Insight' }));

    expect(screen.queryByText('data insight exploded')).toBeNull();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });

  it('recovers by itself when a workspace reusing the inspected trace id is loaded', async () => {
    boom.insight = true;
    render(<TraceApp />, { wrapper: WithCanopy });
    openInsight();
    // Workspace A: Data Insight inspects trace t1 and keeps failing.
    await loadWorkspace(workspace([plot('plot-1', [axis('axis-1')], [pvTrace('t1', 'TEST:A')])]));
    await act(async () => {});
    expect(screen.getByText('data insight exploded')).toBeTruthy();

    // Workspace B reuses the id t1, so the inspected trace id doesn't change;
    // the load itself has to reset the boundary.
    boom.insight = false;
    await loadWorkspace(workspace([plot('plot-1', [axis('axis-1')], [pvTrace('t1', 'TEST:B')])]));
    await act(async () => {});

    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(screen.getByTestId('data-insight')).toBeTruthy();
  });
});

describe('charts outside the plot area', () => {
  function explodeCharts() {
    chartStub.onRender = () => {
      throw new Error('chart exploded');
    };
  }

  it('contains a chart error in the fullscreen view', () => {
    explodeCharts();
    const { container } = render(<TraceApp />, { wrapper: WithCanopy });
    act(() => captured.plotArea!.onPopOutPlot('plot-1'));

    expect(screen.getByText('chart exploded')).toBeTruthy();
    // The rest of the app is still mounted.
    expect(container.querySelector('.trace-app')).not.toBeNull();
    expect(signalsPane()).not.toBeNull();
    expect(propertiesPane()).not.toBeNull();
  });

  it('contains a chart error in a detached window and keeps Reattach', async () => {
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    explodeCharts();
    const { container } = render(<TraceApp />, { wrapper: WithCanopy });
    act(() => captured.plotArea!.onDetachPlot('plot-1'));

    await waitFor(() => expect(popup.document.body.textContent).toContain('chart exploded'));
    expect(popup.document.body.textContent).toContain('Reattach');
    expect(container.querySelector('.trace-app')).not.toBeNull();
  });

  it('contains a detached Data Insight error and can close it', async () => {
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup);
    render(<TraceApp />, { wrapper: WithCanopy });
    fireEvent.click(actionButton('Data Insight'));
    boom.insight = true;
    act(() => insightProps.current!.onDetach());

    await waitFor(() => expect(popup.document.body.textContent).toContain('data insight exploded'));
    const close = Array.from(popup.document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Close Data Insight'
    )!;
    act(() => close.click());

    expect(popup.close).toHaveBeenCalled();
  });
});
