// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { STATE_OUT_DEBOUNCE_MS, useTraceStateOut, type StateOutPlot } from './stateOut';
import { buildInitialPlots } from './initialPlots';

const A = 'TEST:DIAG:BPM:01:POSITION:X';
const B = 'TEST:DIAG:BPM:02:POSITION:X';
const C = 'TEST:DIAG:BPM:03:POSITION:X';

function plot(pvs: string[], xAxis: StateOutPlot['xAxis'] = { timeRange: '-1h' }): StateOutPlot {
  return { traces: pvs.map((pvName) => ({ kind: 'pv', pvName })), xAxis };
}

function mount(search: string, plots: StateOutPlot[]) {
  window.history.replaceState(null, '', `/x/y/trace/${search}`);
  return renderHook(({ p }) => useTraceStateOut(p), { initialProps: { p: plots } });
}

let post: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('useTraceStateOut', () => {
  it('posts nothing on mount', () => {
    mount('?embedded=true&theme=dark', [plot([A])]);
    advance(2000);
    expect(post).not.toHaveBeenCalled();
  });

  it('posts once, debounced, after rapid edits of plot 0', () => {
    const { rerender } = mount('?embedded=true&theme=dark', [plot([A])]);
    rerender({ p: [plot([A, B])] });
    advance(200);
    rerender({ p: [plot([A, B, C])] });
    advance(200);
    rerender({ p: [plot([A, B, C], { timeRange: '-15m' })] });
    advance(STATE_OUT_DEBOUNCE_MS - 1);
    expect(post).not.toHaveBeenCalled();
    advance(1);
    const query = `pv=${A}&pv=${B}&pv=${C}&range=-15m`;
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ type: 'canopy:trace-query', query }, location.origin);
    advance(5000);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('rewrites its own URL in place, keeping theme and embedded', () => {
    const { rerender } = mount('?embedded=true&theme=dark&pv=OLD:PV&range=-1h', [plot([A])]);
    const before = window.history.length;
    rerender({ p: [plot([B])] });
    advance(STATE_OUT_DEBOUNCE_MS);
    expect(window.history.length).toBe(before);
    expect(location.pathname).toBe('/x/y/trace/');
    const params = new URLSearchParams(location.search);
    expect(params.get('embedded')).toBe('true');
    expect(params.get('theme')).toBe('dark');
    expect(params.getAll('pv')).toEqual([B]);
    expect(params.get('range')).toBe('-1h');
  });

  it('keeps the host-bar flag through a state write', () => {
    const { rerender } = mount('?embedded=true&hostbar=1&pv=OLD:PV', [plot([A])]);
    rerender({ p: [plot([B])] });
    advance(STATE_OUT_DEBOUNCE_MS);
    const params = new URLSearchParams(location.search);
    expect(params.get('hostbar')).toBe('1');
    expect(params.getAll('pv')).toEqual([B]);
  });

  it('serializes a custom window', () => {
    const { rerender } = mount('?embedded=true', [plot([A])]);
    rerender({
      p: [
        plot([A], {
          timeRange: 'custom',
          timeFrom: '2026-09-30T10:00',
          timeTo: '2026-09-30T11:30',
        }),
      ],
    });
    advance(STATE_OUT_DEBOUNCE_MS);
    const query = `pv=${A}&range=custom&from=2026-09-30T10:00&to=2026-09-30T11:30`;
    expect(post).toHaveBeenCalledWith({ type: 'canopy:trace-query', query }, location.origin);
    const params = new URLSearchParams(location.search);
    expect(params.get('from')).toBe('2026-09-30T10:00');
    expect(params.get('to')).toBe('2026-09-30T11:30');
  });

  it('serializes an open-ended custom window without `to`', () => {
    const { rerender } = mount('?embedded=true', [plot([A])]);
    rerender({ p: [plot([A], { timeRange: 'custom', timeFrom: '2026-09-30T10:00' })] });
    advance(STATE_OUT_DEBOUNCE_MS);
    const query = `pv=${A}&range=custom&from=2026-09-30T10:00`;
    expect(post).toHaveBeenCalledWith({ type: 'canopy:trace-query', query }, location.origin);
  });

  it('ignores formula traces and plots after the first', () => {
    const { rerender } = mount('?embedded=true', [plot([A]), plot([B])]);
    rerender({ p: [plot([A]), plot([B, C])] });
    advance(STATE_OUT_DEBOUNCE_MS * 2);
    expect(post).not.toHaveBeenCalled();
    const withFormula: StateOutPlot = {
      traces: [
        { kind: 'pv', pvName: A },
        { kind: 'formula', pvName: 'f(x)' },
      ],
      xAxis: { timeRange: '-1h' },
    };
    rerender({ p: [withFormula, plot([B, C])] });
    advance(STATE_OUT_DEBOUNCE_MS * 2);
    expect(post).not.toHaveBeenCalled();
  });

  it('does not post when the edit returns to the last posted state', () => {
    const { rerender } = mount('?embedded=true', [plot([A])]);
    rerender({ p: [plot([A, B])] });
    advance(100);
    rerender({ p: [plot([A])] });
    advance(STATE_OUT_DEBOUNCE_MS * 2);
    expect(post).not.toHaveBeenCalled();
  });

  it('posts nothing and leaves the URL alone when not embedded', () => {
    const { rerender } = mount('?theme=dark', [plot([A])]);
    rerender({ p: [plot([A, B])] });
    advance(STATE_OUT_DEBOUNCE_MS * 2);
    expect(post).not.toHaveBeenCalled();
    expect(location.search).toBe('?theme=dark');
  });

  it('posts the plot config when an axis changes, and only once', () => {
    const { rerender } = mount('?embedded=true', [plot([A, B])]);
    const logAxis: StateOutPlot = {
      ...plot([A, B]),
      axes: [
        {
          id: 'y-axis-1',
          name: 'Y-Axis 1',
          orientation: 'left',
          autoScale: true,
          logScale: false,
          visible: true,
        },
        {
          id: 'ax-2',
          name: 'Current',
          orientation: 'right',
          autoScale: false,
          min: 0,
          max: 5,
          logScale: true,
          visible: true,
        },
      ],
      traces: [
        { kind: 'pv', pvName: A, axisId: 'y-axis-1' },
        { kind: 'pv', pvName: B, axisId: 'ax-2' },
      ],
    };
    rerender({ p: [logAxis] });
    advance(STATE_OUT_DEBOUNCE_MS);
    expect(post).toHaveBeenCalledTimes(1);
    const { query } = post.mock.calls[0][0] as { query: string };
    const params = new URLSearchParams(query);
    expect(params.getAll('pv')).toEqual([A, B]);
    expect(JSON.parse(params.get('plot') ?? '')).toEqual({
      v: 1,
      axes: [
        {},
        { name: 'Current', orientation: 'right', autoScale: false, min: 0, max: 5, logScale: true },
      ],
      traces: [{}, { axis: 1 }],
    });
    rerender({ p: [{ ...logAxis, traces: logAxis.traces.map((t) => ({ ...t })) }] });
    advance(STATE_OUT_DEBOUNCE_MS * 2);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('posts nothing for a plot opened from a query with a plot config', () => {
    const search =
      `?embedded=true&pv=${A}&pv=${B}&range=-1h&plot=` +
      encodeURIComponent(
        JSON.stringify({
          v: 1,
          axes: [{}, { logScale: true, autoScale: false, min: 1, max: 100 }],
          traces: [{ color: '#123456' }, { axis: 1 }],
        })
      );
    const plots = buildInitialPlots(search);
    const { rerender } = mount(search, plots);
    rerender({ p: plots.map((p) => ({ ...p })) });
    advance(STATE_OUT_DEBOUNCE_MS * 2);
    expect(post).not.toHaveBeenCalled();
  });

  it('posts when only a display option changes', () => {
    const { rerender } = mount('?embedded=true', [plot([A])]);
    rerender({ p: [{ ...plot([A]), showLegend: false }] });
    advance(STATE_OUT_DEBOUNCE_MS);
    const query = `pv=${A}&range=-1h&plot={%22v%22:1,%22showLegend%22:false}`;
    expect(post).toHaveBeenCalledWith({ type: 'canopy:trace-query', query }, location.origin);
  });
});
