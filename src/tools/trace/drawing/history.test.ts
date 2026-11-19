// Pins Trace's drawing undo over its plots: one ring entry per changed plot,
// coalescing within 500 ms, the ring depth, the `undo`/`rehydrate` tags, the
// pure axis migration that is not an undo step, and the restore through
// `reassignUnknownAxes`.
import { describe, expect, it } from 'vitest';
import type { Axis, Plot } from '../../../types';
import { COALESCE_MS, HISTORY_DEPTH } from '../../../annotations/history';
import type { Annotation } from '../../../annotations/model';
import {
  type AnnotationHistoryState,
  popAnnotationHistory,
  withAnnotationHistory,
} from './history';

function axis(id: string): Axis {
  return { id, name: id, orientation: 'left', autoScale: true, logScale: false, visible: true };
}

function ann(id: string, extra: Partial<Annotation> = {}): Annotation {
  return {
    id,
    kind: 'hline',
    points: [{ t: 0, v: 1 }],
    axisId: 'a1',
    color: 'c0',
    width: 1.5,
    text: '',
    ...extra,
  };
}

function plot(id: string, annotations?: Annotation[], axes = [axis('a1')]): Plot {
  const p = { id, title: id, traces: [], axes } as unknown as Plot;
  return annotations ? { ...p, annotations } : p;
}

function state(plots: Plot[], history = new Map<string, Annotation[][]>()): AnnotationHistoryState {
  return { plots, history };
}

/** `s` with plot `id`'s annotations replaced by `list`. */
function write(s: AnnotationHistoryState, id: string, list: Annotation[]): AnnotationHistoryState {
  return {
    ...s,
    plots: s.plots.map((p) => (p.id === id ? { ...p, annotations: list } : p)),
  };
}

function step(
  s: AnnotationHistoryState,
  id: string,
  list: Annotation[],
  nowMs: number,
  tag?: 'undo' | 'rehydrate'
): AnnotationHistoryState {
  return withAnnotationHistory(s, write(s, id, list), tag, nowMs);
}

describe('withAnnotationHistory', () => {
  it('pushes the previous list (absent as []) when a plot’s annotations change', () => {
    const s0 = state([plot('A')]);
    const s1 = step(s0, 'A', [ann('x')], 0);
    expect(s1.history.get('A')).toEqual([[]]);
    expect(s0.history.size).toBe(0);
  });

  it('returns `next` itself when no annotations changed', () => {
    const s0 = state([plot('A', [ann('x')])]);
    const next = { ...s0, plots: s0.plots.map((p) => ({ ...p, title: 'T' })) };
    expect(withAnnotationHistory(s0, next, undefined, 0)).toBe(next);
  });

  it('records each changed plot in its own ring', () => {
    const s0 = state([plot('A'), plot('B', [ann('b')])]);
    const next = write(write(s0, 'A', [ann('a')]), 'B', []);
    const s1 = withAnnotationHistory(s0, next, undefined, 0);
    expect(s1.history.get('A')).toEqual([[]]);
    expect(s1.history.get('B')).toEqual([[ann('b')]]);
  });

  it('coalesces consecutive writes to the same single drawing within 500 ms', () => {
    let s = step(state([plot('A')]), 'A', [ann('x')], 0);
    s = step(s, 'A', [ann('x', { color: 'c1' })], 1000);
    s = step(s, 'A', [ann('x', { color: 'c2' })], 1000 + COALESCE_MS - 1);
    s = step(s, 'A', [ann('x', { color: 'c3' })], 1000 + 2 * COALESCE_MS - 2);
    expect(s.history.get('A')).toEqual([[], [ann('x')]]);
  });

  it('does not coalesce after the window, nor across different drawings', () => {
    let s = step(state([plot('A')]), 'A', [ann('x'), ann('y')], 0);
    s = step(s, 'A', [ann('x', { color: 'c1' }), ann('y')], 1000);
    s = step(s, 'A', [ann('x', { color: 'c2' }), ann('y')], 1000 + COALESCE_MS + 1);
    expect(s.history.get('A')).toHaveLength(3);
    s = step(s, 'A', [ann('x', { color: 'c2' }), ann('y', { color: 'c9' })], 1600);
    expect(s.history.get('A')).toHaveLength(4);
  });

  it('never coalesces an add or a delete', () => {
    let s = step(state([plot('A')]), 'A', [ann('x')], 0);
    s = step(s, 'A', [ann('x'), ann('y')], 10);
    s = step(s, 'A', [ann('x')], 20);
    expect(s.history.get('A')).toHaveLength(3);
  });

  it('keeps at most HISTORY_DEPTH entries, dropping the oldest', () => {
    let s = state([plot('A')]);
    for (let i = 0; i <= HISTORY_DEPTH + 4; i++) {
      s = step(s, 'A', [ann(`x${i}`)], i * 1000);
    }
    const ring = s.history.get('A')!;
    expect(ring).toHaveLength(HISTORY_DEPTH);
    expect(ring.at(-1)).toEqual([ann(`x${HISTORY_DEPTH + 3}`)]);
  });

  it.each(['undo', 'rehydrate'] as const)('records nothing for a write tagged %s', (tag) => {
    const s0 = step(state([plot('A')]), 'A', [ann('x')], 0);
    const s1 = step(s0, 'A', [ann('y')], 5000, tag);
    expect(s1.history.get('A')).toEqual([[]]);
  });

  it('a write after an undo is a fresh step, never coalesced into the undone one', () => {
    let s = step(state([plot('A')]), 'A', [ann('x')], 0);
    s = step(s, 'A', [ann('x', { color: 'c1' })], 1000);
    s = withAnnotationHistory(s, popAnnotationHistory(s, 'A'), 'undo', 1100);
    s = step(s, 'A', [ann('x', { color: 'c2' })], 1200);
    expect(s.history.get('A')).toEqual([[], [ann('x')]]);
  });

  it('records no entry for a pure migration off a removed axis', () => {
    const axes = [axis('a1'), axis('a2')];
    const s0 = state([plot('A', [ann('x', { axisId: 'a2' })], axes)], new Map([['A', [[]]]]));
    const migrated = {
      ...s0,
      plots: [plot('A', [ann('x', { axisId: 'a1' })], [axis('a1')])],
    };
    const s1 = withAnnotationHistory(s0, migrated, undefined, 0);
    expect(s1.history.get('A')).toEqual([[]]);
  });

  it('is pure: the same transition applied twice records one entry each time', () => {
    const s0 = state([plot('A')]);
    const next = write(s0, 'A', [ann('x')]);
    const r1 = withAnnotationHistory(s0, next, undefined, 7);
    const r2 = withAnnotationHistory(s0, next, undefined, 7);
    expect(r1.history.get('A')).toEqual([[]]);
    expect(r2).toEqual(r1);
    expect(s0.history.size).toBe(0);
  });
});

describe('popAnnotationHistory', () => {
  it('restores the newest entry and pops it', () => {
    let s = step(state([plot('A')]), 'A', [ann('x')], 0);
    s = step(s, 'A', [ann('x'), ann('y')], 1000);
    const u = popAnnotationHistory(s, 'A');
    expect(u.plots[0].annotations).toEqual([ann('x')]);
    expect(u.history.get('A')).toEqual([[]]);
    const u2 = popAnnotationHistory(u, 'A');
    expect('annotations' in u2.plots[0]).toBe(false);
    expect(u2.history.get('A')).toEqual([]);
  });

  it('returns the state itself when the ring is empty or the plot is gone', () => {
    const s = state([plot('A')]);
    expect(popAnnotationHistory(s, 'A')).toBe(s);
    const t = state([plot('A')], new Map([['B', [[]]]]));
    expect(popAnnotationHistory(t, 'B')).toBe(t);
  });

  it('moves every restored drawing onto an axis the plot still has', () => {
    const s = state(
      [plot('A', [], [axis('a1')])],
      new Map([['A', [[ann('x', { axisId: 'gone' })]]]])
    );
    const u = popAnnotationHistory(s, 'A');
    expect(u.plots[0].annotations!.map((a) => a.axisId)).toEqual(['a1']);
  });
});
