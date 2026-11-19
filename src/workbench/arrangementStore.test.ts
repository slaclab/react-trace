// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ARRANGEMENT_BASE_KEY,
  DEFAULT_ARRANGEMENT,
  WRITE_DEBOUNCE_MS,
  arrangementKey,
  createArrangementStore,
  loadArrangement,
  readArrangement,
  type Arrangement,
} from './arrangementStore';

const SCOPE = 'data-canopy-storage-scope';

function stored(key = ARRANGEMENT_BASE_KEY): unknown {
  const raw = window.localStorage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}

function seed(value: unknown, key = ARRANGEMENT_BASE_KEY): void {
  window.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
}

const SAVED: Arrangement = {
  v: 1,
  collapsed: true,
  widthPx: 420,
};

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute(SCOPE);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.removeAttribute(SCOPE);
  window.localStorage.clear();
});

describe('arrangementKey', () => {
  it('is trace.workbench on an unscoped page', () => {
    expect(arrangementKey()).toBe('trace.workbench');
  });

  it('appends --<scope> when the page carries data-canopy-storage-scope', () => {
    document.documentElement.setAttribute(SCOPE, 'alice');
    expect(arrangementKey()).toBe('trace.workbench--alice');
  });

  it('treats an empty scope attribute as unscoped', () => {
    document.documentElement.setAttribute(SCOPE, '');
    expect(arrangementKey()).toBe('trace.workbench');
  });

  it('keeps scoped and unscoped arrangements apart, with no fallback to the bare key', () => {
    seed(SAVED);
    document.documentElement.setAttribute(SCOPE, 'bob');
    const scoped = createArrangementStore();
    expect(scoped.key).toBe('trace.workbench--bob');
    expect(scoped.initial).toEqual(DEFAULT_ARRANGEMENT);

    scoped.write({ widthPx: 260 });
    scoped.flush();
    expect(stored('trace.workbench--bob')).toMatchObject({ widthPx: 260 });
    expect(stored()).toEqual(SAVED);
  });
});

describe('readArrangement (pure reader)', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(readArrangement(window.localStorage, ARRANGEMENT_BASE_KEY)).toEqual(DEFAULT_ARRANGEMENT);
    expect(DEFAULT_ARRANGEMENT).toEqual({ v: 1, collapsed: false, widthPx: 300 });
  });

  it('returns a valid stored arrangement', () => {
    seed(SAVED);
    expect(readArrangement(window.localStorage, ARRANGEMENT_BASE_KEY)).toEqual(SAVED);
  });

  it.each([
    ['not JSON', '{oops'],
    ['an array', [1, 2]],
    ['a wrong version', { ...SAVED, v: 2 }],
    ['a non-boolean collapsed flag', { ...SAVED, collapsed: 'yes' }],
    ['a per-pane collapsed record', { ...SAVED, collapsed: { outline: true, properties: true } }],
    ['a non-finite width', { ...SAVED, widthPx: 'wide' }],
    ['a width below the minimum', { ...SAVED, widthPx: 100 }],
    ['a missing field', { v: 1, collapsed: false }],
  ])('treats %s as corrupt and returns the defaults without touching storage', (_, value) => {
    seed(value);
    const raw = window.localStorage.getItem(ARRANGEMENT_BASE_KEY);
    expect(readArrangement(window.localStorage, ARRANGEMENT_BASE_KEY)).toEqual(DEFAULT_ARRANGEMENT);
    expect(window.localStorage.getItem(ARRANGEMENT_BASE_KEY)).toBe(raw);
  });

  it('returns the defaults when there is no storage', () => {
    expect(readArrangement(null, ARRANGEMENT_BASE_KEY)).toEqual(DEFAULT_ARRANGEMENT);
  });
});

describe('loadArrangement / store mount', () => {
  it('removes a corrupt value and falls back to the defaults', () => {
    seed('{oops');
    expect(loadArrangement(window.localStorage, ARRANGEMENT_BASE_KEY)).toEqual(DEFAULT_ARRANGEMENT);
    expect(window.localStorage.getItem(ARRANGEMENT_BASE_KEY)).toBeNull();
  });

  it('reads the stored arrangement once at mount', () => {
    seed(SAVED);
    const store = createArrangementStore();
    expect(store.initial).toEqual(SAVED);
  });

  it('writes nothing without a gesture: mount, a selection-driven reveal, flush and pagehide leave storage untouched', () => {
    const store = createArrangementStore();
    const disconnect = store.connect();
    store.flush();
    window.dispatchEvent(new Event('pagehide'));
    vi.advanceTimersByTime(WRITE_DEBOUNCE_MS * 4);
    disconnect();
    expect(window.localStorage.getItem(ARRANGEMENT_BASE_KEY)).toBeNull();
  });

  it('never adopts a value written by another page after mount (no storage listener)', () => {
    const store = createArrangementStore();
    const disconnect = store.connect();
    seed(SAVED);
    window.dispatchEvent(new StorageEvent('storage', { key: ARRANGEMENT_BASE_KEY }));
    expect(store.initial).toEqual(DEFAULT_ARRANGEMENT);
    disconnect();
  });
});

describe('writes', () => {
  it('debounces writes by 150 ms and coalesces the changed fields', () => {
    const store = createArrangementStore();
    store.write({ collapsed: true });
    vi.advanceTimersByTime(WRITE_DEBOUNCE_MS - 1);
    expect(window.localStorage.getItem(ARRANGEMENT_BASE_KEY)).toBeNull();
    store.write({ widthPx: 250 });
    vi.advanceTimersByTime(WRITE_DEBOUNCE_MS - 1);
    expect(window.localStorage.getItem(ARRANGEMENT_BASE_KEY)).toBeNull();
    vi.advanceTimersByTime(1);
    expect(WRITE_DEBOUNCE_MS).toBe(150);
    expect(stored()).toEqual({ ...DEFAULT_ARRANGEMENT, collapsed: true, widthPx: 250 });
  });

  it('writes only the fields a gesture changed, merged over a fresh read', () => {
    const store = createArrangementStore();
    // Another page saved a full arrangement after this one mounted.
    seed(SAVED);
    store.write({ widthPx: 500 });
    vi.advanceTimersByTime(WRITE_DEBOUNCE_MS);
    expect(stored()).toEqual({ ...SAVED, widthPx: 500 });
  });

  it('two stores on one key never revert each other’s fields', () => {
    const a = createArrangementStore();
    const b = createArrangementStore();

    a.write({ collapsed: true });
    vi.advanceTimersByTime(WRITE_DEBOUNCE_MS);
    b.write({ widthPx: 360 });
    vi.advanceTimersByTime(WRITE_DEBOUNCE_MS);

    expect(stored()).toEqual({ ...DEFAULT_ARRANGEMENT, collapsed: true, widthPx: 360 });
    // Neither store adopted the other's values.
    expect(a.initial).toEqual(DEFAULT_ARRANGEMENT);
    expect(b.initial).toEqual(DEFAULT_ARRANGEMENT);
  });

  it('interleaved pending writes on two stores still keep both fields', () => {
    const a = createArrangementStore();
    const b = createArrangementStore();
    a.write({ collapsed: true });
    b.write({ widthPx: 280 });
    vi.advanceTimersByTime(WRITE_DEBOUNCE_MS);
    expect(stored()).toEqual({ ...DEFAULT_ARRANGEMENT, collapsed: true, widthPx: 280 });
  });

  it('a new store reads the latest values', () => {
    const a = createArrangementStore();
    a.write({ collapsed: true, widthPx: 410 });
    vi.advanceTimersByTime(WRITE_DEBOUNCE_MS);
    const b = createArrangementStore();
    expect(b.initial).toEqual({ ...DEFAULT_ARRANGEMENT, collapsed: true, widthPx: 410 });
  });

  it('merges over the defaults when the stored value is corrupt', () => {
    const store = createArrangementStore();
    seed('{oops');
    store.write({ collapsed: true });
    store.flush();
    expect(stored()).toEqual({ ...DEFAULT_ARRANGEMENT, collapsed: true });
  });

  it('flushes a pending write on pagehide', () => {
    const store = createArrangementStore();
    const disconnect = store.connect();
    store.write({ collapsed: true });
    window.dispatchEvent(new Event('pagehide'));
    expect(stored()).toMatchObject({ collapsed: true });
    disconnect();
  });

  it('flushes a pending write when disconnected, and stops listening for pagehide', () => {
    const store = createArrangementStore();
    const disconnect = store.connect();
    store.write({ widthPx: 260 });
    disconnect();
    expect(stored()).toMatchObject({ widthPx: 260 });
    window.localStorage.clear();
    store.write({ widthPx: 240 });
    window.dispatchEvent(new Event('pagehide'));
    expect(window.localStorage.getItem(ARRANGEMENT_BASE_KEY)).toBeNull();
  });

  it('ignores invalid patch fields and never stores a corrupt value', () => {
    const store = createArrangementStore();
    store.write({ widthPx: Number.NaN, collapsed: true });
    store.flush();
    expect(stored()).toEqual({ ...DEFAULT_ARRANGEMENT, collapsed: true });
  });

  it('survives a storage that throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    const store = createArrangementStore({ storage: throwing });
    expect(store.initial).toEqual(DEFAULT_ARRANGEMENT);
    store.write({ collapsed: true });
    expect(() => store.flush()).not.toThrow();
  });
});
