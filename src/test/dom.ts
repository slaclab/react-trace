// Test helpers for jsdom tests that render Carbon / canopy-shell components.
// Tests import these directly; src/test/setup.ts (vite.config.ts setupFiles)
// doesn't install them.

/**
 * jsdom implements neither window.matchMedia nor ResizeObserver; Carbon's
 * Theme/Header/Tooltip query the first and its Modal observes with the second
 * (same stubs as canopy-shell's own vitest.setup.ts). Call at module level,
 * before rendering.
 */
export function stubCarbonDom(): void {
  if (typeof window.matchMedia === 'undefined') {
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
}

/**
 * In-memory Storage, for `vi.stubGlobal('localStorage', memoryStorage())`.
 * Keeps tests independent of whether this Node version exposes jsdom's
 * storage (Node 26 shadows it unless --localstorage-file is given).
 */
export function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}
