// Trace's keyboard shortcuts resolved against its action list: the cases of
// main's `useKeyboardShortcuts.test.ts`, ported onto the workbench's
// `resolveActionShortcut` (src/workbench/useCanvasActions.ts), which took over
// that matching when Trace moved onto the workbench. Platform rules: the
// primary group is Ctrl elsewhere and Cmd on macOS, the alt group is
// Alt/Option on both, the physical key wins over an Option-changed character,
// and anything else is left to the browser.
import { describe, expect, it, vi } from 'vitest';
import { resolveActionShortcut, type KeyEventLike } from '../../workbench/useCanvasActions';
import type { Action } from '../../workbench/types';
import { traceCapabilities } from './capabilities';
import { traceActions, type TraceActionHandlers } from './actions';

function handlers(): TraceActionHandlers {
  return {
    searchPvs: vi.fn(),
    refreshArchive: vi.fn(),
    dataInsight: vi.fn(),
    postElog: vi.fn(),
    save: vi.fn(),
    configStore: vi.fn(),
    print: vi.fn(),
    import: vi.fn(),
    exportCsv: vi.fn(),
    exportPng: vi.fn(),
  };
}

// Standalone with a logbook and the theme toggle: every shortcut is bound.
const ACTIONS: Action[] = traceActions({
  handlers: handlers(),
  capabilities: traceCapabilities({ elog: true }),
  embedded: false,
  theme: { colorMode: 'light', toggle: () => {} },
  bugUrl: 'https://example.org/bug',
  docsUrl: 'https://example.org/docs',
});

// Build a KeyEventLike with no modifiers, then layer on what each test needs.
function ev(overrides: Partial<KeyEventLike>): KeyEventLike {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

/** The id of the action the event resolves to on that platform, or null. */
function resolve(e: KeyEventLike, mac: boolean): string | null {
  return resolveActionShortcut(e, ACTIONS, mac)?.id ?? null;
}

describe('Trace shortcuts (ported from main)', () => {
  it('binds the theme toggle in the standalone list', () => {
    expect(ACTIONS.some((a) => a.id === 'theme')).toBe(true);
  });

  describe('primary group (Ctrl on non-Mac, Cmd on Mac)', () => {
    it('maps Ctrl+S to Save on non-Mac', () => {
      expect(resolve(ev({ key: 's', ctrlKey: true }), false)).toBe('save');
    });

    it('maps Cmd+S to Save on Mac', () => {
      expect(resolve(ev({ key: 's', metaKey: true }), true)).toBe('save');
    });

    it('does not match Ctrl+S on Mac (wrong modifier for the platform)', () => {
      expect(resolve(ev({ key: 's', ctrlKey: true }), true)).toBeNull();
    });

    it('maps Ctrl+P to Print, Ctrl+E to Post E-Log, Ctrl+O to Import, Ctrl+I to Export PNG', () => {
      expect(resolve(ev({ key: 'p', ctrlKey: true }), false)).toBe('print');
      expect(resolve(ev({ key: 'e', ctrlKey: true }), false)).toBe('post-elog');
      expect(resolve(ev({ key: 'o', ctrlKey: true }), false)).toBe('import');
      expect(resolve(ev({ key: 'i', ctrlKey: true }), false)).toBe('export-png');
    });

    it('is case-insensitive on the key', () => {
      expect(resolve(ev({ key: 'S', ctrlKey: true }), false)).toBe('save');
    });
  });

  describe('alt group (Alt/Option on all platforms)', () => {
    it('maps Alt+D to Data Insight and Alt+T to the theme toggle', () => {
      expect(resolve(ev({ key: 'd', altKey: true }), false)).toBe('data-insight');
      expect(resolve(ev({ key: 't', altKey: true }), false)).toBe('theme');
      expect(resolve(ev({ key: 'd', altKey: true }), true)).toBe('data-insight');
    });

    it('uses the physical key code when Option changes the character on macOS layouts', () => {
      expect(resolve(ev({ key: '†', code: 'KeyT', altKey: true }), true)).toBe('theme');
      expect(resolve(ev({ key: '∂', code: 'KeyD', altKey: true }), true)).toBe('data-insight');
    });

    it('falls back to the key when the event has no code', () => {
      expect(
        resolve({ key: 'd', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false }, false)
      ).toBe('data-insight');
    });

    it('does not fire the alt group when the primary modifier is also held', () => {
      expect(resolve(ev({ key: 'd', altKey: true, ctrlKey: true }), false)).toBeNull();
    });
  });

  describe('non-matches pass through to the browser', () => {
    it('ignores a bare key with no modifier', () => {
      expect(resolve(ev({ key: 's' }), false)).toBeNull();
    });

    it('ignores unbound keys', () => {
      expect(resolve(ev({ key: 'a', ctrlKey: true }), false)).toBeNull();
    });

    it('ignores Shift combos so e.g. Ctrl+Shift+S stays a browser shortcut', () => {
      expect(resolve(ev({ key: 's', ctrlKey: true, shiftKey: true }), false)).toBeNull();
    });

    it('does not treat the primary key alone (without its letter) as a match', () => {
      expect(resolve(ev({ key: 'Control', ctrlKey: true }), false)).toBeNull();
    });
  });
});
