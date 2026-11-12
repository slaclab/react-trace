import { isPaletteId } from '../palettes';

// The legacy per-user palette. Before palettes became per plot, Trace
// stored the user's palette pick under this localStorage key. It is now only
// read, as one branch of the opening rule: a fresh tab (no `plot=`) opens in
// the palette it names when that is a known palette. Trace never writes it.

export const LEGACY_PALETTE_KEY = 'trace.palette';

/** The palette id the legacy per-user key names, when it is a known palette. */
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
