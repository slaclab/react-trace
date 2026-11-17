import { describe, expect, it } from 'vitest';
import { normalizeBasePath } from './basePath';

describe('normalizeBasePath', () => {
  it('defaults to same-origin per-module paths', () => {
    expect(normalizeBasePath(undefined)).toBe('');
    expect(normalizeBasePath('')).toBe('');
    expect(normalizeBasePath('   ')).toBe('');
    expect(normalizeBasePath('/')).toBe('');
  });

  it('keeps a deployed prefix and drops trailing slashes and padding', () => {
    expect(normalizeBasePath('/trace/api/canopy')).toBe('/trace/api/canopy');
    expect(normalizeBasePath('/trace/api/canopy/')).toBe('/trace/api/canopy');
    expect(normalizeBasePath(' /trace/api/canopy// ')).toBe('/trace/api/canopy');
  });
});
