import { describe, expect, it } from 'vitest';
import { CHART_THEMES } from '@slaclab/canopy-charts';
import { effectiveBackground } from './plotBackground';

describe('effectiveBackground', () => {
  it.each(['#161616', '#f4f4f4', '#ffffff'])('treats %s as the theme default', (bg) => {
    expect(effectiveBackground(bg, CHART_THEMES.dark)).toBe('#161616');
    expect(effectiveBackground(bg, CHART_THEMES.light)).toBe('#f4f4f4');
  });

  it('keeps a user-chosen background in both modes', () => {
    expect(effectiveBackground('#123456', CHART_THEMES.dark)).toBe('#123456');
    expect(effectiveBackground('#123456', CHART_THEMES.light)).toBe('#123456');
  });
});
