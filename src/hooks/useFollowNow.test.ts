// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { followStepMs, useFollowNow, type FollowNowOptions } from './useFollowNow';

const T0 = new Date('2026-10-15T12:00:00Z').getTime();

// A window stand-in whose animation frames the test fires by hand.
function fakeWindow() {
  let queue = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  const win = {
    requestAnimationFrame: vi.fn((cb: FrameRequestCallback) => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    }),
    cancelAnimationFrame: vi.fn((id: number) => {
      queue.delete(id);
    }),
  };
  // Run the pending frame(s) at wall time `atMs`.
  const frame = (atMs: number) => {
    vi.setSystemTime(atMs);
    const pending = queue;
    queue = new Map();
    act(() => {
      for (const cb of pending.values()) cb(atMs);
    });
  };
  return { win: win as unknown as Window, frame, pending: () => queue.size, spy: win };
}

function mount(opts: Partial<FollowNowOptions> & { win: Window }) {
  const getWindow = () => opts.win;
  const getWidthPx = () => opts.getWidthPx?.() ?? 800;
  const initialProps: FollowNowOptions = {
    following: true,
    anchorMs: T0,
    spanMs: 30_000,
    getWindow,
    getWidthPx,
    ...opts,
  };
  return renderHook((props: FollowNowOptions) => useFollowNow(props), { initialProps });
}

describe('followStepMs', () => {
  it('steps about once per pixel, never faster than a frame', () => {
    expect(followStepMs(30_000, 800)).toBe(37.5);
    expect(followStepMs(1000, 800)).toBe(16);
    expect(followStepMs(3_600_000, 800)).toBe(4500);
  });

  it('falls back to a default width when the plot has none yet', () => {
    expect(followStepMs(30_000, 0)).toBe(37.5);
    expect(followStepMs(30_000, -90)).toBe(37.5);
  });
});

describe('useFollowNow', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it('advances with animation frames while following', () => {
    const { win, frame } = fakeWindow();
    const { result } = mount({ win });
    expect(result.current).toBe(T0);
    frame(T0 + 1000);
    expect(result.current).toBe(T0 + 1000);
    frame(T0 + 2500);
    expect(result.current).toBe(T0 + 2500);
  });

  it('skips frames until a pixel of time has passed', () => {
    const { win, frame } = fakeWindow();
    const { result } = mount({ win, spanMs: 30_000 }); // 37.5 ms per px at 800 px
    frame(T0 + 1000);
    frame(T0 + 1020);
    expect(result.current).toBe(T0 + 1000);
    frame(T0 + 1040);
    expect(result.current).toBe(T0 + 1040);
  });

  it('holds at the anchor and schedules no frames when not following', () => {
    const { win, pending, spy } = fakeWindow();
    const { result } = mount({ win, following: false });
    expect(result.current).toBe(T0);
    expect(pending()).toBe(0);
    expect(spy.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('never runs behind the anchor, and shows a resume at once', () => {
    const { win, frame } = fakeWindow();
    const { result, rerender } = mount({ win });
    frame(T0 + 1000);
    const props = (o: Partial<FollowNowOptions>): FollowNowOptions => ({
      following: true,
      anchorMs: T0,
      spanMs: 30_000,
      getWindow: () => win,
      getWidthPx: () => 800,
      ...o,
    });
    // Frozen: back on the (frozen) anchor.
    rerender(props({ following: false, anchorMs: T0 + 1000 }));
    expect(result.current).toBe(T0 + 1000);
    // Resumed and re-anchored at now: shown before any frame runs.
    rerender(props({ following: true, anchorMs: T0 + 60_000 }));
    expect(result.current).toBe(T0 + 60_000);
  });

  it('stops the loop on unmount', () => {
    const { win, pending, spy } = fakeWindow();
    const { unmount } = mount({ win });
    expect(pending()).toBe(1);
    unmount();
    expect(spy.cancelAnimationFrame).toHaveBeenCalled();
    expect(pending()).toBe(0);
  });
});
