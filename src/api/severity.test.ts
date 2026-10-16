import { describe, expect, it } from 'vitest';
import { AlarmSeverity } from '@slaclab/canopy-client';
import { toWireSeverity } from './severity';

describe('toWireSeverity', () => {
  it('maps each alarm level to its wire name', () => {
    expect(toWireSeverity(AlarmSeverity.NO_ALARM)).toBe('NO_ALARM');
    expect(toWireSeverity(AlarmSeverity.MINOR)).toBe('MINOR');
    expect(toWireSeverity(AlarmSeverity.MAJOR)).toBe('MAJOR');
    expect(toWireSeverity(AlarmSeverity.INVALID)).toBe('INVALID');
  });

  it('treats DISCONNECTED as no alarm severity', () => {
    expect(toWireSeverity(AlarmSeverity.DISCONNECTED)).toBeNull();
  });
});
