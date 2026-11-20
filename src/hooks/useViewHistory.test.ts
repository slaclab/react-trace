// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useViewHistory, type ViewSnapshot } from './useViewHistory';

function snap(overrides: Partial<ViewSnapshot> = {}): ViewSnapshot {
  return {
    timeWindow: { fromNs: 1000, toNs: 2000 },
    axisRanges: new Map(),
    autoScroll: false,
    ...overrides,
  };
}

function snapAt(fromNs: number, toNs: number): ViewSnapshot {
  return snap({ timeWindow: { fromNs, toNs } });
}

describe('useViewHistory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with no history', () => {
    const { result } = renderHook(() => useViewHistory());
    expect(result.current.canGoBack('p1')).toBe(false);
    expect(result.current.canGoForward('p1')).toBe(false);
  });

  it('push then goBack returns the previous snapshot', () => {
    const { result } = renderHook(() => useViewHistory());
    const s1 = snapAt(0, 100);
    const s2 = snapAt(100, 200);

    act(() => {
      result.current.push('p1', s1);
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.push('p1', s2);
      vi.advanceTimersByTime(300);
    });

    expect(result.current.canGoBack('p1')).toBe(true);
    expect(result.current.canGoForward('p1')).toBe(false);

    let restored: ViewSnapshot | null = null;
    act(() => {
      restored = result.current.goBack('p1');
    });
    expect(restored).not.toBeNull();
    expect(restored!.timeWindow).toEqual({ fromNs: 0, toNs: 100 });
    expect(result.current.canGoForward('p1')).toBe(true);
  });

  it('goForward after goBack returns to the later snapshot', () => {
    const { result } = renderHook(() => useViewHistory());
    const s1 = snapAt(0, 100);
    const s2 = snapAt(100, 200);

    act(() => {
      result.current.push('p1', s1);
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.push('p1', s2);
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.goBack('p1');
    });

    let restored: ViewSnapshot | null = null;
    act(() => {
      restored = result.current.goForward('p1');
    });
    expect(restored!.timeWindow).toEqual({ fromNs: 100, toNs: 200 });
    expect(result.current.canGoForward('p1')).toBe(false);
  });

  it('push after goBack truncates forward entries', () => {
    const { result } = renderHook(() => useViewHistory());

    act(() => {
      result.current.push('p1', snapAt(0, 100));
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.push('p1', snapAt(100, 200));
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.push('p1', snapAt(200, 300));
      vi.advanceTimersByTime(300);
    });

    // Go back to entry 1
    act(() => {
      result.current.goBack('p1');
    });
    act(() => {
      result.current.goBack('p1');
    });

    // Push new entry — forward stack (entries 2,3) should be gone
    act(() => {
      result.current.push('p1', snapAt(999, 1000));
      vi.advanceTimersByTime(300);
    });

    expect(result.current.canGoForward('p1')).toBe(false);

    // Going back should get entry 0
    let restored: ViewSnapshot | null = null;
    act(() => {
      restored = result.current.goBack('p1');
    });
    expect(restored!.timeWindow).toEqual({ fromNs: 0, toNs: 100 });
  });

  it('deduplicates identical consecutive snapshots', () => {
    const { result } = renderHook(() => useViewHistory());
    const s = snapAt(0, 100);

    act(() => {
      result.current.push('p1', s);
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.push('p1', snapAt(0, 100)); // same values
      vi.advanceTimersByTime(300);
    });

    expect(result.current.canGoBack('p1')).toBe(false);
  });

  it('coalesces rapid pushes within 300ms', () => {
    const { result } = renderHook(() => useViewHistory());

    act(() => {
      result.current.push('p1', snapAt(0, 100));
      vi.advanceTimersByTime(100); // only 100ms — still pending
      result.current.push('p1', snapAt(0, 200)); // replaces pending
      vi.advanceTimersByTime(300); // now commits
    });

    // Only one entry — the second push replaced the first
    expect(result.current.canGoBack('p1')).toBe(false);

    // Push a different one to verify the committed value
    act(() => {
      result.current.push('p1', snapAt(999, 1000));
      vi.advanceTimersByTime(300);
    });

    let restored: ViewSnapshot | null = null;
    act(() => {
      restored = result.current.goBack('p1');
    });
    expect(restored!.timeWindow).toEqual({ fromNs: 0, toNs: 200 });
  });

  it('goBack flushes pending coalesce first', () => {
    const { result } = renderHook(() => useViewHistory());

    act(() => {
      result.current.push('p1', snapAt(0, 100));
      vi.advanceTimersByTime(300);
    });
    act(() => {
      // Push but don't wait for coalesce
      result.current.push('p1', snapAt(100, 200));
    });

    // goBack should flush the pending push, then step back
    let restored: ViewSnapshot | null = null;
    act(() => {
      restored = result.current.goBack('p1');
    });
    expect(restored!.timeWindow).toEqual({ fromNs: 0, toNs: 100 });
    expect(result.current.canGoForward('p1')).toBe(true);
  });

  it('caps history at 50 entries', () => {
    const { result } = renderHook(() => useViewHistory());

    act(() => {
      for (let i = 0; i < 60; i++) {
        result.current.push('p1', snapAt(i, i + 1));
        vi.advanceTimersByTime(300);
      }
    });

    // Should be able to go back at most 49 times (50 entries, cursor at end)
    let count = 0;
    act(() => {
      while (result.current.goBack('p1') !== null) count++;
    });
    expect(count).toBe(49);
  });

  it('clear removes all history for a plot', () => {
    const { result } = renderHook(() => useViewHistory());

    act(() => {
      result.current.push('p1', snapAt(0, 100));
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.push('p1', snapAt(100, 200));
      vi.advanceTimersByTime(300);
    });

    act(() => {
      result.current.clear('p1');
    });

    expect(result.current.canGoBack('p1')).toBe(false);
    expect(result.current.canGoForward('p1')).toBe(false);
    expect(result.current.goBack('p1')).toBeNull();
  });

  it('histories are independent per plot', () => {
    const { result } = renderHook(() => useViewHistory());

    act(() => {
      result.current.push('p1', snapAt(0, 100));
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.push('p1', snapAt(100, 200));
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.push('p2', snapAt(500, 600));
      vi.advanceTimersByTime(300);
    });

    expect(result.current.canGoBack('p1')).toBe(true);
    expect(result.current.canGoBack('p2')).toBe(false);
  });

  it('seeds a baseline so the first zoom can be undone', () => {
    const { result } = renderHook(() => useViewHistory());
    const baseline = snapAt(0, 100);
    const zoom = snapAt(50, 75);

    act(() => {
      result.current.push('p1', zoom, baseline);
      vi.advanceTimersByTime(300);
    });

    expect(result.current.canGoBack('p1')).toBe(true);

    let restored: ViewSnapshot | null = null;
    act(() => {
      restored = result.current.goBack('p1');
    });
    expect(restored!.timeWindow).toEqual({ fromNs: 0, toNs: 100 });
  });

  it('seedBaseline seeds once on an empty history', () => {
    const { result } = renderHook(() => useViewHistory());
    const baseline = snap({ autoScroll: true, timeWindow: { fromNs: 0, toNs: 100 } });

    act(() => {
      result.current.seedBaseline('p1', baseline);
    });

    // Baseline is entry 0 — nothing to go back to yet
    expect(result.current.canGoBack('p1')).toBe(false);

    // Push a zoom; going back should return the seeded baseline
    act(() => {
      result.current.push('p1', snapAt(50, 75));
      vi.advanceTimersByTime(300);
    });

    let restored: ViewSnapshot | null = null;
    act(() => {
      restored = result.current.goBack('p1');
    });
    expect(restored!.timeWindow).toEqual({ fromNs: 0, toNs: 100 });
    expect(restored!.autoScroll).toBe(true);
  });

  it('seedBaseline is a no-op when history already exists', () => {
    const { result } = renderHook(() => useViewHistory());

    act(() => {
      result.current.push('p1', snapAt(0, 100));
      vi.advanceTimersByTime(300);
    });

    // Attempt to seed after history exists — should be ignored
    act(() => {
      result.current.seedBaseline(
        'p1',
        snap({ autoScroll: true, timeWindow: { fromNs: 999, toNs: 1000 } })
      );
    });

    let restored: ViewSnapshot | null = null;
    act(() => {
      restored = result.current.goBack('p1');
    });
    // No second entry was added, so goBack returns null
    expect(restored).toBeNull();
  });

  it('seedBaseline is a no-op when a pending push exists', () => {
    const { result } = renderHook(() => useViewHistory());

    // Push without waiting for coalesce — creates a pending entry
    act(() => {
      result.current.push('p1', snapAt(50, 75));
    });

    // seedBaseline should be skipped because pending exists
    act(() => {
      result.current.seedBaseline(
        'p1',
        snap({ autoScroll: true, timeWindow: { fromNs: 0, toNs: 100 } })
      );
    });

    // Let the coalesce timer fire
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // Only one entry (the pushed one), no baseline was added
    expect(result.current.canGoBack('p1')).toBe(false);
  });

  it('does not seed baseline when history already exists', () => {
    const { result } = renderHook(() => useViewHistory());

    act(() => {
      result.current.push('p1', snapAt(0, 100));
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.push('p1', snapAt(100, 200), snapAt(50, 150));
      vi.advanceTimersByTime(300);
    });

    // Go back should return entry 0, not the baseline (which was ignored)
    let restored: ViewSnapshot | null = null;
    act(() => {
      restored = result.current.goBack('p1');
    });
    expect(restored!.timeWindow).toEqual({ fromNs: 0, toNs: 100 });
  });

  it('clearAll removes history for all plots', () => {
    const { result } = renderHook(() => useViewHistory());

    act(() => {
      result.current.push('p1', snapAt(0, 100));
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.push('p1', snapAt(100, 200));
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.push('p2', snapAt(0, 50));
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.push('p2', snapAt(50, 100));
      vi.advanceTimersByTime(300);
    });

    act(() => {
      result.current.clearAll();
    });

    expect(result.current.canGoBack('p1')).toBe(false);
    expect(result.current.canGoBack('p2')).toBe(false);
    expect(result.current.goBack('p1')).toBeNull();
    expect(result.current.goBack('p2')).toBeNull();
  });

  it('compares axis ranges in dedup', () => {
    const { result } = renderHook(() => useViewHistory());
    const axes1 = new Map([['a1', { min: 0, max: 10, autoScale: false }]]);
    const axes2 = new Map([['a1', { min: 5, max: 15, autoScale: false }]]);

    act(() => {
      result.current.push('p1', snap({ axisRanges: axes1 }));
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.push('p1', snap({ axisRanges: axes2 }));
      vi.advanceTimersByTime(300);
    });

    // Different axis ranges → two entries
    expect(result.current.canGoBack('p1')).toBe(true);
  });

  it('goForward flushes pending coalesce so a zoom truncates forward stack', () => {
    const { result } = renderHook(() => useViewHistory());

    act(() => {
      result.current.push('p1', snapAt(0, 100));
      vi.advanceTimersByTime(300);
    });
    act(() => {
      result.current.push('p1', snapAt(100, 200));
      vi.advanceTimersByTime(300);
    });

    // Go back to entry 0
    act(() => {
      result.current.goBack('p1');
    });

    // Zoom (pending push) — should truncate forward when flushed
    act(() => {
      result.current.push('p1', snapAt(999, 1000));
    });

    // goForward should flush the pending zoom (which truncates forward), then find nothing
    let restored: ViewSnapshot | null = null;
    act(() => {
      restored = result.current.goForward('p1');
    });
    expect(restored).toBeNull();
    expect(result.current.canGoForward('p1')).toBe(false);
  });

  it('goBack/goForward return null at boundaries', () => {
    const { result } = renderHook(() => useViewHistory());

    expect(result.current.goBack('p1')).toBeNull();
    expect(result.current.goForward('p1')).toBeNull();

    act(() => {
      result.current.push('p1', snapAt(0, 100));
      vi.advanceTimersByTime(300);
    });

    expect(result.current.goBack('p1')).toBeNull();
    expect(result.current.goForward('p1')).toBeNull();
  });
});
