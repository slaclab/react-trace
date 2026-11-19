// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createShedStore, NO_SHED } from '../../annotations/host/shedStore';
import type { Annotation } from '../../annotations/model';
import { MAX_QUERY_BYTES, parseCorrelationQuery, type CorrelationState } from './query';
import { useCorrelationStateOut } from './stateOut';
import { STATE_OUT_DEBOUNCE_MS } from '../shared/publishQuery';

const X = 'SIM:DIAG:BPM:01:POSITION:X';
const Y1 = 'SIM:DIAG:BPM:02:POSITION:X';
const Y2 = 'SIM:DIAG:BPM:03:POSITION:X';
const T = 'SIM:TIMING:TRIGGER';

const OPENING = `x=${X}&y=${Y1}&dt=1&n=1000&lookback=1h&view=scatter`;

// Mount the hook the way main.tsx does: the opening state comes from the URL.
function mount(search: string) {
  window.history.replaceState(null, '', `/x/y/trace/correlation.html${search}`);
  const opening = parseCorrelationQuery(window.location.search);
  const hook = renderHook(({ s }) => useCorrelationStateOut(s), { initialProps: { s: opening } });
  return { opening, ...hook };
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

function posted(): string[] {
  return post.mock.calls.map((call: unknown[]) => (call[0] as { query: string }).query);
}

describe('useCorrelationStateOut', () => {
  it('loading a query posts nothing and leaves the URL alone', () => {
    const search = `?embedded=true&theme=dark&${OPENING}`;
    const { rerender, opening } = mount(search);
    rerender({ s: { ...opening } });
    advance(5000);
    expect(post).not.toHaveBeenCalled();
    expect(window.location.search).toBe(search);
  });

  it('a non-canonical opening query is not echoed either', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount(`?embedded=true&y=${Y1}&n=0&x=${X}`);
    advance(5000);
    expect(post).not.toHaveBeenCalled();
  });

  const edits: [string, (s: CorrelationState) => CorrelationState, string][] = [
    [
      'a role edit (X)',
      (s) => ({ ...s, x: Y2 }),
      `x=${Y2}&y=${Y1}&dt=1&n=1000&lookback=1h&view=scatter`,
    ],
    [
      'a role edit (add Y)',
      (s) => ({ ...s, ys: [...s.ys, Y2] }),
      `x=${X}&y=${Y1}&y=${Y2}&dt=1&n=1000&lookback=1h&view=scatter`,
    ],
    [
      'a trigger edit',
      (s) => ({ ...s, trigger: { mode: 'pv', pv: T } }),
      `x=${X}&y=${Y1}&trig=${T}&n=1000&lookback=1h&view=scatter`,
    ],
    ['an n edit', (s) => ({ ...s, n: 250 }), `x=${X}&y=${Y1}&dt=1&n=250&lookback=1h&view=scatter`],
    [
      'an axes edit',
      (s) => ({ ...s, axes: 'split' }),
      `x=${X}&y=${Y1}&dt=1&n=1000&lookback=1h&view=scatter&axes=split`,
    ],
  ];

  for (const [name, edit, query] of edits) {
    it(`${name} gives exactly one post, debounced`, () => {
      const { rerender, opening } = mount(`?embedded=true&theme=dark&${OPENING}`);
      rerender({ s: edit(opening) });
      advance(STATE_OUT_DEBOUNCE_MS - 1);
      expect(post).not.toHaveBeenCalled();
      advance(1);
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith({ type: 'canopy:trace-query', query }, location.origin);
      advance(5000);
      expect(post).toHaveBeenCalledTimes(1);
    });
  }

  it('rapid edits settle into one post of the last state', () => {
    const { rerender, opening } = mount(`?embedded=true&${OPENING}`);
    rerender({ s: { ...opening, n: 10 } });
    advance(200);
    rerender({ s: { ...opening, n: 20 } });
    advance(200);
    rerender({ s: { ...opening, n: 30 } });
    advance(STATE_OUT_DEBOUNCE_MS);
    expect(posted()).toEqual([`x=${X}&y=${Y1}&dt=1&n=30&lookback=1h&view=scatter`]);
  });

  it('an edit back to the posted state before the debounce posts nothing', () => {
    const { rerender, opening } = mount(`?embedded=true&${OPENING}`);
    rerender({ s: { ...opening, n: 10 } });
    advance(200);
    rerender({ s: { ...opening } });
    advance(5000);
    expect(post).not.toHaveBeenCalled();
  });

  it('rewrites its own URL in place, keeping theme and embedded', () => {
    const { rerender, opening } = mount(`?embedded=true&theme=dark&${OPENING}`);
    const before = window.history.length;
    rerender({ s: { ...opening, n: 42 } });
    advance(STATE_OUT_DEBOUNCE_MS);
    expect(window.history.length).toBe(before);
    expect(location.pathname).toBe('/x/y/trace/correlation.html');
    const params = new URLSearchParams(location.search);
    expect(params.get('embedded')).toBe('true');
    expect(params.get('theme')).toBe('dark');
    expect(params.get('n')).toBe('42');
    expect(params.getAll('y')).toEqual([Y1]);
  });

  it('keeps the host-bar flag through a state write', () => {
    const { rerender, opening } = mount(`?embedded=true&hostbar=1&${OPENING}`);
    rerender({ s: { ...opening, n: 42 } });
    advance(STATE_OUT_DEBOUNCE_MS);
    const params = new URLSearchParams(location.search);
    expect(params.get('hostbar')).toBe('1');
    expect(params.get('n')).toBe('42');
  });

  it('does nothing when not embedded', () => {
    const { rerender, opening } = mount(`?${OPENING}`);
    rerender({ s: { ...opening, n: 42 } });
    advance(5000);
    expect(post).not.toHaveBeenCalled();
    expect(window.location.search).toBe(`?${OPENING}`);
  });
});

describe('useCorrelationStateOut: drawings', () => {
  const note = (i: number, text: string): Annotation => ({
    id: `annotation-${i}`,
    kind: 'note',
    points: [{ t: i, v: i }],
    // Each on its own long PV, so the reference table outgrows the budget.
    axisId: `PV:${'Z'.repeat(400)}:${i}`,
    color: '#123456',
    width: 1.5,
    text,
  });

  function mountWithShed(search: string) {
    window.history.replaceState(null, '', `/x/y/trace/correlation.html${search}`);
    const opening = parseCorrelationQuery(window.location.search);
    const shed = createShedStore();
    const hook = renderHook(({ s }) => useCorrelationStateOut(s, { shed }), {
      initialProps: { s: opening },
    });
    return { opening, shed, ...hook };
  }

  it('publishes the shed counts, and nothing shed when the drawings fit', () => {
    const { rerender, opening, shed } = mountWithShed(`?embedded=true&${OPENING}`);
    expect(shed.get()).toBe(NO_SHED);
    rerender({ s: { ...opening, drawings: [{ ...note(0, 'short'), axisId: Y1 }] } });
    expect(shed.get()).toEqual({ dropped: 0, trimmed: 0 });

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = Array.from({ length: 64 }, (_, i) => note(i, 'n'.repeat(150)));
    rerender({ s: { ...opening, drawings: many } });
    expect(shed.get().dropped).toBeGreaterThan(0);
    expect(shed.get().trimmed).toBeGreaterThan(0);
  });

  it('the URL it writes, page keys included, fits and reloads with the drawings it kept', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { rerender, opening, shed } = mountWithShed(`?embedded=true&theme=light&${OPENING}`);
    const many = Array.from({ length: 64 }, (_, i) => note(i, 'n'.repeat(150)));
    rerender({ s: { ...opening, drawings: many } });
    advance(STATE_OUT_DEBOUNCE_MS);
    expect(post).toHaveBeenCalledTimes(1);
    const search = window.location.search.slice(1);
    expect(new TextEncoder().encode(search).length).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    const back = parseCorrelationQuery(window.location.search);
    expect(back.drawings).toHaveLength(many.length - shed.get().dropped);
    expect(back.drawings.length).toBeGreaterThan(0);
  });
});
