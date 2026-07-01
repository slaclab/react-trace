import { describe, it, expect } from 'vitest';
import { PALETTES, DEFAULT_PALETTE_ID, getPalette, colorForIndex, type Palette } from './palettes';

describe('getPalette', () => {
  it('returns the palette matching the id', () => {
    expect(getPalette('viridis').id).toBe('viridis');
  });

  it('falls back to the default palette for an unknown id', () => {
    expect(getPalette('does-not-exist').id).toBe(DEFAULT_PALETTE_ID);
  });

  it('always has a palette registered for the default id', () => {
    expect(PALETTES.some((p) => p.id === DEFAULT_PALETTE_ID)).toBe(true);
  });
});

describe('colorForIndex', () => {
  const palette: Palette = { id: 'test', label: 'Test', colors: ['#aaa', '#bbb', '#ccc'] };

  it('returns colors in order within range', () => {
    expect(colorForIndex(palette, 0)).toBe('#aaa');
    expect(colorForIndex(palette, 1)).toBe('#bbb');
    expect(colorForIndex(palette, 2)).toBe('#ccc');
  });

  it('cycles past the end of the palette', () => {
    expect(colorForIndex(palette, 3)).toBe('#aaa');
    expect(colorForIndex(palette, 4)).toBe('#bbb');
    expect(colorForIndex(palette, 7)).toBe('#bbb');
  });

  it('handles negative indices without throwing', () => {
    expect(colorForIndex(palette, -1)).toBe('#ccc');
  });

  it('returns a fallback color for an empty palette', () => {
    expect(colorForIndex({ id: 'empty', label: 'Empty', colors: [] }, 0)).toBe('#000000');
  });
});
