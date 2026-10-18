// @vitest-environment jsdom
//
// Issue 109, end to end: after a pan or zoom, switching Autoscroll back on or
// re-committing the current span must reset the chart's zoom, drop the saved
// view window and follow "now" again. Mounts the whole app with a mocked
// ECharts and no backend; the starting plot's chart is the only one on screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { TraceApp } from './TraceApp';
import { DEFAULT_REFRESH_INTERVAL_S } from '../hooks/useAutoScrollTimers';

const { captured, fakeInstance } = vi.hoisted(() => {
  const captured: {
    option: { xAxis: { max: number } } | null;
    onEvents: Record<string, () => void>;
  } = { option: null, onEvents: {} };
  const fakeInstance = {
    getDom: () => ({}),
    isDisposed: () => false,
    dispatchAction: vi.fn(),
    getModel: () => ({
      getComponent: () => ({ axis: { scale: { getExtent: (): [number, number] => [0, 1] } } }),
    }),
  };
  return { captured, fakeInstance };
});

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component<{
    option: unknown;
    onEvents: Record<string, () => void>;
  }> {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      captured.option = this.props.option as typeof captured.option;
      captured.onEvents = this.props.onEvents;
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

const T0 = new Date('2026-10-15T12:00:00Z').getTime();
const RESET = { type: 'dataZoom', start: 0, end: 100 };
// The starting plot's refresh interval.
const TICK_MS = DEFAULT_REFRESH_INTERVAL_S * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  fakeInstance.dispatchAction.mockClear();
  // jsdom lacks these; Carbon and the resizable panels call them on mount.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  // No backend: every request fails.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('no backend')))
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const autoscrollSwitch = () => document.getElementById('autoscroll')!;
const autoscrollOn = () => autoscrollSwitch().getAttribute('aria-checked') === 'true';
const axisEnd = () => captured.option!.xAxis.max;

// A wheel zoom or drag pan on the plot (one datazoom event).
function pan() {
  act(() => captured.onEvents.datazoom());
}

function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

// The pan or zoom itself must leave the user's zoom alone.
function expectZoomKept() {
  expect(fakeInstance.dispatchAction).not.toHaveBeenCalled();
}

// Back to the full range, and following: each clock tick moves the axis to now.
function expectResumedAt(atMs: number) {
  expect(fakeInstance.dispatchAction).toHaveBeenCalledTimes(1);
  expect(fakeInstance.dispatchAction).toHaveBeenCalledWith(RESET);
  expect(axisEnd()).toBe(atMs);
  advance(TICK_MS);
  expect(autoscrollOn()).toBe(true);
  expect(axisEnd()).toBe(atMs + TICK_MS);
}

describe('resuming after a pan or zoom', () => {
  it('Autoscroll back on resets the zoom and follows now', () => {
    render(<TraceApp />);
    expect(axisEnd()).toBe(T0);
    pan();
    advance(400); // the view window is recorded
    expect(autoscrollOn()).toBe(false);
    advance(10_000);
    expect(axisEnd()).toBe(T0);
    expectZoomKept();

    fireEvent.click(autoscrollSwitch());
    expectResumedAt(T0 + 10_400);
  });

  it('re-committing the current span resets the zoom and follows now', () => {
    render(<TraceApp />);
    pan();
    advance(10_400);
    expect(autoscrollOn()).toBe(false);
    expectZoomKept();

    // The plot is already on 1h, so the Span field reads "1h"; Enter re-commits it.
    const span = document.getElementById('time-span')!;
    expect(span).toHaveProperty('value', '1h');
    fireEvent.keyDown(span, { key: 'Enter' });
    expectResumedAt(T0 + 10_400);
  });

  it('stays resumed when Autoscroll goes back on before the pan is recorded', () => {
    render(<TraceApp />);
    pan();
    expect(autoscrollOn()).toBe(false);
    expectZoomKept();

    // Within the 400 ms view-window debounce: the pending write must not land
    // after the reset and freeze the plot again.
    fireEvent.click(autoscrollSwitch());
    expectResumedAt(T0);
  });
});
