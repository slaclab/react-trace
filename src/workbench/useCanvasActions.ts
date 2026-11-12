// Canvas actions.
//
// A tool's actions are registered at runtime from inside its canvas, so they
// close over canvas-local state (Pause, Export-once-a-frame-exists). The
// workbench owns one registry per tool, hands it to the canvas slot through
// `CanvasActionsProvider`, renders it in `ActionsBar`, and binds every
// shortcut from that one list — there is no second shortcut table.
//
// Hidden versus disabled: an action whose service the deployment cannot
// provide is hidden — the tool leaves it out of the list it registers, decided
// from its capability record; an action that is temporarily unusable is
// registered with `disabled: '<reason>'` and the bar shows the reason.
//
// Rate rule: a canvas re-renders on every data tick and rebuilds its action
// list each time. The registry stores the latest list without notifying, and
// republishes only when what the bar shows changes (id, label, icon, kind,
// pressed, disabled, shortcut); clicks and shortcuts always reach the latest
// `onClick` through the registry.
//
// Shortcut vocabulary: `'primary+<A-Z>'` (Cmd on macOS, Ctrl elsewhere) or
// `'alt+<A-Z>'` (Option on macOS), case-insensitive. Shift is never part of a
// binding, so a Shift combo passes through to the browser. A string outside
// the vocabulary is neither bound nor shown.

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  type ReactNode,
} from 'react';
import type { Action } from './types';
import { useLatest } from './useLatest';

// -------------------------------------------------------------- shortcuts --

export type ShortcutMod = 'primary' | 'alt';

export interface ParsedShortcut {
  mod: ShortcutMod;
  /** Lower-case letter a–z. */
  key: string;
}

/** Computed once: the primary group binds to Cmd on macOS, Ctrl elsewhere. */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

const SHORTCUT_RE = /^(primary|alt)\+([a-z])$/i;

/** `'primary+S'` → `{ mod: 'primary', key: 's' }`; `null` outside the vocabulary. */
export function parseShortcut(shortcut: string | undefined): ParsedShortcut | null {
  if (shortcut === undefined) return null;
  const m = SHORTCUT_RE.exec(shortcut.trim());
  if (m === null) return null;
  return { mod: m[1].toLowerCase() as ShortcutMod, key: m[2].toLowerCase() };
}

/** The tooltip form: `⌘S` / `⌥T` on macOS, `Ctrl+S` / `Alt+T` elsewhere; `''` if unparseable. */
export function formatShortcut(shortcut: string | undefined, mac: boolean = IS_MAC): string {
  const parsed = parseShortcut(shortcut);
  if (parsed === null) return '';
  const key = parsed.key.toUpperCase();
  if (parsed.mod === 'alt') return mac ? `⌥${key}` : `Alt+${key}`;
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}

/** The keyboard-event fields a shortcut match depends on. */
export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The first action whose shortcut the event matches, or `null`. Pure. */
export function resolveActionShortcut(
  e: KeyEventLike,
  actions: readonly Action[],
  mac: boolean = IS_MAC
): Action | null {
  if (e.shiftKey) return null;
  const primary = mac ? e.metaKey : e.ctrlKey;
  // Option/Alt can change e.key on some layouts (Option+T => † on macOS):
  // prefer the physical letter key.
  const fromCode =
    typeof e.code === 'string' && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : '';
  const key = fromCode || e.key.toLowerCase();
  for (const a of actions) {
    const s = parseShortcut(a.shortcut);
    if (s === null || s.key !== key) continue;
    const modMatches = s.mod === 'primary' ? primary && !e.altKey : e.altKey && !primary;
    if (modMatches) return a;
  }
  return null;
}

/** Whether the event is exactly the binding `shortcut` (same rules as {@link resolveActionShortcut}). Pure. */
export function matchesShortcut(e: KeyEventLike, shortcut: string, mac: boolean = IS_MAC): boolean {
  const probe = { shortcut } as Action;
  return resolveActionShortcut(e, [probe], mac) === probe;
}

/** Keys typed into a form field or editable region are never shortcuts. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Bindings claimed even in an editable target: typing never uses them, and
 * letting them through would run the browser's own command on the bare
 * iframe — Cmd/Ctrl+P in a PV field printed the raw page, not Trace's sheet.
 */
const CLAIMED_IN_EDITABLE: readonly ParsedShortcut[] = [{ mod: 'primary', key: 'p' }];

/** Whether `action`'s shortcut is one that fires even inside a form field. */
export function claimsInEditable(action: Action): boolean {
  const s = parseShortcut(action.shortcut);
  return s !== null && CLAIMED_IN_EDITABLE.some((c) => c.mod === s.mod && c.key === s.key);
}

// --------------------------------------------------------------- registry --

export interface ActionRegistry {
  /** Store `actions` for registrant `key`; republish only if what the bar shows changed. */
  set(key: string, actions: readonly Action[]): void;
  /** Drop registrant `key` (its actions and shortcuts go). */
  remove(key: string): void;
  /** Every registrant's actions in registration order; stable between publishes. */
  getSnapshot(): readonly Action[];
  subscribe(listener: () => void): () => void;
}

function sameShown(a: readonly Action[], b: readonly Action[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.label !== y.label ||
      x.icon !== y.icon ||
      x.kind !== y.kind ||
      Boolean(x.pressed) !== Boolean(y.pressed) ||
      (x.disabled || false) !== (y.disabled || false) ||
      x.shortcut !== y.shortcut
    ) {
      return false;
    }
  }
  return true;
}

export function createActionRegistry(): ActionRegistry {
  /** Latest list per registrant (Map keeps registration order). */
  const latest = new Map<string, readonly Action[]>();
  /** What was last published per registrant. */
  const shown = new Map<string, readonly Action[]>();
  const listeners = new Set<() => void>();
  let snapshot: readonly Action[] = Object.freeze([]);

  function invoke(key: string, index: number, id: string): void {
    const list = latest.get(key);
    const current = list?.[index]?.id === id ? list[index] : list?.find((a) => a.id === id);
    if (current === undefined || current.disabled) return;
    current.onClick();
  }

  function publish(): void {
    const next: Action[] = [];
    for (const [key, list] of shown) {
      list.forEach((a, index) => {
        next.push({ ...a, onClick: () => invoke(key, index, a.id) });
      });
    }
    snapshot = Object.freeze(next);
    for (const l of [...listeners]) l();
  }

  return {
    set(key, actions) {
      latest.set(key, actions);
      const prev = shown.get(key);
      if (prev !== undefined && sameShown(prev, actions)) return;
      shown.set(key, actions);
      publish();
    },
    remove(key) {
      latest.delete(key);
      if (!shown.delete(key)) return;
      publish();
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---------------------------------------------------------------- context --

const CanvasActionsContext = createContext<ActionRegistry | null>(null);

/** Hands the workbench's registry to the canvas slot. */
export function CanvasActionsProvider({
  registry,
  children,
}: {
  registry: ActionRegistry;
  children?: ReactNode;
}) {
  return createElement(CanvasActionsContext.Provider, { value: registry }, children);
}

/**
 * Register this component's actions in the tool's actions bar for as long as
 * it is mounted. Call it with the full list every render; outside a workbench
 * (a canvas rendered alone in a test) it does nothing.
 */
export function useCanvasActions(actions: readonly Action[]): void {
  const registry = useContext(CanvasActionsContext);
  const key = useId();

  // Declared first so a StrictMode re-mount removes, then the effect below
  // re-registers the list.
  useLayoutEffect(() => {
    if (registry === null) return;
    return () => registry.remove(key);
  }, [registry, key]);

  // Every render: cheap unless what the bar shows changed.
  useLayoutEffect(() => {
    registry?.set(key, actions);
  });
}

// --------------------------------------------------------------- listener --

/** Under the host bar, primary+S asks the host to save its view. */
export const SAVE_VIEW = 'canopy:save-view';

/** The save-view message, posted to `window.parent` at `location.origin`. */
export interface SaveViewMessage {
  type: typeof SAVE_VIEW;
}

/** The binding the host bar claims for Save view, in every tool. */
export const SAVE_VIEW_SHORTCUT = 'primary+S';

/** Post `canopy:save-view` to the parent frame, same-origin only. */
export function postSaveView(): void {
  const message: SaveViewMessage = { type: SAVE_VIEW };
  window.parent.postMessage(message, window.location.origin);
}

export interface ActionShortcutsOptions {
  /** The host draws the tool's tile bar: the actions bar is hidden, the shortcuts still bind. */
  hostBar: boolean;
  /**
   * Under the host bar, primary+S: ask the host to save the view. Defaults
   * to {@link postSaveView}.
   */
  onSaveView?: () => void;
}

/**
 * Bind every registered shortcut with one window listener. The workbench
 * mounts it whether or not the actions bar renders, so a tool under
 * the host bar (actions bar hidden) keeps its keyboard shortcuts.
 *
 * Under the host bar, primary+S is intercepted before the registry lookup in
 * every tool: it is claimed (never the browser's Save page, not even from a
 * form field, since typing never uses it) and posts `canopy:save-view`; a
 * tool's own primary+S action never fires. Otherwise the branch does not
 * exist.
 */
export function useActionShortcuts(
  registry: ActionRegistry,
  options: ActionShortcutsOptions
): void {
  const { hostBar } = options;
  const onSaveView = useLatest(options.onSaveView);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (hostBar && matchesShortcut(e, SAVE_VIEW_SHORTCUT)) {
        e.preventDefault();
        if (e.repeat) return;
        (onSaveView.current ?? postSaveView)();
        return;
      }
      const action = resolveActionShortcut(e, registry.getSnapshot());
      if (action === null) return;
      // Keys in a form field are text, except Print.
      if (isEditableTarget(e.target) && !claimsInEditable(action)) return;
      // Claim the key even while the action is disabled, so Ctrl+S never
      // falls through to the browser's own Save.
      e.preventDefault();
      if (e.repeat || action.disabled) return;
      action.onClick();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [registry, hostBar, onSaveView]);
}
