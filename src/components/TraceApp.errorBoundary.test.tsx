// @vitest-environment jsdom
//
// Mounts the real TraceApp with its panels mocked, to pin the canopy-shell
// ErrorBoundary around each panel: a render error in one panel shows the
// fallback there while the header and the other panels keep working, and the
// boundary recovers on "Try again" or when a workspace is loaded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const boom = vi.hoisted(() => ({ left: false }));

vi.mock('./Toolbar', async () => (await import('../test/traceAppHarness')).mocks.Toolbar);
vi.mock('./PlotArea', async () => (await import('../test/traceAppHarness')).mocks.PlotArea);
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
vi.mock(
  '../hooks/useElogConfig',
  async () => (await import('../test/traceAppHarness')).mocks.useElogConfig
);
vi.mock('../io/download', async () => (await import('../test/traceAppHarness')).mocks.download);

beforeEach(() => {
  resetHarness();
  boom.left = false;
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
});
