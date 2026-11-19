import { describe, expect, it } from 'vitest';
import { ANNOTATION_INK, drawingThemeFor, annotationPaint } from '../annotationTheme';
import { readoutPlacement, CARD_GAP, CARD_LINE } from './catalog/shapeKit';
import { term, terms, withMinus } from './catalog/format';
import { withStyle, type Annotation } from './model';
import { swatchRow } from './style';

const A: Annotation = {
  id: 'a',
  kind: 'box',
  points: [
    { t: 0, v: 0 },
    { t: 1, v: 1 },
  ],
  axisId: 'y',
  color: ANNOTATION_INK,
  width: 0.75,
  text: '',
};

describe('ink', () => {
  it('is dark on the light theme and light on the dark one', () => {
    expect(annotationPaint(ANNOTATION_INK, drawingThemeFor('light').annotation)).toBe(
      drawingThemeFor('light').annotation.ink
    );
    expect(annotationPaint(ANNOTATION_INK, drawingThemeFor('dark').annotation)).toBe(
      drawingThemeFor('dark').annotation.ink
    );
    expect(drawingThemeFor('light').annotation.ink).not.toBe(
      drawingThemeFor('dark').annotation.ink
    );
    expect(annotationPaint('#123456', drawingThemeFor('light').annotation)).toBe('#123456');
  });

  it('labels set in a small serif italic in both themes', () => {
    for (const theme of [drawingThemeFor('light'), drawingThemeFor('dark')]) {
      expect(theme.annotation.label.fontFamily).toMatch(/^"STIX Two Text".*serif$/);
      expect(theme.annotation.label.fontSize).toBe(11);
      expect(theme.annotation.label.fontStyle).toBe('italic');
    }
  });
});

describe('style choices', () => {
  it('write the drawing’s own colour, width and dash', () => {
    expect(withStyle(A, { color: '#ff0000' }).color).toBe('#ff0000');
    expect(withStyle(A, { width: 2 }).width).toBe(2);
    const dashed = withStyle(A, { dash: true });
    expect(dashed.dash).toBe(true);
    expect('dash' in withStyle(dashed, { dash: false })).toBe(false);
  });

  it('keep the same drawing when nothing changes', () => {
    expect(withStyle(A, { color: ANNOTATION_INK, width: 0.75, dash: false })).toBe(A);
  });

  it('offer ink first, then the curves, then the accents, each colour once', () => {
    const palette = drawingThemeFor('light').annotation.palette;
    const row = swatchRow(drawingThemeFor('light'), [
      { color: '#00aa00', name: 'TEST:CURRENT_A' },
      { color: palette[0].toUpperCase(), name: 'TEST:CURRENT_B' },
    ]);
    expect(row[0]).toEqual({
      color: ANNOTATION_INK,
      paint: drawingThemeFor('light').annotation.ink,
      name: 'Ink',
    });
    expect(row.slice(1, 3).map((s) => s.name)).toEqual(['TEST:CURRENT_A', 'TEST:CURRENT_B']);
    expect(row.map((s) => s.color.toLowerCase())).toHaveLength(
      new Set(row.map((s) => s.color.toLowerCase())).size
    );
    expect(row).toHaveLength(1 + 2 + palette.length - 1);
  });
});

describe('readout text', () => {
  it('prints terms as a figure does, with a true minus and a dash for no value', () => {
    expect(withMinus('-186.5')).toBe('−186.5');
    expect(term('Δy', -186.54)).toBe('Δy = −186.5');
    expect(term('σ', 25.0213, 'A')).toBe('σ = 25.02 A');
    expect(term('x̄', null)).toBe('x̄ = —');
    expect(terms('a', 'b')).toBe('a b');
  });
});

describe('readoutPlacement', () => {
  const grid = { left: 0, top: 0, width: 600, height: 300 };
  const handles: [number, number][] = [
    [100, 150],
    [140, 200],
  ];
  const lines = ['Δx = 26.57', 'n = 27'];

  it('sits above and right of the box, with a leader line to it', () => {
    const p = readoutPlacement(lines, handles, grid);
    expect(p.x).toBe(140 + CARD_GAP);
    expect(p.y).toBe(150 - CARD_GAP - 2 * CARD_LINE);
    expect(p.leader).not.toBeNull();
    expect(p.leader?.slice(0, 2)).toEqual([140, 150]);
  });

  it('goes left of the box at the grid’s right edge', () => {
    const p = readoutPlacement(
      lines,
      [
        [560, 150],
        [590, 200],
      ],
      grid
    );
    expect(p.x + p.w).toBeLessThanOrEqual(560);
  });

  it('follows a drag offset and stays inside the grid', () => {
    const p = readoutPlacement(lines, handles, grid, [50, 20]);
    expect(p.x).toBe(140 + CARD_GAP + 50);
    const far = readoutPlacement(lines, handles, grid, [5000, 5000]);
    expect(far.x + far.w).toBeLessThanOrEqual(600);
    expect(far.y + far.h).toBeLessThanOrEqual(300);
  });
});
