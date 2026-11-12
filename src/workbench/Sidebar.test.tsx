// @vitest-environment jsdom
//
// The Sidebar's arrangement: one pane titled Properties with a collapse
// button, the 32 px rail and its one expand target, the pane always mounted,
// the reveal request (no write), and every gesture writing the collapsed flag.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import {
  DEFAULT_ARRANGEMENT,
  type Arrangement,
  type ArrangementPatch,
  type ArrangementStore,
} from './arrangementStore';
import { SelectionProvider, createSelectionStore, type SelectionStore } from './selection';
import { SIDEBAR_TITLE, Sidebar } from './Sidebar';

// ---------------------------------------------------------------- harness --

interface FakeStore extends ArrangementStore {
  writes: ArrangementPatch[];
}

function fakeStore(initial: Partial<Arrangement> = {}): FakeStore {
  const writes: ArrangementPatch[] = [];
  return {
    key: 'test',
    initial: { ...DEFAULT_ARRANGEMENT, ...initial },
    writes,
    write: (patch) => writes.push(patch),
    flush: () => {},
    connect: () => () => {},
  };
}

/** A draft field, to prove the pane's state survives the rail. */
function Draft({ name }: { name: string }) {
  const [value, setValue] = useState('');
  return <input aria-label={name} value={value} onChange={(e) => setValue(e.target.value)} />;
}

function renderSidebar(store: FakeStore, extra: { selection?: SelectionStore } = {}) {
  const selection = extra.selection ?? createSelectionStore();
  const utils = render(
    <SelectionProvider store={selection}>
      <Sidebar store={store}>
        <Draft name="properties draft" />
      </Sidebar>
    </SelectionProvider>
  );
  return { ...utils, selection };
}

const pane = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('.wb-sidebar__pane[data-pane="properties"]')!;
const rail = (container: HTMLElement) => container.querySelector('.wb-sidebar__rail');
const collapseButton = () => screen.getByRole('button', { name: `Collapse ${SIDEBAR_TITLE}` });
const expandTarget = () => screen.getByRole('button', { name: `Expand ${SIDEBAR_TITLE}` });

afterEach(() => {
  cleanup();
});

// ------------------------------------------------------------------- pane --

describe('one pane', () => {
  it('has a header titled Properties with a collapse button, and no tabs', () => {
    const store = fakeStore();
    const { container } = renderSidebar(store);
    expect(SIDEBAR_TITLE).toBe('Properties');
    expect(screen.getByRole('heading', { name: 'Properties' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Properties' })).toBe(pane(container));
    expect(collapseButton()).toBeTruthy();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelectorAll('.wb-sidebar__pane')).toHaveLength(1);
    expect(pane(container).hidden).toBe(false);
    expect(rail(container)).toBeNull();
    expect(store.writes).toEqual([]);
  });
});

// --------------------------------------------------------------- collapse --

describe('collapse and expand', () => {
  it('the collapse button shows the 32 px rail and writes the collapsed flag once', () => {
    const store = fakeStore();
    const { container } = renderSidebar(store);
    fireEvent.click(collapseButton());
    expect(rail(container)).not.toBeNull();
    expect(container.querySelector('.wb-sidebar--collapsed')).not.toBeNull();
    expect(pane(container).hidden).toBe(true);
    expect(store.writes).toEqual([{ collapsed: true }]);
    const targets = container.querySelectorAll('.wb-sidebar__rail-target');
    expect([...targets].map((t) => t.getAttribute('aria-label'))).toEqual(['Expand Properties']);
  });

  it('the rail target expands the pane and writes the collapsed flag cleared', () => {
    const store = fakeStore({ collapsed: true });
    const { container } = renderSidebar(store);
    fireEvent.click(expandTarget());
    expect(rail(container)).toBeNull();
    expect(pane(container).hidden).toBe(false);
    expect(store.writes).toEqual([{ collapsed: false }]);
  });

  it('a stored collapsed arrangement opens on the rail, without writing', () => {
    const store = fakeStore({ collapsed: true });
    const { container } = renderSidebar(store);
    expect(rail(container)).not.toBeNull();
    expect(pane(container).hidden).toBe(true);
    expect(store.writes).toEqual([]);
  });

  it('keeps the pane content mounted behind the rail, so a draft survives', () => {
    renderSidebar(fakeStore());
    fireEvent.change(screen.getByLabelText('properties draft'), { target: { value: 'TEST:C01' } });
    fireEvent.click(collapseButton());
    expect(screen.getByLabelText('properties draft')).toBeTruthy();
    fireEvent.click(expandTarget());
    expect((screen.getByLabelText('properties draft') as HTMLInputElement).value).toBe('TEST:C01');
  });
});

// ----------------------------------------------------------------- reveal --

describe('reveal request', () => {
  it('a user selection expands the rail without writing', () => {
    const store = fakeStore({ collapsed: true });
    const { container, selection } = renderSidebar(store);
    act(() => selection.select({ level: 'section', kind: 's', id: 'a' }, 'user'));
    expect(rail(container)).toBeNull();
    expect(pane(container).hidden).toBe(false);
    expect(store.writes).toEqual([]);
  });

  it('an initial selection leaves the rail', () => {
    const store = fakeStore({ collapsed: true });
    const { container, selection } = renderSidebar(store);
    act(() => selection.select({ level: 'section', kind: 's', id: 'a' }, 'initial'));
    expect(rail(container)).not.toBeNull();
    expect(store.writes).toEqual([]);
  });

  it('a reset leaves the rail', () => {
    const store = fakeStore({ collapsed: true });
    const { container, selection } = renderSidebar(store);
    act(() => selection.reset());
    expect(rail(container)).not.toBeNull();
    expect(store.writes).toEqual([]);
  });
});
