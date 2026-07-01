import { useSyncExternalStore } from 'react';
import { DEFAULT_PALETTE_ID, getPalette } from '../palettes';

// Global default palette id — the palette new curves are colored from
// cyclically. Persisted to localStorage so the choice survives reloads, in the
// same lightweight external-store style as themeStore.ts.

const STORAGE_KEY = 'trace.palette';

function readInitial(): string {
  if (typeof window === 'undefined') return DEFAULT_PALETTE_ID;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  // Validate against the known palettes; getPalette falls back to the default
  // for anything unrecognized, so reuse it to normalize.
  return stored ? getPalette(stored).id : DEFAULT_PALETTE_ID;
}

let current: string = readInitial();
const listeners = new Set<() => void>();

function publish() {
  for (const l of listeners) l();
}

export function getDefaultPaletteId(): string {
  return current;
}

export function setDefaultPaletteId(id: string): void {
  const next = getPalette(id).id;
  if (next === current) return;
  current = next;
  if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, next);
  publish();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePaletteId(): { paletteId: string; setPaletteId: (id: string) => void } {
  const paletteId = useSyncExternalStore(subscribe, getDefaultPaletteId, getDefaultPaletteId);
  return { paletteId, setPaletteId: setDefaultPaletteId };
}
