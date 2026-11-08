// @vitest-environment jsdom
//
// Mounts the real TraceApp with its panels mocked, to pin the canopy-shell
// ErrorBoundary around each panel: a render error in one panel shows the
// fallback there while the header and the other panels keep working, and the
// boundary recovers on "Try again" or when a workspace is loaded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  axis,
  captured,
  loadWorkspace,
  plot,
  pvTrace,
  resetHarness,
  workspace,
} from '../test/traceAppHarness';
import { TraceApp } from './TraceApp';

const boom = vi.hoisted(() => ({ left: false, insight: false, chart: false }));
const insightProps = vi.hoisted(() => ({ current: null as null | { onDetach: () => void } }));

vi.mock('./Toolbar', async () => (await import('../test/traceAppHarness')).mocks.Toolbar);
vi.mock('./PlotArea', async () => ({
  ...(await import('../test/traceAppHarness')).mocks.PlotArea,
  // The fullscreen view and detached windows render SinglePlot from TraceApp.
  SinglePlot: () => {
    if (boom.chart) throw new Error('chart exploded');
    return <div data-testid="single-plot" />;
  },
}));
vi.mock('./RightPanel', async () => (await import('../test/traceAppHarness')).mocks.RightPanel);
vi.mock('./LeftPanel', async () => {
  const harness = await import('../test/traceAppHarness');
  const Captured = harness.mocks.LeftPanel.LeftPanel;
  function LeftPanel(props: Parameters<typeof Captured>[0]) {
    if (boom.left) throw new Error('layers panel exploded');
    return Captured(props);
  }
  return { LeftPanel };
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

beforeEach(() => {
  resetHarness();
  boom.left = false;
  boom.insight = false;
  boom.chart = false;
  insightProps.current = null;
  // React reports the caught render error on the console.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('panel error boundaries', () => {
  it('shows the fallback in the crashed panel and keeps the rest of the app', () => {
    boom.left = true;
    render(<TraceApp />);

    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText('layers panel exploded')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(captured.leftPanel).toBeNull();
    // The header actions, the plot area and the properties panel still render.
    expect(captured.toolbar).not.toBeNull();
    expect(captured.plotArea).not.toBeNull();
    expect(captured.rightPanel).not.toBeNull();
  });

  it('renders the panel again on "Try again" once the cause is gone', () => {
    boom.left = true;
    render(<TraceApp />);

    boom.left = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(captured.leftPanel).not.toBeNull();
  });

  it('recovers by itself when a workspace is loaded', async () => {
    boom.left = true;
    render(<TraceApp />);
    expect(screen.getByText('Something went wrong')).toBeTruthy();

    boom.left = false;
    await loadWorkspace(workspace([plot('plot-1', [axis('axis-1')], [pvTrace('t1', 'TEST:PV')])]));
    await act(async () => {});

    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(captured.leftPanel).not.toBeNull();
  });

  it('recovers the layers panel when the view mode changes', async () => {
    boom.left = true;
    render(<TraceApp />);
    expect(screen.getByText('Something went wrong')).toBeTruthy();

    boom.left = false;
    await act(async () => captured.plotArea!.onSetViewMode('grid'));

    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(captured.leftPanel).not.toBeNull();
  });

  describe('docked Data Insight', () => {
    function openInsight() {
      act(() => captured.toolbar!.onOpenDataInsight());
    }

    it('can be closed from its fallback', () => {
      boom.insight = true;
      render(<TraceApp />);
      openInsight();
      expect(screen.getByText('data insight exploded')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Close Data Insight' }));

      expect(screen.queryByText('data insight exploded')).toBeNull();
      expect(screen.queryByText('Something went wrong')).toBeNull();
    });

    it('recovers by itself when a workspace reusing the inspected trace id is loaded', async () => {
      boom.insight = true;
      render(<TraceApp />);
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
    it('contains a chart error in the fullscreen view', () => {
      boom.chart = true;
      const { container } = render(<TraceApp />);
      act(() => captured.plotArea!.onPopOutPlot('plot-1'));

      expect(screen.getByText('chart exploded')).toBeTruthy();
      // The rest of the app is still mounted.
      expect(container.querySelector('.trace-app')).not.toBeNull();
      expect(captured.leftPanel).not.toBeNull();
    });

    it('contains a chart error in a detached window and keeps Reattach', async () => {
      const popup = fakePopup();
      vi.spyOn(window, 'open').mockReturnValue(popup);
      boom.chart = true;
      const { container } = render(<TraceApp />);
      act(() => captured.plotArea!.onDetachPlot('plot-1'));

      await waitFor(() => expect(popup.document.body.textContent).toContain('chart exploded'));
      expect(popup.document.body.textContent).toContain('Reattach');
      expect(container.querySelector('.trace-app')).not.toBeNull();
    });

    it('contains a detached Data Insight error and can close it', async () => {
      const popup = fakePopup();
      vi.spyOn(window, 'open').mockReturnValue(popup);
      render(<TraceApp />);
      act(() => captured.toolbar!.onOpenDataInsight());
      boom.insight = true;
      act(() => insightProps.current!.onDetach());

      await waitFor(() =>
        expect(popup.document.body.textContent).toContain('data insight exploded')
      );
      const close = Array.from(popup.document.querySelectorAll('button')).find(
        (b) => b.textContent === 'Close Data Insight'
      )!;
      act(() => close.click());

      expect(popup.close).toHaveBeenCalled();
    });
  });
});
