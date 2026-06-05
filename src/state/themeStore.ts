import { useEffect, useSyncExternalStore } from 'react';

export type ColorMode = 'light' | 'dark';
const STORAGE_KEY = 'trace.theme';
const DEFAULT_MODE: ColorMode = 'dark';

function readInitial(): ColorMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : DEFAULT_MODE;
}

let current: ColorMode = readInitial();
const listeners = new Set<() => void>();

function publish() {
  for (const l of listeners) l();
}

export function getColorMode(): ColorMode {
  return current;
}

export function setColorMode(mode: ColorMode): void {
  if (mode === current) return;
  current = mode;
  if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, mode);
  publish();
}

export function toggleColorMode(): void {
  setColorMode(current === 'dark' ? 'light' : 'dark');
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useColorMode(): { colorMode: ColorMode; toggle: () => void } {
  const colorMode = useSyncExternalStore(subscribe, getColorMode, getColorMode);
  // Mirror the mode onto a data attribute so plain CSS can react via the
  // [data-theme="..."] selector when we later refactor the panel CSS to
  // variables. Carbon's <Theme> handles its own components separately.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = colorMode;
    }
  }, [colorMode]);
  return { colorMode, toggle: toggleColorMode };
}
