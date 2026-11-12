// @vitest-environment jsdom
// `canopy:tool-invoke`: under the host bar, the host picks a reported entry
// and the workbench runs that registry action, only if it was in the last
// report and enabled there. Synthetic specs only; the hook holds no tool
// knowledge.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { Add } from '@carbon/icons-react';
import type { Action } from './types';
import { createActionRegistry, type ActionRegistry } from './useCanvasActions';
import { toolActions, type ToolActionSpec } from './standardActions';
import { TOOL_INVOKE, invocableIds, useToolInvoke } from './toolInvoke';

type Id = 'alpha' | 'beta' | 'gamma' | 'loose';
function makeHandlers() {
  return { alpha: vi.fn(), beta: vi.fn(), gamma: vi.fn(), loose: vi.fn() };
}
type Handlers = ReturnType<typeof makeHandlers>;
const SPECS: Record<Id, ToolActionSpec<Handlers>> = {
  alpha: { label: 'Alpha', icon: Add, iconName: 'Add', handler: 'alpha', menu: { order: 10 } },
  beta: { label: 'Beta', icon: Add, iconName: 'Add', handler: 'beta', menu: { order: 20 } },
  gamma: { label: 'Gamma', icon: Add, iconName: 'Add', handler: 'gamma', bar: { order: 10 } },
  // No placement: registered, never reported, so never invocable.
  loose: { label: 'Loose', icon: Add, iconName: 'Add', handler: 'loose' },
};
const IDS: Id[] = ['alpha', 'beta', 'gamma', 'loose'];

function build(
  handlers: Handlers,
  opts: { hidden?: Id[]; disabled?: Partial<Record<Id, string>> } = {}
): Action[] {
  return toolActions(IDS, SPECS, {
    embedded: true,
    bugUrl: 'https://example.org/bug',
    docsUrl: 'https://example.org/docs',
    handlers,
    hidden: (id) => opts.hidden?.includes(id) === true,
    disabled: opts.disabled,
  });
}

function Probe({ registry, hostBar }: { registry: ActionRegistry; hostBar?: boolean }) {
  useToolInvoke(registry, { hostBar });
  return null;
}

function send(
  data: unknown,
  init: { origin?: string; source?: MessageEventSource | null } = {}
): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        origin: init.origin ?? window.location.origin,
        source: init.source === undefined ? window.parent : init.source,
      })
    );
  });
}

function mount(handlers: Handlers, opts: Parameters<typeof build>[1] = {}, hostBar = true) {
  const registry = createActionRegistry();
  registry.set('canvas', build(handlers, opts));
  render(createElement(Probe, { registry, hostBar }));
  return registry;
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('invocableIds (pure)', () => {
  it('is every enabled reported entry, bar entries first', () => {
    const h = makeHandlers();
    expect([...invocableIds(build(h))]).toEqual(['gamma', 'alpha', 'beta']);
    expect([...invocableIds(build(h, { disabled: { gamma: 'Busy' } }))]).toEqual(['alpha', 'beta']);
    expect([...invocableIds(build(h, { hidden: ['beta'] }))]).toEqual(['gamma', 'alpha']);
  });
});

describe('useToolInvoke', () => {
  it('runs a published, enabled id', () => {
    const h = makeHandlers();
    mount(h);
    send({ type: TOOL_INVOKE, id: 'beta' });
    expect(h.beta).toHaveBeenCalledTimes(1);
    expect(h.alpha).not.toHaveBeenCalled();
  });

  it('follows registry changes: newly disabled is refused, re-enabled runs', () => {
    const h = makeHandlers();
    const registry = mount(h);
    act(() => registry.set('canvas', build(h, { disabled: { alpha: 'Busy' } })));
    send({ type: TOOL_INVOKE, id: 'alpha' });
    expect(h.alpha).not.toHaveBeenCalled();
    act(() => registry.set('canvas', build(h)));
    send({ type: TOOL_INVOKE, id: 'alpha' });
    expect(h.alpha).toHaveBeenCalledTimes(1);
  });

  it('ignores a disabled id', () => {
    const h = makeHandlers();
    mount(h, { disabled: { alpha: 'No data' } });
    send({ type: TOOL_INVOKE, id: 'alpha' });
    expect(h.alpha).not.toHaveBeenCalled();
  });

  it('ignores an unknown id', () => {
    const h = makeHandlers();
    mount(h);
    send({ type: TOOL_INVOKE, id: 'nope' });
    expect(Object.values(h).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it('runs a bar entry', () => {
    const h = makeHandlers();
    mount(h);
    send({ type: TOOL_INVOKE, id: 'gamma' });
    expect(h.gamma).toHaveBeenCalledTimes(1);
  });

  it('ignores an unplaced (never reported) id', () => {
    const h = makeHandlers();
    mount(h);
    send({ type: TOOL_INVOKE, id: 'loose' });
    expect(h.loose).not.toHaveBeenCalled();
  });

  it('ignores a hidden id', () => {
    const h = makeHandlers();
    mount(h, { hidden: ['beta'] });
    send({ type: TOOL_INVOKE, id: 'beta' });
    expect(h.beta).not.toHaveBeenCalled();
  });

  it('ignores a foreign source', () => {
    const h = makeHandlers();
    mount(h);
    const other = { postMessage: () => {} } as unknown as MessageEventSource;
    send({ type: TOOL_INVOKE, id: 'beta' }, { source: other });
    send({ type: TOOL_INVOKE, id: 'beta' }, { source: null });
    expect(h.beta).not.toHaveBeenCalled();
  });

  it('ignores a foreign origin', () => {
    const h = makeHandlers();
    mount(h);
    send({ type: TOOL_INVOKE, id: 'beta' }, { origin: 'https://evil.example' });
    expect(h.beta).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong type', { type: 'canopy:tool-actions', id: 'beta' }],
    ['non-string id', { type: TOOL_INVOKE, id: 1 }],
    ['no id', { type: TOOL_INVOKE }],
    ['a string', 'canopy:tool-invoke'],
    ['null', null],
  ])('ignores a malformed message: %s', (_name, data) => {
    const h = makeHandlers();
    mount(h);
    send(data);
    expect(h.beta).not.toHaveBeenCalled();
  });

  it('listens only under the host bar', () => {
    const h = makeHandlers();
    mount(h, {}, false);
    send({ type: TOOL_INVOKE, id: 'beta' });
    expect(h.beta).not.toHaveBeenCalled();
  });

  it('reads the host bar from the URL when not given', () => {
    window.history.replaceState(null, '', '/x/trace/trace.html?embedded=true&hostbar=1');
    const h = makeHandlers();
    const registry = createActionRegistry();
    registry.set('canvas', build(h));
    render(createElement(Probe, { registry }));
    send({ type: TOOL_INVOKE, id: 'alpha' });
    expect(h.alpha).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an unknown flag', '?embedded=true&other=1'],
    ['embedded=true alone', '?embedded=true'],
  ])('%s: does not listen', (_mode, search) => {
    window.history.replaceState(null, '', `/x/trace/trace.html${search}`);
    const h = makeHandlers();
    const registry = createActionRegistry();
    registry.set('canvas', build(h));
    render(createElement(Probe, { registry }));
    send({ type: TOOL_INVOKE, id: 'alpha' });
    expect(h.alpha).not.toHaveBeenCalled();
  });

  it('stops listening on unmount', () => {
    const h = makeHandlers();
    mount(h);
    cleanup();
    send({ type: TOOL_INVOKE, id: 'beta' });
    expect(h.beta).not.toHaveBeenCalled();
  });
});
