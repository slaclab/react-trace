// @vitest-environment jsdom
//
// Issue 109, end to end: after a pan or zoom, switching Autoscroll back on or
// re-picking the current range must drop the saved view window, put the time
// axis back on the configured span and follow "now" again. Mounts the whole app
// with CanopyChart stubbed out and no backend; the starting plot's chart is the
// only one on screen.
//
// The chart has no inside dataZoom: the axis shows the view window through the
// option's xAxis min/max, so a reset is the option's window going back to the
// configured span ending at now. A pan is an arrow key on the plot, which,
// like a wheel step, is queued and reaches the app on the next animation frame.
// Frames are driven by hand here, so a test can act while one is still queued.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { TraceApp } from './TraceApp';
import { DEFAULT_REFRESH_INTERVAL_S } from '../hooks/useAutoScrollTimers';
import { PAN_STEP } from '../annotations/keys';
import { chartStub } from '../test/chartStub';
import { WithCanopy } from '../test/canopy';

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
const captured: { option: { xAxis: { min: number; max: number } } | null } = { option: null };

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);
chartStub.instance = fakeInstance;
chartStub.onRender = (props) => {
  captured.option = props.option as typeof captured.option;
};

const T0 = new Date('2026-10-15T12:00:00Z').getTime();
// The starting plot's range and refresh interval.
const SPAN_MS = 60 * 60 * 1000;
const TICK_MS = DEFAULT_REFRESH_INTERVAL_S * 1000;
// One arrow-key pan to the left.
const PAN_MS = PAN_STEP * SPAN_MS;

// Animation frames, flushed by hand (see flushFrames).
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(T0);
  captured.option = null;
  frames = new Map();
  nextFrame = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
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
  vi.restoreAllMocks();
});

function mount() {
  render(<TraceApp />, { wrapper: WithCanopy });
  // The Autoscroll toggle and the Span field are in the plot's Axes section,
  // which starts closed.
  const head = document.querySelector<HTMLElement>(
    '.wb-plot-section[data-section="axes"] .wb-plot-section__head'
  );
  if (!head) throw new Error('no Axes section');
  fireEvent.click(head);
}

const autoscrollSwitch = () => document.getElementById('autoscroll')!;
const autoscrollOn = () => autoscrollSwitch().getAttribute('aria-checked') === 'true';
const axisWindow = () => ({ from: captured.option!.xAxis.min, to: captured.option!.xAxis.max });
const axisEnd = () => axisWindow().to;

// Run the frames queued so far (not the ones they queue in turn).
function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const cb of pending) cb(performance.now());
  });
}

// One arrow-key pan on the plot, queued for the next animation frame.
function queuePan() {
  const wrap = document.querySelector('[data-plot-id]')!;
  act(() => {
    fireEvent.keyDown(wrap, { key: 'ArrowLeft', code: 'ArrowLeft' });
  });
}

// A pan the app has recorded: its frame has run.
function pan() {
  queuePan();
  flushFrames();
}

function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

// The pan or zoom itself keeps the user's window: no reset, no scrolling.
function expectZoomKept(window: { from: number; to: number }) {
  expect(autoscrollOn()).toBe(false);
  expect(axisWindow()).toEqual(window);
}

// Back to the configured span, and following: each clock tick moves the axis to now.
function expectResumedAt(atMs: number) {
  expect(autoscrollOn()).toBe(true);
  expect(axisWindow()).toEqual({ from: atMs - SPAN_MS, to: atMs });
  advance(TICK_MS);
  expect(autoscrollOn()).toBe(true);
  expect(axisWindow()).toEqual({ from: atMs + TICK_MS - SPAN_MS, to: atMs + TICK_MS });
}

// The tab bar's chip for the plot's current range, `-1h`.
function rePickRange() {
  const chips = document.querySelectorAll<HTMLElement>('[data-range-chip="-1h"]');
  expect(chips).toHaveLength(1);
  expect(chips[0].getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(chips[0]);
}

const PANNED = { from: T0 - SPAN_MS - PAN_MS, to: T0 - PAN_MS };

describe('resuming after a pan or zoom', () => {
  it('Autoscroll back on resets the zoom and follows now', () => {
    mount();
    expect(axisEnd()).toBe(T0);
    pan();
    expectZoomKept(PANNED);
    advance(10_000);
    expectZoomKept(PANNED);

    fireEvent.click(autoscrollSwitch());
    expectResumedAt(T0 + 10_000);
  });

  it('re-picking the current range resets the zoom and follows now', () => {
    mount();
    pan();
    advance(10_000);
    expectZoomKept(PANNED);

    rePickRange();
    expectResumedAt(T0 + 10_000);
  });

  it('re-committing the current span in the Span field resets the zoom and follows now', () => {
    mount();
    pan();
    advance(10_000);
    expectZoomKept(PANNED);

    const span = document.getElementById('time-span') as HTMLInputElement;
    expect(span.value).toBe('1h');
    fireEvent.keyDown(span, { key: 'Enter' });
    expectResumedAt(T0 + 10_000);
  });

  it('leaving the Span field unchanged keeps the zoom', () => {
    mount();
    pan();
    advance(10_000);

    const span = document.getElementById('time-span') as HTMLInputElement;
    fireEvent.focus(span);
    fireEvent.blur(span);
    expectZoomKept(PANNED);
  });
});

// A wheel step or arrow key reaches the app on the next animation frame. One
// still queued when the plot resumes must be dropped: delivered after the
// reset, it would save the old window and switch Autoscroll back off.
describe('a pan still queued when the plot resumes', () => {
  it('is dropped when Autoscroll goes back on', () => {
    mount();
    pan();
    advance(10_000);
    queuePan();
    expectZoomKept(PANNED);

    fireEvent.click(autoscrollSwitch());
    flushFrames();
    expectResumedAt(T0 + 10_000);
  });

  it('is dropped when the range is re-picked', () => {
    mount();
    pan();
    advance(10_000);
    queuePan();
    expectZoomKept(PANNED);

    rePickRange();
    flushFrames();
    expectResumedAt(T0 + 10_000);
  });

  it('is dropped when the range is re-picked while following', () => {
    mount();
    advance(10_000);
    queuePan();
    expect(autoscrollOn()).toBe(true);

    rePickRange();
    flushFrames();
    expectResumedAt(T0 + 10_000);
  });
});
