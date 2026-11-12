import { describe, expect, it } from 'vitest';
import { chartThemeFor } from '@slaclab/canopy-charts';
import {
  ANNOTATION_THEMES,
  defaultAnnotationColor,
  drawingThemeFor,
  isColorLiteral,
} from './annotationTheme';

const HEX = /^#[0-9a-f]{6}$/i;

describe('isColorLiteral', () => {
  it.each([
    '#abc',
    '#0f62fe',
    '#0f62fe80',
    'rgb(1,2,3)',
    'rgba(15, 98, 254, 0.5)',
    'rgb(1%, 2%, 3%)',
  ])('accepts %s', (color) => {
    expect(isColorLiteral(color)).toBe(true);
  });

  it.each([
    'red;background:url(x)',
    'expression(alert(1))',
    'url(https://example.test/beacon)',
    'red',
    '#abc;color:red',
    'rgb(1,2,3);background:url(x)',
    'rgb(1,2,3)"',
    '',
    7,
    null,
    undefined,
  ])('refuses %s', (color) => {
    expect(isColorLiteral(color)).toBe(false);
  });
});

describe('drawingThemeFor', () => {
  it("layers each mode's drawing colours on that mode's chart theme", () => {
    for (const mode of ['dark', 'light'] as const) {
      const theme = drawingThemeFor(mode);
      expect(theme.bg).toBe(chartThemeFor(mode).bg);
      expect(theme.tooltipText).toBe(chartThemeFor(mode).tooltipText);
      expect(theme.annotation).toBe(ANNOTATION_THEMES[mode]);
    }
  });
});

describe('drawing colours', () => {
  it('exposes the same five-colour palette in both themes', () => {
    expect(drawingThemeFor('dark').annotation.palette).toHaveLength(5);
    expect(drawingThemeFor('light').annotation.palette).toEqual(
      drawingThemeFor('dark').annotation.palette
    );
  });

  it('has five distinct hex palette entries', () => {
    const palette = drawingThemeFor('dark').annotation.palette;
    for (const c of palette) expect(c).toMatch(HEX);
    expect(new Set(palette.map((c) => c.toLowerCase())).size).toBe(5);
  });

  it('gives each theme hex measure, selection and handle colours', () => {
    for (const theme of [drawingThemeFor('dark'), drawingThemeFor('light')]) {
      expect(theme.annotation.measure).toMatch(HEX);
      expect(theme.annotation.selection).toMatch(HEX);
      expect(theme.annotation.handle).toMatch(HEX);
    }
  });

  it('defaultAnnotationColor cycles through the palette', () => {
    const palette = drawingThemeFor('dark').annotation.palette;
    for (let i = 0; i < 5; i++) expect(defaultAnnotationColor(i)).toBe(palette[i]);
    expect(defaultAnnotationColor(5)).toBe(palette[0]);
    expect(defaultAnnotationColor(12)).toBe(palette[2]);
  });

  it('defaultAnnotationColor never returns undefined for odd indices', () => {
    expect(defaultAnnotationColor(-1)).toBe(drawingThemeFor('dark').annotation.palette[4]);
    expect(defaultAnnotationColor(1.7)).toBe(drawingThemeFor('dark').annotation.palette[1]);
    expect(defaultAnnotationColor(Number.NaN)).toBe(drawingThemeFor('dark').annotation.palette[0]);
  });
});
