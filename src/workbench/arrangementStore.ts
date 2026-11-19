// The sidebar arrangement store: whether the sidebar is collapsed to its rail,
// and its width.
//
// Key: `trace.workbench`, plus `--<scope>` when the page's <html> carries
// `data-canopy-storage-scope` (an absent or empty attribute means the bare
// key, and a scoped page never falls back to the bare key). One key serves
// all three tools.
//
// The arrangement is read once at mount (`initial`). Only a deliberate
// arrangement gesture calls `write`, with just the fields that gesture
// changed; the write is debounced 150 ms and merged over a fresh read of the
// key, so two pages (or two dock tiles) never revert each other's fields. The
// store never adopts a value after mount: there is no `storage` listener, and
// `initial` never changes. A selection-driven reveal, a tile resize or a
// clamped re-expand simply never calls `write`, so they write nothing.
// Pending writes are flushed on `pagehide` (while connected) and on
// disconnect.
//
// A stored value is validated on read; a corrupt one yields the defaults and
// is removed at mount. `readArrangement` is the pure reader (no side effects).

export interface Arrangement {
  v: 1;
  /** The sidebar is collapsed to its rail. */
  collapsed: boolean;
  /** Sidebar width in CSS px (the 60 % maximum is applied by the layout, not stored). */
  widthPx: number;
}

/** The fields a gesture may write. */
export type ArrangementPatch = Partial<Omit<Arrangement, 'v'>>;

export const ARRANGEMENT_BASE_KEY = 'trace.workbench';
export const STORAGE_SCOPE_ATTRIBUTE = 'data-canopy-storage-scope';
export const WRITE_DEBOUNCE_MS = 150;
export const MIN_WIDTH_PX = 220;
export const DEFAULT_WIDTH_PX = 300;

export const DEFAULT_ARRANGEMENT: Arrangement = Object.freeze({
  v: 1,
  collapsed: false,
  widthPx: DEFAULT_WIDTH_PX,
});

/** The storage key for this document. */
export function arrangementKey(doc: Document | undefined = globalThis.document): string {
  let scope: string | null;
  try {
    scope = doc?.documentElement.getAttribute(STORAGE_SCOPE_ATTRIBUTE) || null;
  } catch {
    scope = null;
  }
  return scope === null ? ARRANGEMENT_BASE_KEY : `${ARRANGEMENT_BASE_KEY}--${scope}`;
}

// --- validation -------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isCollapsed = (v: unknown): v is boolean => typeof v === 'boolean';
const isWidth = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= MIN_WIDTH_PX;

/** Validates a parsed value; returns a fresh Arrangement or null when corrupt. */
function validate(v: unknown): Arrangement | null {
  if (!isRecord(v) || v.v !== 1) return null;
  const { collapsed, widthPx } = v;
  if (!isCollapsed(collapsed) || !isWidth(widthPx)) return null;
  return { v: 1, collapsed, widthPx };
}

/** Keeps only the valid fields of a patch. */
function sanitize(patch: ArrangementPatch): ArrangementPatch {
  const out: ArrangementPatch = {};
  if (isCollapsed(patch.collapsed)) out.collapsed = patch.collapsed;
  if (isWidth(patch.widthPx)) out.widthPx = patch.widthPx;
  return out;
}

type Read = { value: Arrangement; corrupt: boolean };

function readRaw(storage: Storage | null, key: string): Read {
  let raw: string | null;
  try {
    raw = storage?.getItem(key) ?? null;
  } catch {
    return { value: DEFAULT_ARRANGEMENT, corrupt: false };
  }
  if (raw === null) return { value: DEFAULT_ARRANGEMENT, corrupt: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { value: DEFAULT_ARRANGEMENT, corrupt: true };
  }
  const value = validate(parsed);
  return value === null ? { value: DEFAULT_ARRANGEMENT, corrupt: true } : { value, corrupt: false };
}

/** Pure reader: the stored arrangement, or the defaults when absent or corrupt. */
export function readArrangement(storage: Storage | null, key: string): Arrangement {
  return readRaw(storage, key).value;
}

/** Mount-time reader: like `readArrangement`, but removes a corrupt value. */
export function loadArrangement(storage: Storage | null, key: string): Arrangement {
  const { value, corrupt } = readRaw(storage, key);
  if (corrupt) {
    try {
      storage?.removeItem(key);
    } catch {
      // Storage unavailable: nothing to clean.
    }
  }
  return value;
}

// --- the store ----------------------------------------------------------------

export interface ArrangementStore {
  readonly key: string;
  /** The arrangement read once at mount; never updated afterwards. */
  readonly initial: Arrangement;
  /** Record a deliberate gesture's changed fields; written after the debounce. */
  write(patch: ArrangementPatch): void;
  /** Write any pending fields now, merged over a fresh read. */
  flush(): void;
  /** Flush on `pagehide` until the returned function is called (which flushes too). */
  connect(): () => void;
}

export interface ArrangementStoreOptions {
  storage?: Storage | null;
  key?: string;
  debounceMs?: number;
  /** The window whose `pagehide` flushes; defaults to the global window. */
  win?: Window;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function createArrangementStore(options: ArrangementStoreOptions = {}): ArrangementStore {
  const storage = options.storage !== undefined ? options.storage : defaultStorage();
  const key = options.key ?? arrangementKey();
  const debounceMs = options.debounceMs ?? WRITE_DEBOUNCE_MS;
  const win = options.win ?? (typeof window === 'undefined' ? undefined : window);
  const initial = loadArrangement(storage, key);

  let pending: ArrangementPatch | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending === null) return;
    const patch = pending;
    pending = null;
    const merged: Arrangement = { ...readArrangement(storage, key), ...patch, v: 1 };
    try {
      storage?.setItem(key, JSON.stringify(merged));
    } catch {
      // Quota or security error: the arrangement simply is not persisted.
    }
  }

  function write(patch: ArrangementPatch): void {
    const clean = sanitize(patch);
    if (Object.keys(clean).length === 0) return;
    pending = { ...(pending ?? {}), ...clean };
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  function connect(): () => void {
    if (win === undefined) return flush;
    const onPageHide = () => flush();
    win.addEventListener('pagehide', onPageHide);
    return () => {
      win.removeEventListener('pagehide', onPageHide);
      flush();
    };
  }

  return { key, initial, write, flush, connect };
}
