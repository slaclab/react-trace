import { describe, expect, it } from 'vitest';
import { canopyBaseUrl } from './connection';

describe('canopyBaseUrl', () => {
  it('defaults to same-origin per-module paths', () => {
    expect(canopyBaseUrl(undefined)).toBe('');
    expect(canopyBaseUrl('')).toBe('');
    expect(canopyBaseUrl('   ')).toBe('');
  });

  it('keeps a deployed prefix and drops trailing slashes and padding', () => {
    expect(canopyBaseUrl('/trace/api/canopy')).toBe('/trace/api/canopy');
    expect(canopyBaseUrl('/trace/api/canopy/')).toBe('/trace/api/canopy');
    expect(canopyBaseUrl(' /trace/api/canopy// ')).toBe('/trace/api/canopy');
  });
});
