import { isPaletteId } from '../palettes';

// The user's palette, as on main: the palette last picked in a plot's Palette
// field, kept under this localStorage key. Palettes are per plot, and this is
// the one a fresh tab (no `plot=`) and every added plot open in. Only an
// explicit pick writes it: a file's palette, a link's or a reset of a plot's
// Palette dot leave the user's choice as it was.

export const LEGACY_PALETTE_KEY = 'trace.palette';

/** The palette id the per-user key names, when it is a known palette. */
export function readLegacyPaletteId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(LEGACY_PALETTE_KEY);
  } catch {
    return undefined;
  }
  return isPaletteId(stored) ? stored : undefined;
}

/** Remember `id` as the user's palette; an unknown id, or no storage, is ignored. */
export function rememberPaletteId(id: string): void {
  if (typeof window === 'undefined' || !isPaletteId(id)) return;
  try {
    window.localStorage.setItem(LEGACY_PALETTE_KEY, id);
  } catch {
    // Storage blocked (private window, quota): the pick still applies to the plot.
  }
}
