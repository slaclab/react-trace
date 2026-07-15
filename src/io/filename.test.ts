import { describe, it, expect } from 'vitest';
import { safeFilename, timestamp } from './filename';

describe('safeFilename', () => {
  it('replaces filesystem-illegal characters with underscores', () => {
    expect(safeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('collapses whitespace runs to single dashes', () => {
    expect(safeFilename('Plot   1\tA')).toBe('Plot-1-A');
  });

  it('falls back to a default when the input is empty', () => {
    expect(safeFilename('')).toBe('plot');
    expect(safeFilename('', 'custom')).toBe('custom');
  });

  it('leaves a clean title untouched', () => {
    expect(safeFilename('Plot-1')).toBe('Plot-1');
  });
});

describe('timestamp', () => {
  it('formats a date as YYYYMMDD_HHMMSS in local time', () => {
    // Built from local-time components so the assertion is timezone-independent.
    const d = new Date(2026, 5, 20, 9, 7, 3); // 2026-06-20 09:07:03 local
    expect(timestamp(d)).toBe('20260620_090703');
  });

  it('zero-pads every field', () => {
    const d = new Date(2026, 0, 1, 0, 0, 0); // 2026-01-01 00:00:00 local
    expect(timestamp(d)).toBe('20260101_000000');
  });
});
