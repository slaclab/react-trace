// @vitest-environment jsdom
//
// The `pv` field renderer. Downshift answers Escape on a
// closed ComboBox by clearing the input before any bubbling handler runs, so
// the renderer takes Escape in the capture phase:
// - with a draft, Escape reverts the text to the committed PV and goes no
//   further (an ancestor's keydown never sees it);
// - on a clean field, Escape keeps the committed PV visible and goes on up.
// The PV commits on Enter through the field's `set`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import {
  createStubTool,
  referenceField,
  tool as toolTarget,
  type StubModel,
  type StubState,
  type StubTool,
  type StubUi,
} from '../__fixtures__/stubTool';
import type { FieldDef } from '../types';
import { Field } from './Field';

const COMMITTED = 'TEST:REF:PV';
const field = {
  ...referenceField,
  search: vi.fn(async () => [] as string[]),
} as FieldDef<StubState, StubModel, StubUi>;

function Harness({ stub }: { stub: StubTool }) {
  useSyncExternalStore(stub.subscribe, stub.getState);
  return <Field field={field} ctx={stub.ctx(toolTarget)} />;
}

function mount(reference = COMMITTED) {
  const stub = createStubTool({ state: { reference } });
  const ancestorKeyDown = vi.fn();
  render(
    <div onKeyDown={(e) => ancestorKeyDown(e.key)}>
      <Harness stub={stub} />
    </div>
  );
  const input = () => document.querySelector<HTMLInputElement>('#stub-reference')!;
  return { stub, ancestorKeyDown, input };
}

async function settle(ms = 300) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {}))
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pv field', () => {
  it('carries the #id on the input and shows the committed PV', () => {
    const { input } = mount();
    expect(input().tagName).toBe('INPUT');
    expect(input().value).toBe(COMMITTED);
    expect(screen.getByRole('combobox', { name: 'Reference PV' })).toBe(input());
  });

  it('commits the typed PV on Enter through set', async () => {
    const { stub, input } = mount('');
    fireEvent.change(input(), { target: { value: 'TEST:NEW:PV' } });
    await settle();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(stub.getState().reference).toBe('TEST:NEW:PV');
  });

  it('Escape with a draft reverts it and stops there', async () => {
    const { stub, input, ancestorKeyDown } = mount();
    fireEvent.change(input(), { target: { value: 'TEST:HALF' } });
    await settle();
    expect(input().value).toBe('TEST:HALF');
    fireEvent.keyDown(input(), { key: 'Escape' });
    await settle(0);
    expect(input().value).toBe(COMMITTED);
    expect(stub.getState().reference).toBe(COMMITTED);
    expect(ancestorKeyDown).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input());
  });

  it('Escape on a clean field keeps the PV and goes on up', async () => {
    const { stub, input, ancestorKeyDown } = mount();
    fireEvent.keyDown(input(), { key: 'Escape' });
    await settle(0);
    expect(input().value).toBe(COMMITTED);
    expect(stub.getState().reference).toBe(COMMITTED);
    expect(ancestorKeyDown).toHaveBeenCalledWith('Escape');
  });

  it('a second Escape after a revert goes on up', async () => {
    const { input, ancestorKeyDown } = mount();
    fireEvent.change(input(), { target: { value: 'TEST:HALF' } });
    await settle();
    fireEvent.keyDown(input(), { key: 'Escape' });
    await settle(0);
    expect(ancestorKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(ancestorKeyDown).toHaveBeenCalledWith('Escape');
    expect(input().value).toBe(COMMITTED);
  });
});
