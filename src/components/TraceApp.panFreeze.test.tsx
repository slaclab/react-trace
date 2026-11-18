// @vitest-environment jsdom
//
// Main's time-window case "stops following on a pan after scrolling past the
// last clock tick", on the stack's controlled window. A following plot's axis
// scrolls on animation frames past its clock's last tick (useFollowNow); the
// first pan stops following and freezes the plot at the end it was showing,
// the current time, not that older tick, so the axis does not jump back
// under the gesture (`freezeAtDisplayedEnd`). The other removed cases pinned
// main's dataZoom reset, which the stack no longer has (the window is
// controlled; see TraceApp.autoscrollResume and PlotArea.viewWindow).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { captured, resetHarness } from '../test/traceAppHarness';
import { WithCanopy } from '../test/canopy';
import { msToNs } from '../api/time';
import { TraceApp } from './TraceApp';

vi.mock('./PlotArea', async (importOriginal) =>
  (await import('../test/traceAppHarness')).mocks.PlotArea(await importOriginal())
);
vi.mock(
  '../hooks/useElogConfig',
  async () => (await import('../test/traceAppHarness')).mocks.useElogConfig
);

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);

beforeEach(() => {
  resetHarness();
  // Only Date: the clock's tick timer never fires, so its last tick stays T0.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('a pan on a following plot', () => {
  it('stops following and freezes at the displayed end, past the last clock tick', () => {
    render(<TraceApp />, { wrapper: WithCanopy });
    const area = () => captured.plotArea!;
    const id = area().plots[0].id;
    expect(area().followingFor!(id)).toBe(true);
    expect(area().axisEndFor!(id)).toBe(T0);

    // Frames have scrolled the axis 1.2 s past the tick.
    vi.setSystemTime(T0 + 1200);
    const window = { fromNs: msToNs(T0 - 600_000), toNs: msToNs(T0 - 300_000) };
    act(() => area().onViewWindowChange!(id, window));

    expect(area().followingFor!(id)).toBe(false);
    expect(area().plots[0].autoScroll).toBe(false);
    expect(area().displayWindowByPlotId.get(id)).toEqual(window);
    // Frozen at the end on screen, not at the older tick.
    expect(area().axisEndFor!(id)).toBe(T0 + 1200);
  });
});
