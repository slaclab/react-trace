// @vitest-environment jsdom
//
// Which chart copy Post to E-Log captures. A popped-out plot is mounted twice:
// its in-window tab or grid cell plus the fullscreen overlay copy. Closing the
// overlay must leave the in-window copy capturable, not drop the plot from the
// capture until the in-window copy happens to remount.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { ComponentProps } from 'react';
import type { CapturedPlot, PngSource } from '../io/exportPlotImage';
import { captured, currentPlots, resetHarness } from '../test/traceAppHarness';
import { TraceApp } from './TraceApp';

const { FULLSCREEN_URL, IN_WINDOW_URL, elogModal } = vi.hoisted(() => ({
  FULLSCREEN_URL: 'data:image/png;base64,RlVMTFNDUkVFTg==',
  IN_WINDOW_URL: 'data:image/png;base64,SU4tV0lORE9X',
  elogModal: { captured: null as CapturedPlot[] | null },
}));

vi.mock('./Toolbar', async () => (await import('../test/traceAppHarness')).mocks.Toolbar);
vi.mock('./LeftPanel', async () => (await import('../test/traceAppHarness')).mocks.LeftPanel);
vi.mock('./PlotArea', async () => {
  const React = await import('react');
  const harness = await import('../test/traceAppHarness');
  // Under the mocked PlotArea only the fullscreen overlay renders SinglePlot.
  // Like the real one, it registers a PNG source on mount and unregisters that
  // same source on unmount.
  function MockSinglePlot({
    onChartInstance,
  }: Pick<ComponentProps<typeof import('./PlotArea').SinglePlot>, 'onChartInstance'>) {
    React.useEffect(() => {
      const source: PngSource = { getDataURL: () => FULLSCREEN_URL };
      onChartInstance?.(source, true);
      return () => onChartInstance?.(source, false);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- register once per mount, like SinglePlot
    }, []);
    return null;
  }
  return { ...harness.mocks.PlotArea, SinglePlot: MockSinglePlot };
});
vi.mock('./RightPanel', async () => (await import('../test/traceAppHarness')).mocks.RightPanel);
vi.mock('./PostToElogModal', () => ({
  PostToElogModal: (props: { captured: CapturedPlot[] }) => {
    elogModal.captured = props.captured;
    return null;
  },
}));
// E-Log configured, so TraceApp wires the toolbar's Post to E-Log action.
vi.mock('../hooks/useElogConfig', () => ({
  useElogConfig: () => ({ enabled: true, logbooks: [], defaultLogbooks: [] }),
}));
vi.mock('../io/download', async () => (await import('../test/traceAppHarness')).mocks.download);

function plotId(): string {
  return currentPlots()[0].id;
}

// Register the in-window copy the way PlotArea's SinglePlot would on mount.
function mountInWindowCopy(): PngSource {
  const source: PngSource = { getDataURL: () => IN_WINDOW_URL };
  act(() => captured.plotArea!.onChartInstance!(plotId(), source, true));
  return source;
}

function popOut() {
  act(() => captured.plotArea!.onPopOutPlot(plotId()));
}

function closeFullscreen() {
  fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape', keyCode: 27 });
}

function postToElog(): string[] {
  const onPostElog = captured.toolbar!.onPostElog;
  if (!onPostElog) throw new Error('Post to E-Log is not wired');
  act(() => onPostElog());
  return (elogModal.captured ?? []).map((c) => c.dataUrl);
}

beforeEach(() => {
  resetHarness();
  elogModal.captured = null;
  render(<TraceApp />);
});

afterEach(() => cleanup());

describe('Post to E-Log chart capture', () => {
  it('captures the fullscreen copy while the plot is popped out', () => {
    mountInWindowCopy();
    popOut();

    expect(postToElog()).toEqual([FULLSCREEN_URL]);
  });

  it('keeps the fullscreen copy when the in-window copy registers after it', () => {
    mountInWindowCopy();
    popOut();
    mountInWindowCopy();

    expect(postToElog()).toEqual([FULLSCREEN_URL]);
  });

  it('falls back to the in-window copy after the fullscreen overlay closes', () => {
    mountInWindowCopy();
    popOut();
    closeFullscreen();

    expect(postToElog()).toEqual([IN_WINDOW_URL]);
  });

  it('skips the plot once its last copy unmounts', () => {
    const source = mountInWindowCopy();
    popOut();
    closeFullscreen();
    act(() => captured.plotArea!.onChartInstance!(plotId(), source, false));

    expect(postToElog()).toEqual([]);
  });
});
