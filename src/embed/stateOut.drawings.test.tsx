// @vitest-environment jsdom
// Drawings ride in the reported state of plot 0 only: a drawing on plot 0 is
// posted with `plot=...drawings`; a drawing on plot 1 does not change the
// state key, so nothing is posted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { defaultAnnotationColor } from '../annotationTheme';
import type { Annotation } from '../annotations/model';
import type { Plot } from '../types';
import { buildInitialPlots } from './initialPlots';
import { parseTraceQuery } from './query';
import { STATE_OUT_DEBOUNCE_MS, useTraceStateOut, type StateOutPlot } from './stateOut';

const A = 'TEST:DIAG:BPM:01:POSITION:X';
const B = 'TEST:DIAG:BPM:02:POSITION:X';

function opened(search: string): Plot {
  const [plot] = buildInitialPlots(search);
  return plot;
}

function hline(axisId: string, v: number): Annotation {
  return {
    id: `annotation-${v}`,
    kind: 'hline',
    points: [{ t: 0, v }],
    axisId,
    color: defaultAnnotationColor(0),
    width: 0.75,
    text: 'limit',
  };
}

function mount(plots: StateOutPlot[]) {
  window.history.replaceState(null, '', '/x/y/trace/?embedded=true');
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

describe('useTraceStateOut: drawings', () => {
  it('a drawing on plot 1 does not change the state: nothing is posted', () => {
    const p0 = opened(`?pv=${A}&range=-1h`);
    const p1 = opened(`?pv=${B}&range=-1h`);
    const { rerender } = mount([p0, p1]);
    rerender({ p: [p0, { ...p1, annotations: [hline(p1.axes[0].id, 2)] }] });
    advance(STATE_OUT_DEBOUNCE_MS * 4);
    expect(post).not.toHaveBeenCalled();
  });

  it('a drawing on plot 0 is posted once, carried in the plot config', () => {
    const p0 = opened(`?pv=${A}&range=-1h`);
    const p1 = opened(`?pv=${B}&range=-1h`);
    const { rerender } = mount([p0, p1]);
    rerender({ p: [{ ...p0, annotations: [hline(p0.axes[0].id, 2)] }, p1] });
    advance(STATE_OUT_DEBOUNCE_MS);
    expect(post).toHaveBeenCalledTimes(1);
    const { query } = post.mock.calls[0][0] as { query: string };
    const parsed = parseTraceQuery(query);
    expect(parsed.pvs).toEqual([A]);
    expect(parsed.plot?.drawings).toEqual([[0, [2], 0, null, '', 'limit']]);
  });

  it('moving a drawing on plot 0 posts again; the same drawings do not', () => {
    const p0 = opened(`?pv=${A}&range=-1h`);
    const withOne = { ...p0, annotations: [hline(p0.axes[0].id, 2)] };
    const { rerender } = mount([withOne]);
    rerender({ p: [{ ...withOne, annotations: [hline(p0.axes[0].id, 2)] }] });
    advance(STATE_OUT_DEBOUNCE_MS * 2);
    expect(post).not.toHaveBeenCalled();
    rerender({ p: [{ ...withOne, annotations: [hline(p0.axes[0].id, 3)] }] });
    advance(STATE_OUT_DEBOUNCE_MS);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
