// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { parseWaveformQuery, type WaveformSnapshot, type WaveformState } from './query';
import { useWaveformStateOut } from './stateOut';
import { createShedStore } from '../../annotations/host/shedStore';
import type { Annotation } from '../../annotations/model';
import { STATE_OUT_DEBOUNCE_MS, pageKeyReserve } from '../shared/publishQuery';

const A = 'SIM:WAVE:A';
const B = 'SIM:WAVE:B';
const R = 'SIM:WAVE:REF';

const OPENING = `pv=${A}&persist=4`;
const PATH = '/x/y/trace/waveform.html';

// Mount the hook the way the app does: the opening state comes from the URL.
function mount(search: string) {
  window.history.replaceState(null, '', `${PATH}${search}`);
  const opening = parseWaveformQuery(window.location.search);
  const hook = renderHook(({ s }) => useWaveformStateOut(s), { initialProps: { s: opening } });
  return { opening, ...hook };
}

function snapshot(): WaveformSnapshot {
  return {
    kind: 'snapshot',
    frames: { [A]: new Float64Array([1, 2, 3]) },
    time: 1_760_000_000_000,
    style: { label: 'Golden orbit', color: '#ff0000' },
  };
}

// A fake parent: the embedding host's window, recording every message.
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

describe('useWaveformStateOut', () => {
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
    mount(`?embedded=true&persist=4&pv=${A}&avg=999`);
    advance(5000);
    expect(post).not.toHaveBeenCalled();
  });

  const edits: [string, (s: WaveformState) => WaveformState, string][] = [
    ['adding a Live PV', (s) => ({ ...s, pvs: [...s.pvs, B] }), `pv=${A}&pv=${B}&persist=4`],
    ['a persist edit', (s) => ({ ...s, persist: 8 }), `pv=${A}&persist=8`],
    [
      'a Reference PV with Δ',
      (s) => ({ ...s, reference: { kind: 'pv', pv: R }, delta: true }),
      `pv=${A}&ref=${R}&delta=1&persist=4`,
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

  it('a burst of edits settles into one post of the last state', () => {
    const { rerender, opening } = mount(`?embedded=true&${OPENING}`);
    rerender({ s: { ...opening, avg: 2 } });
    advance(200);
    rerender({ s: { ...opening, avg: 3 } });
    advance(200);
    rerender({ s: { ...opening, avg: 5 } });
    advance(STATE_OUT_DEBOUNCE_MS);
    expect(posted()).toEqual([`pv=${A}&persist=4&avg=5`]);
    advance(5000);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('an edit back to the posted state before the debounce posts nothing', () => {
    const { rerender, opening } = mount(`?embedded=true&${OPENING}`);
    rerender({ s: { ...opening, persist: 10 } });
    advance(200);
    rerender({ s: { ...opening } });
    advance(5000);
    expect(post).not.toHaveBeenCalled();
  });

  it('taking a snapshot reference (with Δ) changes nothing on the wire and posts nothing', () => {
    const { rerender, opening } = mount(`?embedded=true&${OPENING}`);
    rerender({ s: { ...opening, reference: snapshot(), delta: true } });
    advance(5000);
    expect(post).not.toHaveBeenCalled();
    expect(location.search).toBe(`?embedded=true&${OPENING}`);
  });

  it('a snapshot is absent from a posted query, and so is Δ against it', () => {
    const { rerender, opening } = mount(`?embedded=true&${OPENING}`);
    rerender({ s: { ...opening, pvs: [A, B], reference: snapshot(), delta: true } });
    advance(STATE_OUT_DEBOUNCE_MS);
    expect(posted()).toEqual([`pv=${A}&pv=${B}&persist=4`]);
    const params = new URLSearchParams(location.search);
    for (const q of [posted()[0], location.search]) {
      expect(q).not.toMatch(/ref=|delta=|snapshot|Golden|ff0000/);
    }
    expect(params.getAll('pv')).toEqual([A, B]);
  });

  it('replacing a Reference PV by a snapshot posts its removal', () => {
    const { rerender, opening } = mount(`?embedded=true&${OPENING}&ref=${R}&delta=1`);
    rerender({ s: { ...opening, reference: snapshot() } });
    advance(STATE_OUT_DEBOUNCE_MS);
    expect(posted()).toEqual([`pv=${A}&persist=4`]);
  });

  it('rewrites its own URL in place, keeping theme and embedded', () => {
    const { rerender, opening } = mount(`?embedded=true&theme=dark&${OPENING}#h`);
    const before = window.history.length;
    rerender({ s: { ...opening, hz: 2 } });
    advance(STATE_OUT_DEBOUNCE_MS);
    expect(window.history.length).toBe(before);
    expect(location.pathname).toBe(PATH);
    expect(location.hash).toBe('#h');
    const params = new URLSearchParams(location.search);
    expect(params.get('embedded')).toBe('true');
    expect(params.get('theme')).toBe('dark');
    expect(params.get('hz')).toBe('2');
    expect(params.getAll('pv')).toEqual([A]);
  });

  it('posts nothing standalone and leaves the URL alone', () => {
    const { rerender, opening } = mount(`?${OPENING}`);
    rerender({ s: { ...opening, persist: 12 } });
    advance(5000);
    expect(post).not.toHaveBeenCalled();
    expect(window.location.search).toBe(`?${OPENING}`);
  });
});

describe('useWaveformStateOut: drawings', () => {
  const note = (i: number, text: string): Annotation => ({
    id: `annotation-${i}`,
    kind: 'note',
    points: [{ t: i, v: i }],
    axisId: 'y',
    color: '#123456',
    width: 1.5,
    text,
  });

  it('reserves the bytes of the page keys this page carries', () => {
    window.history.replaceState(null, '', `${PATH}?embedded=true&theme=dark&pv=${A}`);
    expect(pageKeyReserve()).toBe('theme=dark&embedded=true'.length + 1);
    window.history.replaceState(null, '', `${PATH}?pv=${A}`);
    expect(pageKeyReserve()).toBe(0);
  });

  it('publishes what the link could not carry, and the URL it writes reloads with its drawings', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shed = createShedStore();
    window.history.replaceState(null, '', `${PATH}?embedded=true&theme=dark&${OPENING}`);
    const opening = parseWaveformQuery(window.location.search);
    const { rerender } = renderHook(({ s }) => useWaveformStateOut(s, { shed }), {
      initialProps: { s: opening },
    });
    expect(shed.get()).toEqual({ dropped: 0, trimmed: 0 });

    const drawings = Array.from({ length: 64 }, (_, i) => note(i, `${i}:${'n'.repeat(120)}`));
    rerender({ s: { ...opening, drawings } });
    expect(shed.get().trimmed).toBeGreaterThan(0);
    advance(STATE_OUT_DEBOUNCE_MS);
    const search = window.location.search.slice(1);
    expect(new TextEncoder().encode(search).length).toBeLessThanOrEqual(4096);
    const back = parseWaveformQuery(window.location.search);
    expect(back.drawings).toHaveLength(64 - shed.get().dropped);
    expect(back.persist).toBe(4);

    // A snapshot reference with a Δ drawing: nothing to write, one dropped.
    const snap = { ...opening, reference: snapshot(), delta: true };
    rerender({ s: { ...snap, drawings: [{ ...note(0, ''), delta: true as const }] } });
    expect(shed.get()).toEqual({ dropped: 1, trimmed: 0 });
  });
});
