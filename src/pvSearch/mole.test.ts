import { describe, expect, it } from 'vitest';
import { moleSearchPattern } from './mole';

describe('moleSearchPattern', () => {
  it('wraps a plain fragment and keeps a user pattern', () => {
    expect(moleSearchPattern(' SIM ')).toBe('.*SIM.*');
    expect(moleSearchPattern('SIM:BPM.*')).toBe('SIM:BPM.*');
    expect(moleSearchPattern('SIM*')).toBe('SIM*');
  });
});
