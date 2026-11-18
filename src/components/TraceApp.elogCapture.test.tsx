// @vitest-environment jsdom
//
// Which chart copy Post to E-Log captures. A popped-out plot is mounted twice:
// its in-window tab or grid cell plus the fullscreen overlay copy. Closing the
// overlay must leave the in-window copy capturable, not drop the plot from the
// capture until the in-window copy happens to remount.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { ComponentProps } from 'react';
import type { CapturedPlot, PngSource } from '../io/exportPlotImage';
import { actionButton, captured, currentPlots, resetHarness } from '../test/traceAppHarness';
import { WithCanopy } from '../test/canopy';
import { TraceApp } from './TraceApp';

const { FULLSCREEN_URL, IN_WINDOW_URL, elogModal } = vi.hoisted(() => ({
  FULLSCREEN_URL: 'data:image/png;base64,RlVMTFNDUkVFTg==',
  IN_WINDOW_URL: 'data:image/png;base64,SU4tV0lORE9X',
  elogModal: { open: false, captured: null as CapturedPlot[] | null },
}));

vi.mock('./PlotArea', async (importOriginal) => {
  const React = await import('react');
  const harness = await import('../test/traceAppHarness');
  // Under the recording PlotArea only the fullscreen overlay mounts a plot.
  // Like the real one, it registers a PNG source on mount and unregisters that
  // same source on unmount.
  function MockPlotWithStatistics({
    onChartInstance,
  }: Pick<ComponentProps<typeof import('./PlotArea').PlotWithStatistics>, 'onChartInstance'>) {
    React.useEffect(() => {
      const source: PngSource = { getDataURL: async () => FULLSCREEN_URL };
      onChartInstance?.(source, true);
      return () => onChartInstance?.(source, false);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- register once per mount, like SinglePlot
    }, []);
    return null;
  }
  return {
    ...harness.mocks.PlotArea(await importOriginal<typeof import('./PlotArea')>()),
    PlotWithStatistics: MockPlotWithStatistics,
  };
});
vi.mock('./PostToElogModal', () => ({
  PostToElogModal: (props: { open: boolean; captured: CapturedPlot[] }) => {
    elogModal.open = props.open;
    elogModal.captured = props.captured;
    return null;
  },
}));
// E-Log configured, so the actions bar shows Post to E-Log.
vi.mock('../hooks/useElogConfig', () => ({
  useElogConfig: () => ({ enabled: true, defaultLogbookIds: [] }),
}));
vi.mock('../io/download', async () => (await import('../test/traceAppHarness')).mocks.download);

function plotId(): string {
  return currentPlots()[0].id;
}

// Register the in-window copy the way PlotArea's SinglePlot would on mount.
function mountInWindowCopy(): PngSource {
  const source: PngSource = { getDataURL: async () => IN_WINDOW_URL };
  act(() => captured.plotArea!.onChartInstance!(plotId(), source, true));
  return source;
}

function popOut() {
  act(() => captured.plotArea!.onPopOutPlot(plotId()));
}

function closeFullscreen() {
  fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape', keyCode: 27 });
}

// Post to E-Log captures asynchronously, then opens the dialog with the
// images; read them once it is open.
async function postToElog(): Promise<string[]> {
  fireEvent.click(actionButton('Post to E-Log'));
  await waitFor(() => expect(elogModal.open).toBe(true));
  return (elogModal.captured ?? []).map((c) => c.dataUrl);
}

beforeEach(() => {
  resetHarness();
  elogModal.open = false;
  elogModal.captured = null;
  render(<TraceApp />, { wrapper: WithCanopy });
});

afterEach(() => cleanup());

describe('Post to E-Log chart capture', () => {
  it('captures the fullscreen copy while the plot is popped out', async () => {
    mountInWindowCopy();
    popOut();

    expect(await postToElog()).toEqual([FULLSCREEN_URL]);
  });

  it('keeps the fullscreen copy when the in-window copy registers after it', async () => {
    mountInWindowCopy();
    popOut();
    mountInWindowCopy();

    expect(await postToElog()).toEqual([FULLSCREEN_URL]);
  });

  it('falls back to the in-window copy after the fullscreen overlay closes', async () => {
    mountInWindowCopy();
    popOut();
    closeFullscreen();

    expect(await postToElog()).toEqual([IN_WINDOW_URL]);
  });

  it('skips the plot once its last copy unmounts', async () => {
    const source = mountInWindowCopy();
    popOut();
    closeFullscreen();
    act(() => captured.plotArea!.onChartInstance!(plotId(), source, false));

    expect(await postToElog()).toEqual([]);
  });
});
