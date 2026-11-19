import { describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../annotations/model';
import {
  addDrawing,
  addPv,
  apply,
  patchDrawing,
  removeDrawing,
  groupOf,
  liveFullMessage,
  movePv,
  moveRefusal,
  removePv,
  removeReference,
  setDelta,
  setHidden,
  setLabel,
  setRolling,
  setSnapshot,
  setSpread,
  setReferenceStyle,
  setStyle,
  setVisible,
} from './edit';
import {
  defaultWaveformState,
  MAX_LIVE,
  normalizeWaveformState,
  serializeWaveformQuery,
  type WaveformState,
} from './query';

const A = 'SIM:WF:X';
const B = 'SIM:WF:Y';
const C = 'SIM:COR:WF';
const R = 'SIM:WF:GOLDEN';
const S = 'SIM:WF:S';

function state(over: Partial<WaveformState> = {}): WaveformState {
  return { ...defaultWaveformState(), ...over };
}

function full(): WaveformState {
  return state({ pvs: Array.from({ length: MAX_LIVE }, (_, i) => `LIVE:${i}`) });
}

const frames = (): Record<string, Float64Array> => ({ [A]: new Float64Array([1, 2, 3]) });

describe('apply', () => {
  it('ends every edit in the normalizer', () => {
    const next = apply(state(), (s) => ({ ...s, pvs: [A, A, ` ${B} `], persist: 99 }));
    expect(next).toEqual(normalizeWaveformState(next));
    expect(next.pvs).toEqual([A, B]);
    expect(next.persist).toBe(16);
  });
});

describe('addPv', () => {
  it('appends a Live PV in colour order', () => {
    const r = addPv(state({ pvs: [A] }), 'live', B);
    expect(r.refusal).toBeUndefined();
    expect(r.state.pvs).toEqual([A, B]);
  });

  it('refuses a full Live with "Live is full (8/8)" and leaves the state unchanged', () => {
    const s = full();
    const r = addPv(s, 'live', A);
    expect(r.refusal).toBe('Live is full (8/8)');
    expect(liveFullMessage()).toBe('Live is full (8/8)');
    expect(r.state).toBe(s);
  });

  it('checks capacity against the state it is handed (the latest), not an earlier one', () => {
    // Two adds probed against the same 7-PV state; the second commit sees the first.
    const seven = state({ pvs: Array.from({ length: 7 }, (_, i) => `LIVE:${i}`) });
    const first = addPv(seven, 'live', A);
    expect(first.refusal).toBeUndefined();
    const second = addPv(first.state, 'live', B);
    expect(second.refusal).toBe('Live is full (8/8)');
    expect(second.state.pvs).toHaveLength(8);
  });

  it('refuses a duplicate in any section', () => {
    expect(addPv(state({ pvs: [A] }), 'live', A).refusal).toBe(`${A} is already in Live`);
    const withRef = state({ reference: { kind: 'pv', pv: R } });
    expect(addPv(withRef, 'live', R).refusal).toBe(`${R} is already in Reference`);
    expect(addPv(state({ xs: S }), 'reference', S).refusal).toBe(`${S} is already in X axis PV`);
  });

  it('adds nothing for an empty name and trims the name', () => {
    const s = state();
    expect(addPv(s, 'live', '   ')).toEqual({ state: s });
    expect(addPv(s, 'live', `  ${A} `).state.pvs).toEqual([A]);
  });

  it('keeps a PV of another unit (the axis unit rule is the model’s: kept, not drawn)', () => {
    // addPv takes no unit: a curve of another unit is admitted and the model
    // marks it not drawn.
    const r = addPv(state({ pvs: [A] }), 'live', B);
    expect(r.refusal).toBeUndefined();
    expect(r.state.pvs).toEqual([A, B]);
  });

  it('sets a PV reference and an X source; an occupied one refuses', () => {
    const r = addPv(state(), 'reference', R);
    expect(r.state.reference).toEqual({ kind: 'pv', pv: R });
    expect(addPv(r.state, 'reference', B).refusal).toBe('Reference is full (1/1)');
    const x = addPv(state(), 'xsource', S);
    expect(x.state.xs).toBe(S);
    expect(addPv(x.state, 'xsource', B).refusal).toBe('X axis PV is full (1/1)');
  });

  it('replaces a snapshot reference with a PV reference from the add row', () => {
    const s = setSnapshot(state({ pvs: [A] }), { frames: frames(), time: 1 });
    const r = addPv(s, 'reference', R);
    expect(r.refusal).toBeUndefined();
    expect(r.state.reference).toEqual({ kind: 'pv', pv: R });
  });
});

describe('removePv', () => {
  it('removes from whichever section holds the PV', () => {
    const s = state({ pvs: [A, B], reference: { kind: 'pv', pv: R }, xs: S });
    expect(removePv(s, A).pvs).toEqual([B]);
    expect(removePv(s, R).reference).toBeNull();
    expect(removePv(s, S).xs).toBe('');
    expect(removePv(s, 'NOPE')).toBe(s);
  });

  it('keeps a later curve’s style when an earlier curve is removed', () => {
    const s = state({ pvs: [A, B, C], styles: { [B]: { color: '#ff0000' }, [C]: { width: 3 } } });
    const next = removePv(s, A);
    expect(next.pvs).toEqual([B, C]);
    expect(next.styles).toEqual({ [B]: { color: '#ff0000' }, [C]: { width: 3 } });
    // On the wire the positional array shifts with the curves.
    const q = new URLSearchParams(serializeWaveformQuery(next));
    expect(JSON.parse(q.get('plot')!).traces[0]).toEqual({ color: '#ff0000' });
  });

  it('drops the removed curve’s own style and hidden record', () => {
    const s = state({ pvs: [A, B], styles: { [A]: { color: '#00ff00' } }, hidden: { [A]: true } });
    const next = removePv(s, A);
    expect(next.styles).toEqual({});
    expect(next.hidden).toEqual({});
  });

  it('removing the reference turns Δ off', () => {
    const s = state({ pvs: [A], reference: { kind: 'pv', pv: R }, delta: true });
    expect(removePv(s, R).delta).toBe(false);
    const snap = setDelta(setSnapshot(state({ pvs: [A] }), { frames: frames(), time: 1 }), true);
    const cleared = removeReference(snap);
    expect(cleared.reference).toBeNull();
    expect(cleared.delta).toBe(false);
  });
});

describe('groupOf', () => {
  it('names the section a PV is in', () => {
    const s = state({ pvs: [A], reference: { kind: 'pv', pv: R }, xs: S });
    expect(groupOf(s, A)).toBe('live');
    expect(groupOf(s, R)).toBe('reference');
    expect(groupOf(s, S)).toBe('xsource');
    expect(groupOf(s, B)).toBeNull();
    expect(groupOf(s, '')).toBeNull();
  });
});

describe('moveRefusal', () => {
  it('refuses a move into a full Live with the Group select’s text', () => {
    const s = { ...full(), reference: { kind: 'pv', pv: R } as const, xs: S };
    expect(moveRefusal(s, R, 'live')).toBe('Live is full (8/8)');
    expect(moveRefusal(s, S, 'live')).toBe('Live is full (8/8)');
  });

  it('allows swaps and moves within a full Live', () => {
    const s = { ...full(), reference: { kind: 'pv', pv: R } as const, xs: S };
    expect(moveRefusal(s, 'LIVE:0', 'reference')).toBeNull();
    expect(moveRefusal(s, 'LIVE:0', 'xsource')).toBeNull();
    expect(moveRefusal(s, 'LIVE:0', 'live')).toBeNull();
    expect(moveRefusal(s, R, 'xsource')).toBeNull();
  });
});

describe('movePv', () => {
  it('moves a Live curve to an empty Reference and back, keeping its style and Visible', () => {
    const s = state({
      pvs: [A, B],
      styles: { [A]: { color: '#123456', label: 'golden' } },
      hidden: { [A]: true },
    });
    const toRef = movePv(s, A, 'reference');
    expect(toRef.refusal).toBeUndefined();
    expect(toRef.state.pvs).toEqual([B]);
    expect(toRef.state.reference).toEqual({ kind: 'pv', pv: A });
    expect(toRef.state.styles[A]).toEqual({ color: '#123456', label: 'golden' });
    expect(toRef.state.hidden[A]).toBe(true);
    const back = movePv(toRef.state, A, 'live');
    expect(back.state.pvs).toEqual([B, A]);
    expect(back.state.reference).toBeNull();
    expect(back.state.styles[A]).toEqual({ color: '#123456', label: 'golden' });
  });

  it('swaps an occupied Reference-by-PV: the old reference takes the curve’s Live slot', () => {
    const s = state({
      pvs: [A, B, C],
      reference: { kind: 'pv', pv: R },
      styles: { [B]: { color: '#b00000' }, [R]: { width: 4 } },
    });
    const r = movePv(s, B, 'reference');
    expect(r.state.pvs).toEqual([A, R, C]);
    expect(r.state.reference).toEqual({ kind: 'pv', pv: B });
    expect(r.state.styles).toEqual({ [R]: { width: 4 }, [B]: { color: '#b00000' } });
  });

  it('swaps an occupied X source', () => {
    const s = state({ pvs: [A, B], xs: S, xLabel: 's [m]' });
    const r = movePv(s, A, 'xsource');
    expect(r.refusal).toBeUndefined();
    expect(r.state.xs).toBe(A);
    expect(r.state.pvs).toEqual([S, B]);
    // The X item's Label travels with its PV (the Label is the item's).
    expect(r.state.styles[S]).toEqual({ label: 's [m]' });
    expect(r.state.xLabel).toBeUndefined();
  });

  it('carries a curve’s Label to the X title and back', () => {
    const s = state({ pvs: [A], styles: { [A]: { label: 'position', color: '#abcdef' } } });
    const toX = movePv(s, A, 'xsource');
    expect(toX.state.xs).toBe(A);
    expect(toX.state.xLabel).toBe('position');
    const back = movePv(toX.state, A, 'live');
    expect(back.state.pvs).toEqual([A]);
    expect(back.state.styles[A]).toEqual({ label: 'position' });
    expect(back.state.xLabel).toBeUndefined();
  });

  it('swaps Reference-by-PV and X source', () => {
    const s = state({ pvs: [A], reference: { kind: 'pv', pv: R }, xs: S });
    const r = movePv(s, R, 'xsource');
    expect(r.state.xs).toBe(R);
    expect(r.state.reference).toEqual({ kind: 'pv', pv: S });
  });

  it('replaces a Reference-by-snapshot', () => {
    const s = setSnapshot(state({ pvs: [A, B] }), {
      frames: frames(),
      time: 5,
      style: { color: '#999999' },
    });
    const r = movePv(s, B, 'reference');
    expect(r.refusal).toBeUndefined();
    expect(r.state.pvs).toEqual([A]);
    expect(r.state.reference).toEqual({ kind: 'pv', pv: B });
  });

  it('refuses a move into a full Live and leaves the state unchanged', () => {
    const s = { ...full(), xs: S };
    const r = movePv(s, S, 'live');
    expect(r.refusal).toBe('Live is full (8/8)');
    expect(r.state).toBe(s);
  });

  it('a swap with a full Live is allowed (Live keeps 8)', () => {
    const s = { ...full(), reference: { kind: 'pv', pv: R } as const };
    const r = movePv(s, 'LIVE:3', 'reference');
    expect(r.refusal).toBeUndefined();
    expect(r.state.pvs[3]).toBe(R);
    expect(r.state.pvs).toHaveLength(8);
    expect(r.state.reference).toEqual({ kind: 'pv', pv: 'LIVE:3' });
  });

  it('is a no-op for an unknown PV or the same section', () => {
    const s = state({ pvs: [A] });
    expect(movePv(s, B, 'reference')).toEqual({ state: s });
    expect(movePv(s, A, 'live')).toEqual({ state: s });
  });
});

describe('setHidden / setVisible', () => {
  it('toggles the hidden record of a Live or Reference curve', () => {
    const s = state({ pvs: [A], reference: { kind: 'pv', pv: R } });
    const hidden = setHidden(setHidden(s, A, true), R, true);
    expect(hidden.hidden).toEqual({ [A]: true, [R]: true });
    expect(setVisible(hidden, A, true).hidden).toEqual({ [R]: true });
    expect(setVisible(hidden, R, false).hidden).toEqual({ [A]: true, [R]: true });
  });

  it('ignores a PV that is not a curve', () => {
    expect(setHidden(state({ xs: S }), S, true).hidden).toEqual({});
  });
});

describe('setStyle / setLabel', () => {
  it('merges fields; undefined resets a field; undefined patch resets the record', () => {
    const s = state({ pvs: [A] });
    const a = setStyle(s, A, { color: '#ff0000', width: 2 });
    expect(a.styles[A]).toEqual({ color: '#ff0000', width: 2 });
    const b = setStyle(a, A, { width: undefined, lineType: 'step' });
    expect(b.styles[A]).toEqual({ color: '#ff0000', lineType: 'step' });
    expect(setStyle(b, A, undefined).styles).toEqual({});
    expect(setStyle(b, A, { color: undefined, lineType: undefined }).styles).toEqual({});
  });

  it('setLabel writes the X title for the X source and the style label otherwise', () => {
    const s = state({ pvs: [A], xs: S });
    expect(setLabel(s, S, 'x').xLabel).toBe('x');
    expect(setLabel(setLabel(s, S, 'x'), S, undefined).xLabel).toBeUndefined();
    expect(setLabel(s, A, 'a').styles[A]).toEqual({ label: 'a' });
  });
});

describe('rolling reference and spread', () => {
  it('setRolling replaces any reference and keeps a snapshot’s own style; null clears only a rolling one', () => {
    const fromPv = setRolling(
      state({ pvs: [A], reference: { kind: 'pv', pv: R }, delta: true }),
      60
    );
    expect(fromPv.reference).toEqual({ kind: 'rolling', seconds: 60 });
    expect(fromPv.delta).toBe(true);
    const snap = state({
      pvs: [A],
      reference: {
        kind: 'snapshot',
        frames: { [A]: new Float64Array(2) },
        time: 1,
        style: { label: 'Gold' },
      },
    });
    expect(setRolling(snap, 30).reference).toEqual({
      kind: 'rolling',
      seconds: 30,
      style: { label: 'Gold' },
    });
    expect(setRolling(snap, null).reference).toEqual(snap.reference);
    const cleared = setRolling(fromPv, null);
    expect(cleared.reference).toBeNull();
    expect(cleared.delta).toBe(false);
  });

  it('a rolling window is clamped into 1…3600 s and a snapshot keeps its σ and window', () => {
    expect(setRolling(state({ pvs: [A] }), 9999).reference).toEqual({
      kind: 'rolling',
      seconds: 3600,
    });
    const frozen = setSnapshot(
      state({ pvs: [A], reference: { kind: 'rolling', seconds: 45, style: { color: '#123456' } } }),
      {
        frames: { [A]: Float64Array.of(1) },
        spread: { [A]: Float64Array.of(0.5) },
        time: 7,
        rolling: 45,
      }
    );
    expect(frozen.reference).toMatchObject({
      kind: 'snapshot',
      rolling: 45,
      style: { color: '#123456' },
    });
    expect(
      frozen.reference?.kind === 'snapshot' ? Array.from(frozen.reference.spread![A]) : null
    ).toEqual([0.5]);
  });

  it('setSpread writes 0…3; setReferenceStyle edits a rolling reference’s own style', () => {
    expect(setSpread(state({}), 2).spread).toBe(2);
    expect(setSpread(state({}), 9).spread).toBe(3);
    const styled = setReferenceStyle(
      state({ pvs: [A], reference: { kind: 'rolling', seconds: 60 } }),
      { width: 3 }
    );
    expect(styled.reference).toEqual({ kind: 'rolling', seconds: 60, style: { width: 3 } });
    expect(setReferenceStyle(styled, { width: undefined }).reference).toEqual({
      kind: 'rolling',
      seconds: 60,
    });
  });
});

describe('setSnapshot', () => {
  it('replaces a PV reference at once and keeps the frames by identity', () => {
    const f = frames();
    const s = state({ pvs: [A], reference: { kind: 'pv', pv: R }, delta: true });
    const next = setSnapshot(s, { frames: f, time: 42 });
    expect(next.reference).toEqual({ kind: 'snapshot', frames: f, time: 42 });
    expect(next.reference?.kind === 'snapshot' && next.reference.frames).toBe(f);
    expect(next.delta).toBe(true);
  });

  it('replaces an earlier snapshot; its pinned style survives unless a new one is given', () => {
    const first = setSnapshot(state({ pvs: [A] }), {
      frames: frames(),
      time: 1,
      style: { color: '#777777' },
    });
    const second = setSnapshot(first, { frames: frames(), time: 2 });
    expect(second.reference).toMatchObject({
      kind: 'snapshot',
      time: 2,
      style: { color: '#777777' },
    });
    const third = setSnapshot(second, { frames: frames(), time: 3, style: { width: 2 } });
    expect(third.reference).toMatchObject({ time: 3, style: { width: 2 } });
  });

  it('setReferenceStyle merges into the snapshot item’s own style and does nothing without one', () => {
    const s = setSnapshot(state({ pvs: [A] }), { frames: frames(), time: 1 });
    const styled = setReferenceStyle(s, { color: '#010101', label: 'before' });
    expect(styled.reference).toMatchObject({ style: { color: '#010101', label: 'before' } });
    const reset = setReferenceStyle(styled, undefined);
    expect(reset.reference?.kind === 'snapshot' && reset.reference.style).toBeUndefined();
    const plain = state({ pvs: [A] });
    expect(setReferenceStyle(plain, { color: '#010101' })).toEqual(plain);
  });

  it('Δ with a snapshot is session-only: neither turning it on nor off reaches the query', () => {
    const s = setSnapshot(state({ pvs: [A] }), { frames: frames(), time: 1 });
    const on = setDelta(s, true);
    expect(on.delta).toBe(true);
    const off = setDelta(on, false);
    expect(off.delta).toBe(false);
    expect(serializeWaveformQuery(on)).toBe(serializeWaveformQuery(off));
    expect(serializeWaveformQuery(on)).not.toContain('delta');
  });

  it('Δ is false without a reference', () => {
    expect(setDelta(state({ pvs: [A] }), true).delta).toBe(false);
  });
});

describe('drawings', () => {
  const pin = (i: number, extra: Partial<Annotation> = {}): Annotation => ({
    id: `annotation-${i}`,
    kind: 'hline',
    points: [{ t: 0, v: i }],
    axisId: 'y',
    color: '#123456',
    width: 1.5,
    text: '',
    ...extra,
  });
  const drawn = () =>
    normalizeWaveformState(
      state({
        pvs: [A, B],
        reference: { kind: 'pv', pv: R },
        styles: { [A]: { color: '#ff0000' } },
        hidden: { [B]: true },
        drawings: [pin(0), pin(1)],
      })
    );
  const OTHER_FIELDS = ['pvs', 'reference', 'styles', 'hidden', 'metrics'] as const;

  it("a settings edit keeps drawings' reference", () => {
    const s = drawn();
    for (const next of [
      setDelta(s, true),
      setStyle(s, A, { color: '#00ff00' }),
      setHidden(s, A, true),
      apply(s, (x) => ({ ...x, persist: 8 })),
    ]) {
      expect(next).not.toBe(s);
      expect(next.drawings).toBe(s.drawings);
    }
  });

  it("a drawing commit keeps every other field's reference", () => {
    const s = drawn();
    const added = addDrawing(s, pin(2));
    expect(added.drawings.map((a) => a.id)).toEqual([
      'annotation-0',
      'annotation-1',
      'annotation-2',
    ]);
    const patched = patchDrawing(s, 'annotation-1', { text: 'floor', traceId: A });
    expect(patched.drawings[1]).toMatchObject({ text: 'floor', traceId: A });
    expect(patched.drawings[0]).toBe(s.drawings[0]);
    const removed = removeDrawing(s, 'annotation-0');
    expect(removed.drawings.map((a) => a.id)).toEqual(['annotation-1']);
    expect(removed.drawings[0]).toBe(s.drawings[1]);
    for (const next of [added, patched, removed]) {
      for (const key of OTHER_FIELDS) expect(next[key], key).toBe(s[key]);
    }
  });

  it('a patch removes a key given as undefined', () => {
    const s = normalizeWaveformState(state({ drawings: [pin(0, { traceId: A })] }));
    expect(
      patchDrawing(s, 'annotation-0', { traceId: undefined }).drawings[0].traceId
    ).toBeUndefined();
  });

  it('an unknown id, or an edit that changes nothing, returns the same state', () => {
    const s = drawn();
    expect(patchDrawing(s, 'nope', { text: 'x' })).toBe(s);
    expect(removeDrawing(s, 'nope')).toBe(s);
    expect(apply(s, (x) => ({ ...x }))).toBe(s);
  });

  it('a drawing the catalog lacks is not added', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = drawn();
    expect(addDrawing(s, pin(2, { kind: 'trange' }))).toBe(s);
    vi.restoreAllMocks();
  });

  it('drawings of a removed curve are kept', () => {
    const s = normalizeWaveformState(state({ pvs: [A, B], drawings: [pin(0, { traceId: B })] }));
    expect(removePv(s, B).drawings).toBe(s.drawings);
  });
});
