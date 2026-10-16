// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { isFollowing, useAutoScrollTimers } from './useAutoScrollTimers';
import type { TimeWindowNs } from '../api/time';
import type { Plot } from '../types';

const T0 = new Date('2026-10-15T12:00:00Z').getTime();
const NO_VIEW = new Map<string, TimeWindowNs>();

function makePlot(id: string, overrides: Partial<Plot> = {}): Plot {
  return {
    id,
    title: id,
    traces: [],
    axes: [],
    backgroundColor: 'default',
    showLegend: false,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
    ...overrides,
  };
}

function mount(plots: Plot[], viewWindowByPlot = NO_VIEW) {
  return renderHook(({ p, v }) => useAutoScrollTimers(p, v), {
    initialProps: { p: plots, v: viewWindowByPlot },
  });
}

// Advance in 1 s steps, each in its own act(): a tick's state update has to
// commit (and the effect reschedule the next timeout) before the next one is
// due, as it does between timer callbacks in a browser.
function advance(ms: number) {
  for (let left = ms; left > 0; left -= 1000) {
    const step = Math.min(1000, left);
    act(() => {
      vi.advanceTimersByTime(step);
    });
  }
}

describe('isFollowing', () => {
  it('follows a relative range with autoscroll on or unset and no view window', () => {
    expect(isFollowing(makePlot('p'), NO_VIEW)).toBe(true);
    expect(isFollowing(makePlot('p', { autoScroll: true }), NO_VIEW)).toBe(true);
  });

  it('does not follow with autoscroll off, a custom range, or a pan/zoom window', () => {
    expect(isFollowing(makePlot('p', { autoScroll: false }), NO_VIEW)).toBe(false);
    expect(isFollowing(makePlot('p', { xAxis: { timeRange: 'custom' } }), NO_VIEW)).toBe(false);
    const view = new Map([['p', { fromNs: 0, toNs: 1 }]]);
    expect(isFollowing(makePlot('p'), view)).toBe(false);
  });
});

describe('useAutoScrollTimers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it('seeds every initial plot at mount time', () => {
    const { result } = mount([makePlot('a'), makePlot('b', { autoScroll: false })]);
    expect(result.current.nowFor('a')).toBe(T0);
    expect(result.current.nowFor('b')).toBe(T0);
  });

  it('advances a following plot exactly on its refresh interval', () => {
    const { result } = mount([makePlot('a', { refreshIntervalS: 5 })]);
    advance(4999);
    expect(result.current.nowFor('a')).toBe(T0);
    advance(1);
    expect(result.current.nowFor('a')).toBe(T0 + 5000);
    advance(5000);
    expect(result.current.nowFor('a')).toBe(T0 + 10_000);
  });

  it('does not move on a re-render, however much wall-clock time has passed', () => {
    const plots = [makePlot('a', { refreshIntervalS: 5 })];
    const { result, rerender } = mount(plots);
    // Move the wall clock without firing timers, then re-render (as a live
    // batch or a settings change would).
    vi.setSystemTime(T0 + 3000);
    rerender({ p: [...plots], v: NO_VIEW });
    expect(result.current.nowFor('a')).toBe(T0);
  });

  it('holds still for a plot with autoscroll off, a custom range, or a view window', () => {
    const view = new Map([['c', { fromNs: 0, toNs: 1 }]]);
    const { result } = mount(
      [
        makePlot('a', { autoScroll: false }),
        makePlot('b', { xAxis: { timeRange: 'custom', timeFrom: '2026-10-15T00:00' } }),
        makePlot('c'),
      ],
      view
    );
    advance(120_000);
    expect(result.current.nowFor('a')).toBe(T0);
    expect(result.current.nowFor('b')).toBe(T0);
    expect(result.current.nowFor('c')).toBe(T0);
  });

  it('freezes when autoscroll turns off and keeps the last anchor', () => {
    const on = makePlot('a', { refreshIntervalS: 1 });
    const { result, rerender } = mount([on]);
    advance(3000);
    expect(result.current.nowFor('a')).toBe(T0 + 3000);
    rerender({ p: [{ ...on, autoScroll: false }], v: NO_VIEW });
    advance(10_000);
    expect(result.current.nowFor('a')).toBe(T0 + 3000);
  });

  it('advances each plot on its own interval', () => {
    const { result } = mount([
      makePlot('fast', { refreshIntervalS: 1 }),
      makePlot('slow', { refreshIntervalS: 5 }),
    ]);
    advance(3000);
    expect(result.current.nowFor('fast')).toBe(T0 + 3000);
    expect(result.current.nowFor('slow')).toBe(T0);
    advance(2000);
    expect(result.current.nowFor('fast')).toBe(T0 + 5000);
    expect(result.current.nowFor('slow')).toBe(T0 + 5000);
  });

  it('clamps the interval to the 1-60 s range', () => {
    const { result } = mount([makePlot('a', { refreshIntervalS: 0.1 })]);
    advance(999);
    expect(result.current.nowFor('a')).toBe(T0);
    advance(1);
    expect(result.current.nowFor('a')).toBe(T0 + 1000);
  });

  it('resync re-anchors a plot to now, or to a given instant', () => {
    const { result } = mount([makePlot('a', { autoScroll: false })]);
    vi.setSystemTime(T0 + 42_000);
    act(() => result.current.resync(['a']));
    expect(result.current.nowFor('a')).toBe(T0 + 42_000);
    act(() => result.current.resync(['a'], T0 + 7));
    expect(result.current.nowFor('a')).toBe(T0 + 7);
  });

  it('seeds a plot added later through resync', () => {
    const { result, rerender } = mount([makePlot('a')]);
    vi.setSystemTime(T0 + 2000);
    act(() => result.current.resync(['b']));
    rerender({ p: [makePlot('a'), makePlot('b')], v: NO_VIEW });
    expect(result.current.nowFor('b')).toBe(T0 + 2000);
  });

  it('restarts the interval from a resync', () => {
    const { result } = mount([makePlot('a', { refreshIntervalS: 5 })]);
    advance(3000);
    act(() => result.current.resync(['a']));
    expect(result.current.nowFor('a')).toBe(T0 + 3000);
    advance(4999);
    expect(result.current.nowFor('a')).toBe(T0 + 3000);
    advance(1);
    expect(result.current.nowFor('a')).toBe(T0 + 8000);
  });
});
