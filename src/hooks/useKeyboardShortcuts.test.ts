import { describe, it, expect } from 'vitest';
import { resolveShortcut, type KeyEventLike } from './useKeyboardShortcuts';

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

describe('resolveShortcut', () => {
  describe('primary group (Ctrl on non-Mac, Cmd on Mac)', () => {
    it('maps Ctrl+S to Save on non-Mac', () => {
      expect(resolveShortcut(ev({ key: 's', ctrlKey: true }), false)).toBe('onSave');
    });

    it('maps Cmd+S to Save on Mac', () => {
      expect(resolveShortcut(ev({ key: 's', metaKey: true }), true)).toBe('onSave');
    });

    it('does not match Ctrl+S on Mac (wrong modifier for the platform)', () => {
      expect(resolveShortcut(ev({ key: 's', ctrlKey: true }), true)).toBeNull();
    });

    it('maps Ctrl+P to Print, Ctrl+E to Post E-Log, Ctrl+O to Open, Ctrl+I to Export image', () => {
      expect(resolveShortcut(ev({ key: 'p', ctrlKey: true }), false)).toBe('onPrint');
      expect(resolveShortcut(ev({ key: 'e', ctrlKey: true }), false)).toBe('onPostElog');
      expect(resolveShortcut(ev({ key: 'o', ctrlKey: true }), false)).toBe('onOpen');
      expect(resolveShortcut(ev({ key: 'i', ctrlKey: true }), false)).toBe('onExportImage');
    });

    it('is case-insensitive on the key', () => {
      expect(resolveShortcut(ev({ key: 'S', ctrlKey: true }), false)).toBe('onSave');
    });
  });

  describe('alt group (Alt/Option on all platforms)', () => {
    it('maps Alt+D to Data Insight and Alt+T to theme toggle', () => {
      expect(resolveShortcut(ev({ key: 'd', altKey: true }), false)).toBe('onDataInsight');
      expect(resolveShortcut(ev({ key: 't', altKey: true }), false)).toBe('onToggleTheme');
      expect(resolveShortcut(ev({ key: 'd', altKey: true }), true)).toBe('onDataInsight');
    });

    it('uses physical key code when Option changes key characters on macOS layouts', () => {
      expect(resolveShortcut(ev({ key: '†', code: 'KeyT', altKey: true }), true)).toBe(
        'onToggleTheme'
      );
      expect(resolveShortcut(ev({ key: '∂', code: 'KeyD', altKey: true }), true)).toBe(
        'onDataInsight'
      );
    });

    it('does not fire the alt group when the primary modifier is also held', () => {
      expect(resolveShortcut(ev({ key: 'd', altKey: true, ctrlKey: true }), false)).toBeNull();
    });
  });

  describe('view history shortcuts', () => {
    describe('macOS: ⌥← / ⌥→', () => {
      it('maps Alt+ArrowLeft to viewBack', () => {
        expect(resolveShortcut(ev({ key: 'ArrowLeft', altKey: true }), true)).toBe('onViewBack');
      });

      it('maps Alt+ArrowRight to viewForward', () => {
        expect(resolveShortcut(ev({ key: 'ArrowRight', altKey: true }), true)).toBe(
          'onViewForward'
        );
      });

      it('does not bind Alt+Arrow on non-Mac (browser Back/Forward conflict)', () => {
        expect(resolveShortcut(ev({ key: 'ArrowLeft', altKey: true }), false)).toBeNull();
        expect(resolveShortcut(ev({ key: 'ArrowRight', altKey: true }), false)).toBeNull();
      });

      it('does not match Alt+Arrow when primary modifier is also held', () => {
        expect(
          resolveShortcut(ev({ key: 'ArrowLeft', altKey: true, metaKey: true }), true)
        ).toBeNull();
      });

      it('does not match arrow keys without Alt', () => {
        expect(resolveShortcut(ev({ key: 'ArrowLeft' }), true)).toBeNull();
        expect(resolveShortcut(ev({ key: 'ArrowRight' }), true)).toBeNull();
      });
    });

    describe('non-Mac: Ctrl+[ / Ctrl+]', () => {
      it('maps Ctrl+[ to viewBack', () => {
        expect(resolveShortcut(ev({ key: '[', ctrlKey: true }), false)).toBe('onViewBack');
      });

      it('maps Ctrl+] to viewForward', () => {
        expect(resolveShortcut(ev({ key: ']', ctrlKey: true }), false)).toBe('onViewForward');
      });

      it('does not bind Ctrl+[/] on macOS (⌥Arrow is used instead)', () => {
        expect(resolveShortcut(ev({ key: '[', metaKey: true }), true)).toBeNull();
        expect(resolveShortcut(ev({ key: ']', metaKey: true }), true)).toBeNull();
      });
    });

    describe('reset zoom: Alt+0 (all platforms)', () => {
      it('maps Alt+0 to resetZoom', () => {
        expect(resolveShortcut(ev({ key: '0', altKey: true }), false)).toBe('onResetZoom');
        expect(resolveShortcut(ev({ key: '0', code: 'Digit0', altKey: true }), true)).toBe(
          'onResetZoom'
        );
      });

      it('maps Alt+0 via code when Option changes key on macOS', () => {
        expect(resolveShortcut(ev({ key: 'º', code: 'Digit0', altKey: true }), true)).toBe(
          'onResetZoom'
        );
      });
    });
  });

  describe('non-matches pass through to the browser', () => {
    it('ignores a bare key with no modifier', () => {
      expect(resolveShortcut(ev({ key: 's' }), false)).toBeNull();
    });

    it('ignores unbound keys', () => {
      expect(resolveShortcut(ev({ key: 'a', ctrlKey: true }), false)).toBeNull();
    });

    it('ignores Shift combos so e.g. Ctrl+Shift+S stays a browser shortcut', () => {
      expect(resolveShortcut(ev({ key: 's', ctrlKey: true, shiftKey: true }), false)).toBeNull();
    });

    it('does not treat the primary key alone (without its letter) as a match', () => {
      expect(resolveShortcut(ev({ key: 'Control', ctrlKey: true }), false)).toBeNull();
    });
  });
});
