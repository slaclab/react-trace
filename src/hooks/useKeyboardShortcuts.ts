import { useEffect, useRef } from 'react';

/**
 * Handlers for the app's keyboard shortcuts. Each is optional; an undefined
 * handler makes its shortcut a no-op (e.g. E-Log when unconfigured), matching
 * the toolbar where the corresponding button is hidden.
 */
export interface ShortcutHandlers {
  onSave?: () => void;
  onPrint?: () => void;
  onOpen?: () => void;
  onExportImage?: () => void;
  onPostElog?: () => void;
  onDataInsight?: () => void;
  onToggleTheme?: () => void;
  onViewBack?: () => void;
  onViewForward?: () => void;
  onResetZoom?: () => void;
}

/** Handler keys, in binding order. */
type Action = keyof ShortcutHandlers;

/** Which modifier a binding's key uses. */
type Mod = 'primary' | 'alt';

// Platform detection, computed once. The primary group binds to Cmd on macOS
// and Ctrl elsewhere; the Alt group binds to Alt (Option on macOS) everywhere.
export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/**
 * Format a shortcut for display in tooltips, using platform-native glyphs on
 * macOS (⌘ / ⌥) and word modifiers elsewhere. Kept next to the bindings so the
 * displayed hint can't drift from what the listener actually matches.
 */
export function formatShortcut(mod: Mod, key: string): string {
  if (mod === 'alt') return isMac ? `⌥${key}` : `Alt+${key}`;
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}

// Bindings: (modifier group, lowercase key) → the handler it invokes.
const BINDINGS: { mod: Mod; key: string; action: Action }[] = [
  { mod: 'primary', key: 's', action: 'onSave' },
  { mod: 'primary', key: 'p', action: 'onPrint' },
  { mod: 'primary', key: 'e', action: 'onPostElog' },
  { mod: 'primary', key: 'o', action: 'onOpen' },
  { mod: 'primary', key: 'i', action: 'onExportImage' },
  { mod: 'alt', key: 'd', action: 'onDataInsight' },
  { mod: 'alt', key: 't', action: 'onToggleTheme' },
  { mod: 'alt', key: 'arrowleft', action: 'onViewBack' },
  { mod: 'alt', key: 'arrowright', action: 'onViewForward' },
  { mod: 'alt', key: '0', action: 'onResetZoom' },
];

/** The event fields a shortcut match depends on. */
export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Pure core of the shortcut layer: given a keyboard event's modifier state and
 * the platform, return which handler the event maps to, or null if none. Shift
 * is never part of a binding, so a Shift combo (e.g. Ctrl+Shift+S) matches
 * nothing and passes through to the browser. Exported for unit testing.
 */
export function resolveShortcut(e: KeyEventLike, mac: boolean): Action | null {
  if (e.shiftKey) return null;
  const primary = mac ? e.metaKey : e.ctrlKey;
  // Option/Alt can change e.key on some keyboard layouts (e.g. Option+T => †
  // on macOS). Prefer physical letter keys via e.code when available.
  const keyFromCode =
    typeof e.code === 'string' && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : '';
  const key = keyFromCode || e.key.toLowerCase();
  for (const b of BINDINGS) {
    if (b.key !== key) continue;
    const modMatches = b.mod === 'primary' ? primary && !e.altKey : e.altKey && !primary;
    if (modMatches) return b.action;
  }
  return null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Registers a single window keydown listener mapping the app's shortcuts to the
 * given handlers. Handlers are read through a ref so the listener is attached
 * once and never goes stale, even though TraceApp redefines its handlers each
 * render.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const ref = useRef(handlers);
  // Keep the ref pointed at the latest handlers without re-subscribing the
  // listener. Updated in an effect (not during render) so the ref is only
  // written after commit.
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't hijack typing in form fields.
      if (isEditableTarget(e.target)) return;

      const action = resolveShortcut(e, isMac);
      if (!action) return;

      const run = ref.current[action];
      // Only intercept when a handler is actually wired. This keeps the browser
      // default when a shortcut is inactive.
      if (!run) return;
      e.preventDefault();
      run();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
