// The drawing tools' link key: `rail=0` while off, nothing while on; a link
// without it (or with `rail=1`) opens with the tools on, and a bad value
// falls back to on with the usual warning.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultWaveformState,
  normalizeWaveformState,
  parseWaveformQuery,
  serializeWaveformQuery,
  type WaveformState,
} from './query';

const BASE = 'pv=SIM:WF:X';

function state(over: Partial<WaveformState> = {}): WaveformState {
  return normalizeWaveformState({ ...defaultWaveformState(), pvs: ['SIM:WF:X'], ...over });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Waveform drawing tools on the link', () => {
  it('writes rail=0 only while off, and reads it back', () => {
    const q = serializeWaveformQuery(state({ drawingTools: false }));
    expect(q.split('&')).toContain('rail=0');
    expect(parseWaveformQuery(q).drawingTools).toBe(false);
    expect(serializeWaveformQuery(state())).not.toContain('rail');
  });

  it('opens a link without the key, or with rail=1, with the tools on', () => {
    expect('drawingTools' in parseWaveformQuery(BASE)).toBe(false);
    expect('drawingTools' in parseWaveformQuery(`${BASE}&rail=1`)).toBe(false);
    expect(serializeWaveformQuery(parseWaveformQuery(`${BASE}&rail=1`))).not.toContain('rail');
  });

  it('warns on a bad value and keeps the tools on', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseWaveformQuery(`${BASE}&rail=no`).drawingTools).toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).toContain('rail');
  });

  it('keeps only the off value through the normalizer', () => {
    expect(state({ drawingTools: undefined }).drawingTools).toBeUndefined();
    expect(
      'drawingTools' in normalizeWaveformState({ ...state(), drawingTools: true as never })
    ).toBe(false);
    expect(state({ drawingTools: false }).drawingTools).toBe(false);
  });
});
