// The style panel's choices, as data: the colour swatch row. Kept apart from
// `StylePanel.tsx` so that module exports only its component.
//
// No colour literals here (src/annotations is literal-guarded).
import { ANNOTATION_INK } from '../annotationTheme';
import type { DrawingTheme, StyleSwatch } from './catalog/types';

/** A swatch row: ink, then the curves', then the accents, each colour once. */
export function swatchRow(
  theme: DrawingTheme,
  curves: readonly StyleSwatch[]
): { color: string; paint: string; name: string }[] {
  const out = [{ color: ANNOTATION_INK, paint: theme.annotation.ink, name: 'Ink' }];
  const seen = new Set([theme.annotation.ink.toLowerCase()]);
  const add = (color: string, name: string) => {
    const key = color.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ color, paint: color, name });
  };
  for (const c of curves) add(c.color, c.name);
  theme.annotation.palette.forEach((c, i) => add(c, `Accent ${i + 1}`));
  return out;
}
