// @vitest-environment jsdom
// `canopy:tool-actions`: under the host bar, the workbench reports the tool's
// placed actions (bar entries, then menu entries) and its docs / bug links to
// the parent on mount and on every registry change. Synthetic specs only: the
// publisher holds no tool knowledge.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { Add } from '@carbon/icons-react';
import type { Action } from './types';
import { createActionRegistry, type ActionRegistry } from './useCanvasActions';
import { standardActions, toolActions, type ToolActionSpec } from './standardActions';
import {
  TOOL_ACTIONS,
  toolActionsPayload,
  useToolActionsPublisher,
  type ToolActionsMessage,
} from './toolActionsPublisher';

const BUG = 'https://example.org/bug';
const DOCS = 'https://example.org/docs';

type Id = 'alpha' | 'beta' | 'gamma' | 'delta' | 'mode' | 'loose';
const handlers = { run: () => {} };
const SPECS: Record<Id, ToolActionSpec<typeof handlers>> = {
  alpha: {
    label: 'Alpha',
    icon: Add,
    iconName: 'Add',
    handler: 'run',
    menu: { order: 30 },
    bar: { order: 10 },
  },
  beta: {
    label: 'Beta',
    icon: Add,
    iconName: 'Add',
    handler: 'run',
    shortcut: 'primary+O',
    menu: { order: 10, label: 'Beta…' },
  },
  gamma: { label: 'Gamma', icon: Add, iconName: 'Add', handler: 'run', bar: { order: 20 } },
  delta: { label: 'Delta', icon: Add, iconName: 'Add', handler: 'run', menu: { order: 20 } },
  mode: {
    label: 'Mode',
    icon: Add,
    iconName: 'Add',
    kind: 'toggle',
    handler: 'run',
    menu: { order: 40 },
  },
  // No placement: registered, never reported.
  loose: { label: 'Loose', icon: Add, iconName: 'Add', handler: 'run' },
};
const IDS: Id[] = ['alpha', 'beta', 'gamma', 'delta', 'mode', 'loose'];

function build(
  opts: { hidden?: Id[]; disabled?: Partial<Record<Id, string>>; pressed?: boolean } = {}
): Action[] {
  return toolActions(IDS, SPECS, {
    embedded: true,
    bugUrl: BUG,
    docsUrl: DOCS,
    handlers,
    hidden: (id) => opts.hidden?.includes(id) === true,
    disabled: opts.disabled,
    pressed: opts.pressed,
  });
}

describe('Action.menu / Action.href', () => {
  it('toolActions copies the spec menu onto the action', () => {
    const actions = build();
    expect(actions.find((a) => a.id === 'beta')?.menu).toEqual({ order: 10, label: 'Beta…' });
    expect(actions.find((a) => a.id === 'gamma')?.menu).toBeUndefined();
  });

  it('the standard docs / report-bug actions carry their URLs as href', () => {
    const actions = standardActions({ embedded: true, bugUrl: BUG, docsUrl: DOCS });
    expect(actions.find((a) => a.id === 'docs')?.href).toBe(DOCS);
    expect(actions.find((a) => a.id === 'report-bug')?.href).toBe(BUG);
    expect(build().find((a) => a.id === 'docs')?.href).toBe(DOCS);
  });
});

describe('toolActionsPayload (pure)', () => {
  it('reports bar entries first in bar order, then menu entries, with placement and icon', () => {
    const payload = toolActionsPayload(build({ pressed: true }));
    expect(payload).toEqual({
      type: TOOL_ACTIONS,
      version: 1,
      actions: [
        { id: 'alpha', label: 'Alpha', kind: 'button', icon: 'Add', placement: 'bar' },
        { id: 'gamma', label: 'Gamma', kind: 'button', icon: 'Add', placement: 'bar' },
        {
          id: 'beta',
          label: 'Beta…',
          kind: 'button',
          shortcut: 'primary+O',
          icon: 'Add',
          placement: 'menu',
        },
        { id: 'delta', label: 'Delta', kind: 'button', icon: 'Add', placement: 'menu' },
        {
          id: 'mode',
          label: 'Mode',
          kind: 'toggle',
          pressed: true,
          icon: 'Add',
          placement: 'menu',
        },
      ],
      links: { docs: DOCS, bug: BUG },
    });
    for (const a of payload.actions) {
      expect(Object.keys(a)).not.toContain('onClick');
      expect(Object.keys(a)).not.toContain('menu');
      expect(Object.keys(a)).not.toContain('bar');
    }
  });

  it('omits hidden and unplaced actions and keeps disabled ones with their reason', () => {
    const payload = toolActionsPayload(
      build({ hidden: ['delta'], disabled: { alpha: 'No data' } })
    );
    expect(payload.actions.map((a) => a.id)).toEqual(['alpha', 'gamma', 'beta', 'mode']);
    expect(payload.actions.find((a) => a.id === 'alpha')?.disabled).toBe('No data');
  });

  it('leaves out an icon name that is not a component name', () => {
    const odd: Action = {
      id: 'x',
      label: 'X',
      icon: Add,
      iconName: 'not-a-component',
      kind: 'button',
      bar: { order: 1 },
      onClick: () => {},
    };
    expect(toolActionsPayload([odd]).actions).toEqual([
      { id: 'x', label: 'X', kind: 'button', placement: 'bar' },
    ]);
  });

  it('carries state when given, and empty links when no href exists', () => {
    const plain: Action = {
      id: 'x',
      label: 'X',
      icon: Add,
      iconName: 'Add',
      kind: 'button',
      onClick: () => {},
    };
    expect(toolActionsPayload([plain], 'live')).toEqual({
      type: TOOL_ACTIONS,
      version: 1,
      state: 'live',
      actions: [],
      links: {},
    });
  });
});

describe('useToolActionsPublisher', () => {
  let posted: ToolActionsMessage[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    posted = [];
    spy = vi.spyOn(window.parent, 'postMessage').mockImplementation(((
      message: unknown,
      origin: unknown
    ) => {
      expect(origin).toBe(window.location.origin);
      posted.push(message as ToolActionsMessage);
    }) as typeof window.postMessage);
  });
  afterEach(() => {
    cleanup();
    spy.mockRestore();
    window.history.replaceState(null, '', '/');
  });

  function Probe({ registry, state }: { registry: ActionRegistry; state?: string }) {
    useToolActionsPublisher(registry, { state });
    return null;
  }

  function hostBar(): void {
    window.history.replaceState(null, '', '/x/trace/trace.html?embedded=true&hostbar=1');
  }

  it('posts the report on mount with state and links', () => {
    hostBar();
    const registry = createActionRegistry();
    registry.set('canvas', build());
    render(createElement(Probe, { registry, state: '2 curves · live' }));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual(toolActionsPayload(build(), '2 curves · live'));
  });

  it('re-posts the whole list on every registry change', () => {
    hostBar();
    const registry = createActionRegistry();
    registry.set('canvas', build());
    render(createElement(Probe, { registry }));
    act(() => registry.set('canvas', build({ disabled: { beta: 'Busy' } })));
    expect(posted).toHaveLength(2);
    expect(posted[1].actions.map((a) => a.id)).toEqual(['alpha', 'gamma', 'beta', 'delta', 'mode']);
    expect(posted[1].actions[2].disabled).toBe('Busy');
    act(() => registry.set('canvas', build({ hidden: ['alpha'], disabled: { beta: 'Busy' } })));
    expect(posted).toHaveLength(3);
    expect(posted[2].actions.map((a) => a.id)).toEqual(['gamma', 'beta', 'delta', 'mode']);
  });

  it('re-posts when the state changes', () => {
    hostBar();
    const registry = createActionRegistry();
    registry.set('canvas', build());
    const { rerender } = render(createElement(Probe, { registry, state: 'live' }));
    rerender(createElement(Probe, { registry, state: 'paused' }));
    expect(posted.map((m) => m.state)).toEqual(['live', 'paused']);
  });

  it.each([
    ['standalone', '/'],
    ['embedded=true alone', '/x/trace/trace.html?embedded=true'],
    ['hostbar=1 without embedded=true', '/x/trace/trace.html?hostbar=1'],
    ['an unknown flag', '/x/trace/trace.html?embedded=true&other=1'],
  ])('%s: posts nothing', (_mode, url) => {
    window.history.replaceState(null, '', url);
    const registry = createActionRegistry();
    registry.set('canvas', build());
    render(createElement(Probe, { registry, state: 'live' }));
    act(() => registry.set('canvas', build({ hidden: ['alpha'] })));
    expect(posted).toHaveLength(0);
  });
});
