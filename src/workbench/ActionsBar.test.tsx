// @vitest-environment jsdom
//
// The actions bar: actions are registered at runtime
// from inside the canvas, rendered under `actions-bar`, and every shortcut is
// bound from that one list.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useState, type ReactNode } from 'react';
import { Add, Pause } from '@carbon/icons-react';

import type { Action } from './types';
import { TESTIDS } from './testids';
import { ActionsBar } from './ActionsBar';
import {
  CanvasActionsProvider,
  createActionRegistry,
  formatShortcut,
  parseShortcut,
  resolveActionShortcut,
  useActionShortcuts,
  useCanvasActions,
  type ActionRegistry,
} from './useCanvasActions';
import { standardActions } from './standardActions';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function action(over: Partial<Action> & Pick<Action, 'id' | 'label'>): Action {
  return { icon: Add, kind: 'button', onClick: () => {}, ...over };
}

/** A canvas that registers whatever it is given. */
function Canvas({ actions }: { actions: Action[] }) {
  useCanvasActions(actions);
  return <div>canvas</div>;
}

/** The workbench side: one registry, its shortcut listener, the canvas slot and the bar. */
function Harness({ registry, children }: { registry: ActionRegistry; children: ReactNode }) {
  useActionShortcuts(registry, { hostBar: false });
  return (
    <CanvasActionsProvider registry={registry}>
      <ActionsBar registry={registry} />
      {children}
    </CanvasActionsProvider>
  );
}

function bar(): HTMLElement {
  return screen.getByTestId(TESTIDS.actionsBar);
}

function barButtons(): HTMLElement[] {
  return Array.from(bar().querySelectorAll('button'));
}

function primaryKey(key: string, init: KeyboardEventInit = {}) {
  // jsdom's navigator.platform is not a Mac, so primary is Ctrl.
  return { key: key.toLowerCase(), code: `Key${key.toUpperCase()}`, ctrlKey: true, ...init };
}

describe('registration', () => {
  it('renders the actions a child registers, in order, under actions-bar', () => {
    const registry = createActionRegistry();
    render(
      <Harness registry={registry}>
        <Canvas
          actions={[action({ id: 'a', label: 'Export' }), action({ id: 'b', label: 'Clear' })]}
        />
      </Harness>
    );
    expect(barButtons()).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
    expect(bar().textContent).toMatch(/Export[\s\S]*Clear/);
  });

  it('unregisters on unmount', () => {
    const registry = createActionRegistry();
    function Toggle() {
      const [on, setOn] = useState(true);
      return (
        <Harness registry={registry}>
          <button type="button" onClick={() => setOn(false)}>
            unmount
          </button>
          {on && <Canvas actions={[action({ id: 'a', label: 'Export' })]} />}
        </Harness>
      );
    }
    render(<Toggle />);
    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'unmount' }));
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
    expect(registry.getSnapshot()).toHaveLength(0);
  });

  it('keeps two registrants apart and survives StrictMode double effects', () => {
    const registry = createActionRegistry();
    render(
      <StrictMode>
        <Harness registry={registry}>
          <Canvas actions={[action({ id: 'a', label: 'Export' })]} />
          <Canvas actions={[action({ id: 'b', label: 'Docs' })]} />
        </Harness>
      </StrictMode>
    );
    expect(barButtons()).toHaveLength(2);
  });

  it('calls the latest onClick without re-publishing an unchanged list', () => {
    const registry = createActionRegistry();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <Harness registry={registry}>
        <Canvas actions={[action({ id: 'a', label: 'Export', onClick: first })]} />
      </Harness>
    );
    const before = registry.getSnapshot();
    rerender(
      <Harness registry={registry}>
        <Canvas actions={[action({ id: 'a', label: 'Export', onClick: second })]} />
      </Harness>
    );
    expect(registry.getSnapshot()).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('is a no-op outside a provider', () => {
    expect(() => render(<Canvas actions={[action({ id: 'a', label: 'Export' })]} />)).not.toThrow();
  });
});

describe('rendering', () => {
  it('gives a toggle aria-pressed that follows `pressed`', () => {
    const registry = createActionRegistry();
    function PauseCanvas() {
      const [paused, setPaused] = useState(false);
      useCanvasActions([
        action({
          id: 'pause',
          label: 'Pause',
          icon: Pause,
          kind: 'toggle',
          pressed: paused,
          onClick: () => setPaused((p) => !p),
        }),
      ]);
      return null;
    }
    render(
      <Harness registry={registry}>
        <PauseCanvas />
      </Harness>
    );
    const button = screen.getByRole('button', { name: 'Pause' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Pause' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('gives a plain button no aria-pressed', () => {
    const registry = createActionRegistry();
    render(
      <Harness registry={registry}>
        <Canvas actions={[action({ id: 'a', label: 'Export' })]} />
      </Harness>
    );
    expect(screen.getByRole('button', { name: 'Export' }).hasAttribute('aria-pressed')).toBe(false);
  });

  it('puts the disabled reason in the tooltip and does not fire', () => {
    const registry = createActionRegistry();
    const onClick = vi.fn();
    render(
      <Harness registry={registry}>
        <Canvas
          actions={[action({ id: 'x', label: 'Export', disabled: 'No frame yet', onClick })]}
        />
      </Harness>
    );
    const button = screen.getByRole('button', { name: /Export/ });
    expect(
      button.getAttribute('aria-disabled') === 'true' || (button as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.getByRole('button', { name: /No frame yet/ })).toBe(button);
    expect(screen.getAllByText(/No frame yet/).length).toBeGreaterThan(0);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows the shortcut in the tooltip', () => {
    const registry = createActionRegistry();
    render(
      <Harness registry={registry}>
        <Canvas actions={[action({ id: 's', label: 'Save', shortcut: 'primary+S' })]} />
      </Harness>
    );
    expect(
      screen.getByRole('button', { name: `Save (${formatShortcut('primary+S')})` })
    ).toBeTruthy();
  });
});

describe('shortcuts', () => {
  it('fires a registered shortcut exactly once', () => {
    const registry = createActionRegistry();
    const onSave = vi.fn();
    render(
      <StrictMode>
        <Harness registry={registry}>
          <Canvas
            actions={[action({ id: 's', label: 'Save', shortcut: 'primary+S', onClick: onSave })]}
          />
        </Harness>
      </StrictMode>
    );
    const event = new KeyboardEvent('keydown', {
      ...primaryKey('s'),
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores keys typed in inputs', () => {
    const registry = createActionRegistry();
    const onSave = vi.fn();
    render(
      <Harness registry={registry}>
        <input aria-label="field" />
        <Canvas
          actions={[action({ id: 's', label: 'Save', shortcut: 'primary+S', onClick: onSave })]}
        />
      </Harness>
    );
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'field' }), primaryKey('s'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('claims primary+P in an input, so Print never leaks to the browser', () => {
    const registry = createActionRegistry();
    const onPrint = vi.fn();
    const onSave = vi.fn();
    render(
      <Harness registry={registry}>
        <input aria-label="field" />
        <textarea aria-label="notes" />
        <Canvas
          actions={[
            action({ id: 's', label: 'Save', shortcut: 'primary+S', onClick: onSave }),
            action({ id: 'p', label: 'Print', shortcut: 'primary+P', onClick: onPrint }),
          ]}
        />
      </Harness>
    );
    const input = screen.getByRole('textbox', { name: 'field' });
    const event = new KeyboardEvent('keydown', {
      ...primaryKey('p'),
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      input.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(onPrint).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'notes' }), primaryKey('p'));
    expect(onPrint).toHaveBeenCalledTimes(2);

    // Every other shortcut still skips an editable target and stays unclaimed.
    const save = new KeyboardEvent('keydown', {
      ...primaryKey('s'),
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      input.dispatchEvent(save);
    });
    expect(save.defaultPrevented).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('leaves primary+P in an input to the browser when no action binds it', () => {
    const registry = createActionRegistry();
    render(
      <Harness registry={registry}>
        <input aria-label="field" />
        <Canvas actions={[action({ id: 's', label: 'Save', shortcut: 'primary+S' })]} />
      </Harness>
    );
    const event = new KeyboardEvent('keydown', {
      ...primaryKey('p'),
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      screen.getByRole('textbox', { name: 'field' }).dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not fire a disabled action, a Shift combo, an auto-repeat or an unbound key', () => {
    const registry = createActionRegistry();
    const onSave = vi.fn();
    const onExport = vi.fn();
    render(
      <Harness registry={registry}>
        <Canvas
          actions={[
            action({ id: 's', label: 'Save', shortcut: 'primary+S', onClick: onSave }),
            action({
              id: 'e',
              label: 'Export',
              shortcut: 'alt+E',
              disabled: 'No frame',
              onClick: onExport,
            }),
          ]}
        />
      </Harness>
    );
    fireEvent.keyDown(window, { key: 'e', code: 'KeyE', altKey: true });
    fireEvent.keyDown(window, primaryKey('s', { shiftKey: true }));
    fireEvent.keyDown(window, primaryKey('s', { repeat: true }));
    fireEvent.keyDown(window, primaryKey('q'));
    expect(onSave).not.toHaveBeenCalled();
    expect(onExport).not.toHaveBeenCalled();
  });

  it('stops binding a shortcut once its registrant unmounts', () => {
    const registry = createActionRegistry();
    const onSave = vi.fn();
    const { rerender } = render(
      <Harness registry={registry}>
        <Canvas
          actions={[action({ id: 's', label: 'Save', shortcut: 'primary+S', onClick: onSave })]}
        />
      </Harness>
    );
    rerender(<Harness registry={registry}>{null}</Harness>);
    fireEvent.keyDown(window, primaryKey('s'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('parses, formats and resolves the shortcut vocabulary', () => {
    expect(parseShortcut('primary+S')).toEqual({ mod: 'primary', key: 's' });
    expect(parseShortcut('Alt+t')).toEqual({ mod: 'alt', key: 't' });
    expect(parseShortcut('shift+S')).toBeNull();
    expect(parseShortcut('primary+F5')).toBeNull();
    expect(formatShortcut('alt+T', true)).toBe('⌥T');
    expect(formatShortcut('primary+S', false)).toBe('Ctrl+S');
    const actions = [action({ id: 's', label: 'Save', shortcut: 'primary+S' })];
    const ev = {
      key: 's',
      code: 'KeyS',
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
    };
    expect(resolveActionShortcut(ev, actions, true)?.id).toBe('s');
    expect(resolveActionShortcut(ev, actions, false)).toBeNull();
    // Option+T gives "†" on a Mac: the physical key wins.
    const opt = {
      key: '†',
      code: 'KeyT',
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
    };
    expect(
      resolveActionShortcut(opt, [action({ id: 't', label: 'T', shortcut: 'alt+T' })], true)?.id
    ).toBe('t');
  });
});

describe('standardActions', () => {
  const theme = { colorMode: 'dark' as const, toggle: vi.fn() };
  const urls = { bugUrl: 'https://example.org/bug', docsUrl: 'https://example.org/docs' };

  it('gives bug and docs in every mode and the theme toggle standalone only', () => {
    const standalone = standardActions({ embedded: false, theme, ...urls }).map((a) => a.label);
    expect(standalone).toEqual(['Switch to light mode', 'Report a bug', 'Docs']);
    const embedded = standardActions({ embedded: true, theme, ...urls }).map((a) => a.label);
    expect(embedded).toEqual(['Report a bug', 'Docs']);
    const noHandle = standardActions({ embedded: false, ...urls }).map((a) => a.label);
    expect(noHandle).toEqual(['Report a bug', 'Docs']);
  });

  it('labels the toggle for the mode it switches to and binds Alt+T', () => {
    const [light] = standardActions({
      embedded: false,
      theme: { colorMode: 'light', toggle: () => {} },
      ...urls,
    });
    expect(light.label).toBe('Switch to dark mode');
    expect(light.shortcut).toBe('alt+T');
  });

  it('renders no theme toggle in the bar when embedded, and its shortcut does nothing', () => {
    const registry = createActionRegistry();
    const toggle = vi.fn();
    render(
      <Harness registry={registry}>
        <Canvas
          actions={standardActions({
            embedded: true,
            theme: { colorMode: 'dark', toggle },
            ...urls,
          })}
        />
      </Harness>
    );
    expect(screen.queryByRole('button', { name: /switch to (light|dark) mode/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Report a bug' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Docs' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 't', code: 'KeyT', altKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });

  it('toggles the theme standalone from the bar and the shortcut', () => {
    const registry = createActionRegistry();
    const toggle = vi.fn();
    render(
      <Harness registry={registry}>
        <Canvas
          actions={standardActions({
            embedded: false,
            theme: { colorMode: 'dark', toggle },
            ...urls,
          })}
        />
      </Harness>
    );
    fireEvent.click(screen.getByRole('button', { name: /switch to light mode/i }));
    fireEvent.keyDown(window, { key: 't', code: 'KeyT', altKey: true });
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it('opens bug and docs URLs in a new tab without an opener', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const [bug, docs] = standardActions({ embedded: true, ...urls });
    bug.onClick();
    docs.onClick();
    expect(open).toHaveBeenNthCalledWith(1, urls.bugUrl, '_blank', 'noopener,noreferrer');
    expect(open).toHaveBeenNthCalledWith(2, urls.docsUrl, '_blank', 'noopener,noreferrer');
  });
});
