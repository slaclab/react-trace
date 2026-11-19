// The drawing tools' link key: `rail=0` while off, nothing while on; a link
// without it (or with `rail=1`) opens with the tools on, and a bad value
// falls back to on with the usual warning.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultCorrelationState,
  normalizeCorrelationState,
  parseCorrelationQuery,
  serializeCorrelationQuery,
  type CorrelationState,
} from './query';

const BASE = 'x=SIM:X&y=SIM:Y1';

function state(over: Partial<CorrelationState> = {}): CorrelationState {
  return normalizeCorrelationState({
    ...defaultCorrelationState(),
    x: 'SIM:X',
    ys: ['SIM:Y1'],
    ...over,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Correlation drawing tools on the link', () => {
  it('writes rail=0 only while off, and reads it back', () => {
    const off = state({ drawingTools: false });
    const q = serializeCorrelationQuery(off);
    expect(q.split('&')).toContain('rail=0');
    expect(parseCorrelationQuery(q).drawingTools).toBe(false);
    expect(serializeCorrelationQuery(state())).not.toContain('rail');
  });

  it('opens a link without the key, or with rail=1, with the tools on', () => {
    expect('drawingTools' in parseCorrelationQuery(BASE)).toBe(false);
    expect('drawingTools' in parseCorrelationQuery(`${BASE}&rail=1`)).toBe(false);
    expect(serializeCorrelationQuery(parseCorrelationQuery(`${BASE}&rail=1`))).not.toContain(
      'rail'
    );
  });

  it('warns on a bad value and keeps the tools on', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseCorrelationQuery(`${BASE}&rail=no`).drawingTools).toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).toContain('rail');
  });

  it('keeps only the off value through the normalizer', () => {
    expect('drawingTools' in state({ drawingTools: undefined })).toBe(false);
    expect(
      'drawingTools' in normalizeCorrelationState({ ...state(), drawingTools: true as never })
    ).toBe(false);
    expect(state({ drawingTools: false }).drawingTools).toBe(false);
  });
});
