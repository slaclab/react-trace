// @vitest-environment jsdom
//
// `canopy:save-view`: under the host bar, primary+S is the host's Save view in
// all three tools. `useActionShortcuts` claims it before the registry lookup and
// posts `{type: 'canopy:save-view'}` to the parent at `location.origin`, so
// neither a tool's own primary+S action (Trace's download) nor the browser's
// Save page runs. Standalone the branch does not exist. jsdom is non-Mac, so
// primary = Ctrl.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import {
  SAVE_VIEW,
  createActionRegistry,
  matchesShortcut,
  useActionShortcuts,
  type ActionRegistry,
} from './useCanvasActions';
import type { Action } from './types';

// The workbench may not import the tools (eslint allow-list), so each tool is
// modelled by the shortcuts its real spec table binds: Trace's own primary+S
// download, Correlation's and Waveform's lists with no primary+S at all. The
// real tables are exercised in tools/trace/actions.test.tsx and the host-bar e2e.

type Fn = Mock<() => void>;
const fn = (): Fn => vi.fn<() => void>();

interface Tool {
  name: string;
  actions: Action[];
  handlers: Record<string, Fn>;
}

/** A tool's registry list from `[id, shortcut?]` pairs, one handler per action. */
function tool(name: string, bindings: [string, string?][]): Tool {
  const handlers: Record<string, Fn> = {};
  const actions = bindings.map(([id, shortcut]): Action => {
    const onClick = fn();
    handlers[id] = onClick;
    const action: Action = { id, label: id, icon: undefined as never, kind: 'button', onClick };
    if (shortcut !== undefined) action.shortcut = shortcut;
    return action;
  });
  return { name, actions, handlers };
}

/** Trace binds primary+S on its own download action. */
const trace = (): Tool =>
  tool('trace', [
    ['data-insight', 'alt+D'],
    ['post-elog', 'primary+E'],
    ['save', 'primary+S'],
    ['print', 'primary+P'],
    ['import', 'primary+O'],
    ['export-csv'],
    ['export-png', 'primary+I'],
  ]);
const correlation = (): Tool =>
  tool('correlation', [
    ['pause'],
    ['clear'],
    ['export-csv'],
    ['export-png', 'primary+I'],
    ['post-elog', 'primary+E'],
  ]);
const waveform = (): Tool =>
  tool('waveform', [
    ['pause'],
    ['snapshot'],
    ['export-csv'],
    ['export-png', 'primary+I'],
    ['post-elog', 'primary+E'],
  ]);

const TOOLS: [string, () => Tool][] = [
  ['trace', trace],
  ['correlation', correlation],
  ['waveform', waveform],
];

let postMessage: Mock<(message: unknown, targetOrigin: string) => void>;

beforeEach(() => {
  postMessage = vi.fn<(message: unknown, targetOrigin: string) => void>();
  // The parent frame the tool posts to under the host bar.
  vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(
  t: Tool,
  hostBar: boolean,
  onSaveView?: () => void
): { registry: ActionRegistry; unmount: () => void } {
  const registry = createActionRegistry();
  registry.set('canvas', t.actions);
  const { unmount } = renderHook(() => useActionShortcuts(registry, { hostBar, onSaveView }));
  return { registry, unmount };
}

function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const CTRL_S: KeyboardEventInit = { key: 's', code: 'KeyS', ctrlKey: true };

function expectNoHandlerFired(t: Tool): void {
  for (const [name, handler] of Object.entries(t.handlers)) {
    expect(handler, `${t.name}.${name}`).not.toHaveBeenCalled();
  }
}

describe.each(TOOLS)('under the host bar, %s: Ctrl+S is Save view', (_name, make) => {
  it('claims the key and posts exactly {type: "canopy:save-view"} to the parent, same-origin', () => {
    const t = make();
    mount(t, true);
    const event = press(CTRL_S);
    expect(event.defaultPrevented).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: SAVE_VIEW }, window.location.origin);
    expect(SAVE_VIEW).toBe('canopy:save-view');
    // Intercepted before the registry: no tool action runs (Trace's download included).
    expectNoHandlerFired(t);
  });

  it('is claimed from a form field too (typing never uses it)', () => {
    const t = make();
    mount(t, true);
    const input = document.createElement('input');
    document.body.appendChild(input);
    const event = press(CTRL_S, input);
    input.remove();
    expect(event.defaultPrevented).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('a held key (repeat) is claimed but posts once', () => {
    const t = make();
    mount(t, true);
    press(CTRL_S);
    const repeat = press({ ...CTRL_S, repeat: true });
    expect(repeat.defaultPrevented).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('Shift+Ctrl+S and Alt+S pass through untouched', () => {
    const t = make();
    mount(t, true);
    expect(press({ ...CTRL_S, shiftKey: true }).defaultPrevented).toBe(false);
    expect(press({ key: 's', code: 'KeyS', altKey: true }).defaultPrevented).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('an event already handled upstream is left alone', () => {
    const t = make();
    mount(t, true);
    const stopper = (e: Event) => e.preventDefault();
    window.addEventListener('keydown', stopper, { capture: true });
    press(CTRL_S);
    window.removeEventListener('keydown', stopper, { capture: true });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('calls onSaveView instead of posting when the workbench supplies one', () => {
    const t = make();
    const onSaveView = fn();
    mount(t, true, onSaveView);
    press(CTRL_S);
    expect(onSaveView).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('stops listening on unmount', () => {
    const t = make();
    const { unmount } = mount(t, true);
    unmount();
    expect(press(CTRL_S).defaultPrevented).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('standalone: no Save view branch', () => {
  it('Trace Ctrl+S still downloads the trace file and posts nothing', () => {
    const t = trace();
    mount(t, false);
    const event = press(CTRL_S);
    expect(event.defaultPrevented).toBe(true);
    expect(t.handlers.save).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['correlation', correlation],
    ['waveform', waveform],
  ])('%s leaves Ctrl+S to the browser, as before', (_name, make) => {
    const t = make();
    mount(t, false);
    const event = press(CTRL_S);
    expect(event.defaultPrevented).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
    expectNoHandlerFired(t);
  });
});

describe('matchesShortcut', () => {
  it('matches exactly the binding, with the shared modifier rules', () => {
    const ctrlS = {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    };
    expect(matchesShortcut(ctrlS, 'primary+S', false)).toBe(true);
    expect(matchesShortcut(ctrlS, 'primary+S', true)).toBe(false);
    expect(matchesShortcut({ ...ctrlS, ctrlKey: false, metaKey: true }, 'primary+S', true)).toBe(
      true
    );
    expect(matchesShortcut({ ...ctrlS, shiftKey: true }, 'primary+S', false)).toBe(false);
    expect(matchesShortcut(ctrlS, 'primary+P', false)).toBe(false);
    expect(matchesShortcut(ctrlS, 'nonsense', false)).toBe(false);
  });
});
