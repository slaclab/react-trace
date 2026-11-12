// The plot-root keymap. Pure: a keyboard event in, a command out. SinglePlot
// binds ONE native keydown listener on its root element and acts on the
// result. `primary+Z` is deliberately absent: undo is the document-level
// `host/UndoKeyListener`, not a plot command.
//
// Matching rules:
// - letters by `e.code` (the physical key, as `resolveActionShortcut` does —
//   Option+H is `˙` on macOS);
// - zoom by `e.key` in `+ = - _` or the numpad codes, because on a German
//   layout `+` is `BracketRight` and on a US one it is shifted `Equal`; the
//   typographic minus `−` is never a key a keyboard sends;
// - arrows, Escape, Delete/Backspace by `e.key`, unmodified;
// - editable targets and already-handled (`defaultPrevented`) events resolve
//   to nothing.
//
// Trace's binding (`resolveKey`) lives in `tools/trace/drawing/builtin`.
import type { AnnotationKind } from './model';
import type { Catalog } from './catalog/types';
import { IS_MAC, isEditableTarget, type KeyEventLike } from '../workbench/useCanvasActions';

/** Commands the plot root acts on itself (pan and zoom the view window). */
export type NavigationCommand = { kind: 'pan'; dir: -1 | 1 } | { kind: 'zoom'; dir: 'in' | 'out' };

/**
 * Commands the drawing layer acts on. `K` is the armed kind: a built-in kind
 * for the built-in bindings, any catalog kind for `resolveKeyIn`.
 */
export type DrawingCommand<K extends string = AnnotationKind> =
  | { kind: 'cancel' }
  | { kind: 'delete' }
  | { kind: 'arm'; tool: K };

export type KeyCommand<K extends string = AnnotationKind> = NavigationCommand | DrawingCommand<K>;

export function isNavigationCommand<K extends string>(
  cmd: KeyCommand<K>
): cmd is NavigationCommand {
  return cmd.kind === 'pan' || cmd.kind === 'zoom';
}

/** Alt+<letter> -> kind over `catalog`'s tools, in rail order (each tool's `key`, lowercased). */
export function toolKeysIn(catalog: Catalog): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const tool of catalog.tools) {
    if (tool.key !== undefined) out[tool.key.toLowerCase()] = tool.kind;
  }
  return Object.freeze(out);
}

/** Fraction of the span one arrow press pans. */
export const PAN_STEP = 0.1;
/** Span factor of one zoom press: `+` divides the span by it, `−` multiplies. */
export const ZOOM_STEP = 1.25;

/**
 * Every binding of the keymap in the shortcut vocabulary's terms, so a test
 * can prove none equals a registered Action shortcut. `mod: 'none'` keys are
 * named keys (`ArrowLeft`, `+`, …), never letters.
 */
export interface KeyBinding {
  mod: 'none' | 'alt' | 'primary';
  key: string;
}

/** The keymap's named (unmodified) keys; the same for every catalog. */
const NAMED_BINDINGS: readonly KeyBinding[] = [
  { mod: 'none', key: 'ArrowLeft' },
  { mod: 'none', key: 'ArrowRight' },
  { mod: 'none', key: '+' },
  { mod: 'none', key: '=' },
  { mod: 'none', key: '-' },
  { mod: 'none', key: '_' },
  { mod: 'none', key: 'Escape' },
  { mod: 'none', key: 'Delete' },
  { mod: 'none', key: 'Backspace' },
];

/** Every binding of the keymap over `catalog`: the named keys, then Alt+<letter> per tool key. */
export function keyBindingsIn(catalog: Catalog): readonly KeyBinding[] {
  return [
    ...NAMED_BINDINGS,
    ...Object.keys(toolKeysIn(catalog)).map((key) => ({ mod: 'alt' as const, key })),
  ];
}

/** The fields `resolveKeyIn` reads; a DOM `KeyboardEvent` satisfies it. */
export interface KeyEventInput extends KeyEventLike {
  target?: EventTarget | null;
  defaultPrevented?: boolean;
}

/** The plot command `e` asks for over `catalog`'s tool keys, or `null`. Pure. */
export function resolveKeyIn(
  catalog: Catalog,
  e: KeyEventInput,
  mac: boolean = IS_MAC
): KeyCommand<string> | null {
  if (e.defaultPrevented) return null;
  if (isEditableTarget(e.target ?? null)) return null;
  const primary = mac ? e.metaKey : e.ctrlKey;
  // The other platform's "primary" key (Ctrl on mac, Meta elsewhere) is left
  // to the OS and browser too.
  const otherMod = mac ? e.ctrlKey : e.metaKey;
  if (primary || otherMod) return null;

  if (e.altKey) {
    if (e.shiftKey) return null;
    const letter =
      typeof e.code === 'string' && /^Key[A-Z]$/.test(e.code)
        ? e.code.slice(3).toLowerCase()
        : e.key.length === 1
          ? e.key.toLowerCase()
          : '';
    if (letter === '') return null;
    const tool = catalog.tools.find((t) => t.key?.toLowerCase() === letter);
    return tool === undefined ? null : { kind: 'arm', tool: tool.kind };
  }

  // Zoom: shift is allowed — `+` and `_` are shifted on most layouts.
  if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') return { kind: 'zoom', dir: 'in' };
  if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') {
    return { kind: 'zoom', dir: 'out' };
  }

  if (e.shiftKey) return null;
  switch (e.key) {
    case 'ArrowLeft':
      return { kind: 'pan', dir: -1 };
    case 'ArrowRight':
      return { kind: 'pan', dir: 1 };
    case 'Escape':
      return { kind: 'cancel' };
    case 'Delete':
    case 'Backspace':
      return { kind: 'delete' };
    default:
      return null;
  }
}
