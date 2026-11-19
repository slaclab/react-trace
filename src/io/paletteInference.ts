// The palette a saved `.trc.json` plot opens with when it states none:
// the one its curve colours imply. Files written before palettes were per
// plot carry curve colours from whatever palette the user had picked; the
// first of DEFAULT, then the rest in `PALETTES` order, that contains every
// curve colour is taken to be it. Pure: no store, no side effects.

import {
  DEFAULT_PALETTE_ID,
  PALETTES,
  isPaletteId,
  paletteSlot,
  storedPaletteId,
} from '../palettes';
import type { Plot } from '../types';

/**
 * The id of the first palette (DEFAULT first, then `PALETTES` order) that
 * contains every colour in `colours` (case-insensitive); undefined when none
 * does. No colours imply the default.
 */
export function inferPaletteId(colours: readonly string[]): string | undefined {
  const ordered = [
    ...PALETTES.filter((p) => p.id === DEFAULT_PALETTE_ID),
    ...PALETTES.filter((p) => p.id !== DEFAULT_PALETTE_ID),
  ];
  return ordered.find((p) => colours.every((c) => paletteSlot(c, p) >= 0))?.id;
}

/**
 * `plot` as a `.trc.json` file opens it: the palette the file states when it
 * names a known palette, else the one its curve colours imply, else the
 * default. The stored id is normalised (the default is stored as absent).
 */
export function withFilePalette(plot: Plot): Plot {
  const stated = isPaletteId(plot.palette) ? plot.palette : undefined;
  const colours = plot.traces.flatMap((t) => (t.color === undefined ? [] : [t.color]));
  const palette = storedPaletteId(stated ?? inferPaletteId(colours));
  if (palette === plot.palette) return plot;
  const out: Plot = { ...plot };
  if (palette === undefined) delete out.palette;
  else out.palette = palette;
  return out;
}
