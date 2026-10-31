// @vitest-environment jsdom
//
// The card head's lock slot: a toggle field with
// `row: 'lock'` renders as a glyph button after the eye, only for cards whose
// item schema declares one; clicking it writes the field through its setter,
// the card re-renders (the lock signature is part of the memoized card's
// signature) so the control's pressed state flips, the click neither selects
// nor opens the card, and other cards are left as they were.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import {
  createStubTool,
  lockField,
  stubSchema,
  type StubModel,
  type StubState,
  type StubTool,
  type StubUi,
} from './__fixtures__/stubTool';
import { Outline } from './Outline';
import { SelectionProvider, createSelectionStore, type SelectionStore } from './selection';
import type { ToolDefinition } from './types';

type StubDefinition = ToolDefinition<StubState, StubModel, StubUi>;

function Harness({ tool, definition }: { tool: StubTool; definition: StubDefinition }) {
  const state = useSyncExternalStore(tool.subscribe, () => tool.getState());
  const model = useSyncExternalStore(tool.subscribe, () => tool.getModel());
  return (
    <Outline
      definition={definition}
      state={state}
      model={model}
      ui={tool.getUi()}
      update={tool.update}
      capabilities={tool.capabilities}
      catalog={[]}
    />
  );
}

function mount(definition?: (tool: StubTool) => StubDefinition) {
  const tool = createStubTool();
  const store: SelectionStore = createSelectionStore();
  render(
    <SelectionProvider store={store}>
      <Harness tool={tool} definition={definition?.(tool) ?? tool.definition} />
    </SelectionProvider>
  );
  return { tool, store };
}

const rowEl = (id: string) => document.querySelector(`[data-row-id="${id}"]`) as HTMLElement;
const lockOf = (id: string) =>
  rowEl(id).querySelector('.wb-outline-row__lock button') as HTMLButtonElement | null;
const pinnedOf = (tool: StubTool, id: string) =>
  tool.getState().items.find((i) => i.id === id)?.pinned;

/** The stub definition with the item kind's lock field removed from every tab. */
function withoutLock(tool: StubTool): StubDefinition {
  const items = stubSchema.items.signal!;
  return {
    ...tool.definition,
    schema: {
      ...tool.definition.schema,
      items: {
        signal: {
          ...items,
          tabs: items.tabs.map((t) => ({
            ...t,
            fields: t.fields.filter((f) => f !== lockField),
          })),
        },
      },
    },
  };
}

afterEach(cleanup);

describe('Outline row lock slot', () => {
  it('renders a lock glyph after the eye when the item schema declares one', () => {
    mount();
    const row = rowEl('a');
    const lock = lockOf('a');
    expect(lock).not.toBeNull();
    expect(lock!.getAttribute('aria-pressed')).toBe('false');
    expect(lock!.querySelector('svg')).not.toBeNull();
    const slots = Array.from(row.querySelectorAll('.wb-outline-row__slot'));
    const eyeIndex = slots.findIndex((s) => s.classList.contains('wb-outline-row__eye'));
    const lockIndex = slots.findIndex((s) => s.classList.contains('wb-outline-row__lock'));
    expect(eyeIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBe(eyeIndex + 1);
    // Before the remove button.
    const remove = row.querySelector('.wb-outline-row__remove')!;
    expect(
      slots[lockIndex]!.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('renders no lock slot when the schema does not declare one', () => {
    mount(withoutLock);
    expect(rowEl('a').querySelector('.wb-outline-row__lock')).toBeNull();
    // The eye is still there.
    expect(rowEl('a').querySelector('.wb-outline-row__eye')).not.toBeNull();
  });

  it('clicking toggles the field and flips the rendered pressed state', () => {
    const { tool, store } = mount();
    expect(pinnedOf(tool, 'a')).toBe(false);
    fireEvent.click(lockOf('a')!);
    expect(pinnedOf(tool, 'a')).toBe(true);
    expect(lockOf('a')!.getAttribute('aria-pressed')).toBe('true');
    expect(rowEl('a').querySelector('.wb-outline-row__lock--on')).not.toBeNull();
    // A slot click neither selects nor opens the card.
    expect(store.get().selection).toBeNull();
    expect(document.querySelector('.wb-card__body')).toBeNull();
    fireEvent.click(lockOf('a')!);
    expect(pinnedOf(tool, 'a')).toBe(false);
    expect(lockOf('a')!.getAttribute('aria-pressed')).toBe('false');
    expect(rowEl('a').querySelector('.wb-outline-row__lock--on')).toBeNull();
  });

  it('leaves other rows unchanged', () => {
    const { tool } = mount();
    fireEvent.click(lockOf('a')!);
    expect(pinnedOf(tool, 'b')).toBe(false);
    expect(pinnedOf(tool, 'c')).toBe(false);
    expect(lockOf('b')!.getAttribute('aria-pressed')).toBe('false');
    expect(lockOf('c')!.getAttribute('aria-pressed')).toBe('false');
  });
});
