import { describe, expect, it } from 'vitest';
import { yColorMap } from './colors';
import { defaultCorrelationState, normalizeCorrelationState, type CorrelationState } from './query';
import { autoYColor, Y_COLORS } from '../shared/colors';

const [A, B, C, D] = ['S:A', 'S:B', 'S:C', 'S:D'];

function state(over: Partial<CorrelationState>): CorrelationState {
  return normalizeCorrelationState({ ...defaultCorrelationState(), ...over });
}

describe('autoYColor', () => {
  it('is Y_COLORS by position, wrapping', () => {
    expect(autoYColor(0)).toBe(Y_COLORS[0]);
    expect(autoYColor(7)).toBe(Y_COLORS[7]);
    expect(autoYColor(8)).toBe(Y_COLORS[0]);
  });
});

describe('yColorMap', () => {
  it('gives each Y its position colour, keyed by PV in ys order', () => {
    const map = yColorMap(state({ ys: [A, B, C] }));
    expect([...map]).toEqual([
      [A, Y_COLORS[0]],
      [B, Y_COLORS[1]],
      [C, Y_COLORS[2]],
    ]);
  });

  it('uses a pinned colour over the automatic one', () => {
    const map = yColorMap(state({ ys: [A, B], colors: { [B]: '#010203' } }));
    expect(map.get(A)).toBe(Y_COLORS[0]);
    expect(map.get(B)).toBe('#010203');
  });

  it('is stable when a middle Y is removed: earlier Ys and pinned colours keep theirs', () => {
    const before = state({ ys: [A, B, C, D], colors: { [D]: '#abcdef' } });
    const after = state({ ...before, ys: [A, C, D] });
    const was = yColorMap(before);
    const now = yColorMap(after);
    expect(now.get(A)).toBe(was.get(A));
    expect(now.get(D)).toBe('#abcdef');
    expect(was.get(D)).toBe('#abcdef');
    // An unpinned Y follows its position in state.ys (pinning holds it against reordering).
    expect(now.get(C)).toBe(Y_COLORS[1]);
    expect(now.has(B)).toBe(false);
  });

  it('depends only on state.ys, so a Y missing from the frame never shifts a neighbour', () => {
    // The map takes no frame: a refused B still holds position 1, so C keeps position 2's colour.
    const map = yColorMap(state({ ys: [A, B, C] }));
    expect(map.get(C)).toBe(Y_COLORS[2]);
  });

  it('ignores inherited keys on the colours record', () => {
    const map = yColorMap({ ys: ['constructor'], colors: {} });
    expect(map.get('constructor')).toBe(Y_COLORS[0]);
  });
});
