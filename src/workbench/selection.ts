// The workbench selection.
//
// One selection per tool: the tool level (`null`, nothing selected), a section,
// or an item. A selected item is the open card of the properties panel (a click
// on its head opens it, a second click closes it); a selected section opens
// its place in the panel (an Axes sub-block); the canvas reads and writes the
// same value, and the Sidebar consumes its reveal requests.
//
// Origins: only a *user* selection raises the "reveal" request (expand
// a collapsed panel). An *initial* selection on load opens its card silently,
// and a *reset* (a tool re-rooting, e.g. Trace when the active plot changes)
// or a reconcile against a changed outline never reveals either. Nothing
// here writes the arrangement store.
//
// When the tool's outline view-model loses the selected item the selection
// falls back to the section that held it; when it loses the section, to the
// tool level.

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type { OutlineViewModel, Selection, Target } from './types';

/** Who set the current selection. Only `user` reveals Properties. */
export type SelectionOrigin = 'initial' | 'user' | 'reset' | 'reconcile';

/** What a selection consumer reads; replaced (never mutated) on every change. */
export interface SelectionSnapshot {
  selection: Selection;
  origin: SelectionOrigin;
  /**
   * Counts user selections. The Sidebar keys its reveal effect on it (or uses
   * `useRevealRequest`); it never changes for initial, reset or reconcile.
   */
  revealCount: number;
}

export interface SelectionStore {
  get(): SelectionSnapshot;
  subscribe(listener: () => void): () => void;
  /** Select a section or item (or the tool level with `null`); `origin` defaults to `user`. */
  select(selection: Selection, origin?: 'user' | 'initial'): void;
  /** Back to the tool level, without a reveal. */
  reset(): void;
  /**
   * Re-check the selection against the tool's current outline: a removed item
   * falls back to its section, a removed section to the tool level. Never
   * reveals. Call it whenever the outline view-model changes.
   */
  reconcile(outline: OutlineViewModel): void;
  /** Called once per user selection, after the snapshot changed. */
  onReveal(listener: (selection: Selection) => void): () => void;
}

export interface SelectionStoreOptions {
  /** The selection on load (fills Properties, never reveals). */
  initial?: Selection;
}

// ---------------------------------------------------------------- helpers --

function sameTarget(a: Selection, b: Selection): boolean {
  if (a === null || b === null) return a === b;
  return a.level === b.level && a.kind === b.kind && a.id === b.id;
}

/** The section that holds item `itemId` in `outline`, if any. */
export function sectionOfItem(
  outline: OutlineViewModel,
  itemId: string
): OutlineViewModel['sections'][number] | undefined {
  return outline.sections.find((s) => s.rows.some((r) => r.id === itemId));
}

function sectionTarget(section: { id: string; kind: string }): Target {
  return { level: 'section', kind: section.kind, id: section.id };
}

/**
 * `selection` resolved against `outline`. `lastSectionId` is the section that
 * held the item when last seen, the fallback once the item is gone.
 */
export function resolveSelection(
  outline: OutlineViewModel,
  selection: Selection,
  lastSectionId?: string | null
): Selection {
  if (selection === null || selection.level === 'tool') return selection;
  if (selection.level === 'section') {
    return outline.sections.some((s) => s.id === selection.id) ? selection : null;
  }
  if (sectionOfItem(outline, selection.id)) return selection;
  const fallback = lastSectionId ? outline.sections.find((s) => s.id === lastSectionId) : undefined;
  return fallback ? sectionTarget(fallback) : null;
}

// ------------------------------------------------------------------ store --

export function createSelectionStore(options: SelectionStoreOptions = {}): SelectionStore {
  let snapshot: SelectionSnapshot = {
    selection: options.initial ?? null,
    origin: 'initial',
    revealCount: 0,
  };
  // The section that held the selected item in the last outline seen.
  let itemSection: string | null = null;
  let outline: OutlineViewModel | null = null;
  const listeners = new Set<() => void>();
  const revealListeners = new Set<(selection: Selection) => void>();

  function rememberSection(selection: Selection): void {
    if (selection?.level !== 'item') {
      itemSection = null;
      return;
    }
    const held = outline ? sectionOfItem(outline, selection.id) : undefined;
    itemSection = held?.id ?? null;
  }

  function set(next: SelectionSnapshot): void {
    snapshot = next;
    for (const l of [...listeners]) l();
  }

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select(selection, origin = 'user') {
      const normalized = selection?.level === 'tool' ? null : selection;
      rememberSection(normalized);
      const revealCount = snapshot.revealCount + (origin === 'user' ? 1 : 0);
      set({ selection: normalized, origin, revealCount });
      if (origin === 'user') for (const l of [...revealListeners]) l(normalized);
    },
    reset() {
      itemSection = null;
      if (snapshot.selection === null && snapshot.origin === 'reset') return;
      set({ selection: null, origin: 'reset', revealCount: snapshot.revealCount });
    },
    reconcile(next) {
      outline = next;
      const current = snapshot.selection;
      const resolved = resolveSelection(next, current, itemSection);
      if (sameTarget(resolved, current)) {
        // Still present: follow the item if it moved to another section.
        if (current?.level === 'item') itemSection = sectionOfItem(next, current.id)?.id ?? null;
        return;
      }
      itemSection = null;
      set({ selection: resolved, origin: 'reconcile', revealCount: snapshot.revealCount });
    },
    onReveal(listener) {
      revealListeners.add(listener);
      return () => revealListeners.delete(listener);
    },
  };
}

// ------------------------------------------------------------------ react --

const SelectionContext = createContext<SelectionStore | null>(null);

/** Provides one tool's selection to the panel, the Sidebar and the canvas. */
export function SelectionProvider({
  store,
  children,
}: {
  store: SelectionStore;
  children?: ReactNode;
}): ReactNode {
  return createElement(SelectionContext.Provider, { value: store }, children);
}

/** The provided store; throws outside a `SelectionProvider`. */
export function useSelectionStore(): SelectionStore {
  const store = useContext(SelectionContext);
  if (!store) throw new Error('useWorkbenchSelection must be used inside a SelectionProvider');
  return store;
}

export interface WorkbenchSelection extends SelectionSnapshot {
  /** A user selection (a card head, the canvas): reveals the panel. */
  select(selection: Selection): void;
  reset(): void;
  store: SelectionStore;
}

/** The current selection and its writers; the canvas reads the same value. */
export function useWorkbenchSelection(): WorkbenchSelection {
  const store = useSelectionStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);
  return {
    ...snapshot,
    select: (selection) => store.select(selection, 'user'),
    reset: () => store.reset(),
    store,
  };
}

/** Runs `handler` on every user selection (the Sidebar's reveal of the panel). */
export function useRevealRequest(handler: (selection: Selection) => void): void {
  const store = useSelectionStore();
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => store.onReveal((s) => latest.current(s)), [store]);
}

/**
 * Resets `store` (when there is one) whenever `key` changes after mount
 * (Trace: the active plot id). The first render never resets.
 */
export function useResetOnChange(key: unknown, store: SelectionStore | undefined): void {
  const previous = useRef(key);
  useEffect(() => {
    if (Object.is(previous.current, key)) return;
    previous.current = key;
    store?.reset();
  }, [key, store]);
}
