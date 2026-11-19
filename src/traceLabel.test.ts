import { describe, it, expect } from 'vitest';
import { traceLabel } from './traceLabel';

function trace(overrides: Partial<Parameters<typeof traceLabel>[0]> = {}) {
  return { id: 't1', displayName: '', pvName: '', timeOffset: undefined, ...overrides };
}

describe('traceLabel with timeOffset', () => {
  it('appends the formatted offset to the name', () => {
    expect(traceLabel(trace({ pvName: 'PV:TEST', timeOffset: '-1d' }))).toBe('PV:TEST (−1 d)');
    expect(traceLabel(trace({ displayName: 'Sine', timeOffset: '-7d' }))).toBe('Sine (−1 w)');
  });

  it('ignores invalid or missing offsets', () => {
    expect(traceLabel(trace({ pvName: 'PV:TEST', timeOffset: 'bad' }))).toBe('PV:TEST');
    expect(traceLabel(trace({ pvName: 'PV:TEST' }))).toBe('PV:TEST');
  });
});
