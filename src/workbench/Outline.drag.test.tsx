// @vitest-environment jsdom
//
// Card drag between Outline sections against the stub tool. The Outline owns its own `DndContext` for card
// drags; before a drop is offered it asks the tool's `moveRefusal(item,
// target)`, a refused target shows a "no drop" state with the reason, and a
// drop there never calls `ops.move`. An allowed drop calls `ops.move` once.
//
// The reason is queried by its class, not by role: a section's read-only
// settings field renders as an <output>, whose implicit role is status too.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import {
  STUB_FULL_REFUSAL,
  STUB_LOCKED_REFUSAL,
  createStubTool,
  stubInitialState,
  stubItem,
  type StubTool,
  type StubToolOptions,
} from './__fixtures__/stubTool';
import { Outline } from './Outline';
import { SelectionProvider, createSelectionStore, type SelectionStore } from './selection';

// ---------------------------------------------------------------- harness --

function Harness({ tool }: { tool: StubTool }) {
  const state = useSyncExternalStore(tool.subscribe, () => tool.getState());
  const model = useSyncExternalStore(tool.subscribe, () => tool.getModel());
  return (
    <Outline
      definition={tool.definition}
      state={state}
      model={model}
      ui={tool.getUi()}
      update={tool.update}
      capabilities={tool.capabilities}
      catalog={[]}
    />
  );
}

function mount(options: StubToolOptions = {}, store: SelectionStore = createSelectionStore()) {
  const tool = createStubTool(options);
  render(
    <SelectionProvider store={store}>
      <Harness tool={tool} />
    </SelectionProvider>
  );
  return { tool, store };
}

const sectionEl = (id: string) =>
  document.querySelector(`[data-section-id="${id}"]`) as HTMLElement;
const rowEl = (id: string) => document.querySelector(`[data-row-id="${id}"]`) as HTMLElement;
/** The section's "no drop" reason, or null. */
const refusalIn = (id: string) =>
  sectionEl(id).querySelector<HTMLElement>('p.wb-outline-section__no-drop');
const sectionOf = (tool: StubTool, itemId: string) =>
  tool.getState().items.find((i) => i.id === itemId)?.section;

// --- geometry for @dnd-kit in jsdom: Signals on top (y 0..100), Locked below
// (y 100..200); card heads 30 px tall inside their section.
const SIGNALS = { x: 150, y: 50 };
const LOCKED = { x: 150, y: 150 };
const OUTSIDE = { x: 150, y: 400 };

function box(x: number, y: number, w: number, h: number): DOMRect {
  return {
    x,
    y,
    left: x,
    top: y,
    width: w,
    height: h,
    right: x + w,
    bottom: y + h,
    toJSON() {},
  } as DOMRect;
}

function rectOf(el: Element): DOMRect | null {
  if (el.matches?.('[data-section-id="signals"]')) return box(0, 0, 300, 100);
  if (el.matches?.('[data-section-id="locked"]')) return box(0, 100, 300, 100);
  if (el.matches?.('[data-row-id]')) {
    const card = el.closest('[data-card-id]')!;
    const section = card.closest('[data-section-id]');
    const top = section?.getAttribute('data-section-id') === 'locked' ? 100 : 0;
    const index = Array.from(card.parentElement?.children ?? []).indexOf(card);
    return box(0, top + 30 + index * 30, 300, 30);
  }
  return null;
}

beforeEach(() => {
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rectOf(this) ?? original.call(this);
  });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  // @dnd-kit keeps a capturing document `click` swallower for 50 ms after a
  // drag ends; let it go so it cannot eat the next test's clicks.
  await new Promise((resolve) => setTimeout(resolve, 60));
});

const pointer = (x: number, y: number) => ({
  clientX: x,
  clientY: y,
  isPrimary: true,
  button: 0,
  pointerId: 1,
});

/** Press on the card head and move past the activation distance. */
function startDrag(id: string) {
  const r = rowEl(id).getBoundingClientRect();
  const x = r.left + 100;
  const y = r.top + 15;
  fireEvent.pointerDown(rowEl(id), pointer(x, y));
  act(() => {
    fireEvent.pointerMove(document, pointer(x, y + 3));
  });
  act(() => {
    fireEvent.pointerMove(document, pointer(x, y + 10));
  });
}
function moveTo(at: { x: number; y: number }) {
  act(() => {
    fireEvent.pointerMove(document, pointer(at.x, at.y));
  });
}
function drop(at: { x: number; y: number }) {
  act(() => {
    fireEvent.pointerUp(document, pointer(at.x, at.y));
  });
}

/** Signals at capacity (three items) with `c` still in Locked. */
function fullSignals(): StubToolOptions {
  const initial = stubInitialState();
  return {
    state: {
      items: [...initial.items, stubItem('d', 'STUB:D', 3)],
    },
  };
}

// ---------------------------------------------------------------- allowed --

describe('an allowed move', () => {
  it('calls ops.move once and the item lands in the target section', () => {
    const { tool } = mount();
    startDrag('c');
    moveTo(SIGNALS);
    expect(sectionEl('signals').classList.contains('wb-outline-section--no-drop')).toBe(false);
    expect(sectionEl('signals').classList.contains('wb-outline-section--drop')).toBe(true);
    drop(SIGNALS);
    expect(tool.calls.move).toEqual([{ itemId: 'c', sectionId: 'signals' }]);
    expect(sectionOf(tool, 'c')).toBe('signals');
    expect(refusalIn('signals')).toBeNull();
  });

  it('marks the card being dragged and clears the mark after the drop', () => {
    mount();
    startDrag('c');
    expect(rowEl('c').classList.contains('wb-outline-row--dragging')).toBe(true);
    expect(rowEl('c').closest('.wb-card')!.classList.contains('wb-card--dragging')).toBe(true);
    moveTo(SIGNALS);
    drop(SIGNALS);
    expect(rowEl('c').classList.contains('wb-outline-row--dragging')).toBe(false);
    expect(rowEl('c').closest('.wb-card')!.classList.contains('wb-card--dragging')).toBe(false);
  });

  it('a drop back on its own section moves nothing', () => {
    const { tool } = mount();
    startDrag('a');
    moveTo(SIGNALS);
    expect(sectionEl('signals').classList.contains('wb-outline-section--no-drop')).toBe(false);
    drop(SIGNALS);
    expect(tool.calls.move).toEqual([]);
    expect(sectionOf(tool, 'a')).toBe('signals');
  });

  it('a drop outside every section moves nothing', () => {
    const { tool } = mount();
    startDrag('c');
    moveTo(OUTSIDE);
    drop(OUTSIDE);
    expect(tool.calls.move).toEqual([]);
  });
});

// ---------------------------------------------------------------- refused --

describe('a refused move', () => {
  it('a drag over the refusing section shows the reason and moves nothing', () => {
    const { tool } = mount();
    startDrag('a');
    moveTo(LOCKED);
    const locked = sectionEl('locked');
    expect(locked.classList.contains('wb-outline-section--no-drop')).toBe(true);
    expect(refusalIn('locked')!.textContent).toBe(STUB_LOCKED_REFUSAL);
    drop(LOCKED);
    expect(tool.calls.move).toEqual([]);
    expect(sectionOf(tool, 'a')).toBe('signals');
    // The no-drop state ends with the drag.
    expect(locked.classList.contains('wb-outline-section--no-drop')).toBe(false);
    expect(refusalIn('locked')).toBeNull();
  });

  it('a full section refuses with its capacity text', () => {
    const { tool } = mount(fullSignals());
    startDrag('c');
    moveTo(SIGNALS);
    const signals = sectionEl('signals');
    expect(signals.classList.contains('wb-outline-section--no-drop')).toBe(true);
    expect(refusalIn('signals')!.textContent).toBe(STUB_FULL_REFUSAL);
    drop(SIGNALS);
    expect(tool.calls.move).toEqual([]);
    expect(sectionOf(tool, 'c')).toBe('locked');
  });

  it('the reason follows the pointer: leaving the refusing section clears it', () => {
    mount();
    startDrag('a');
    moveTo(LOCKED);
    expect(refusalIn('locked')!.textContent).toBe(STUB_LOCKED_REFUSAL);
    moveTo(SIGNALS);
    expect(refusalIn('locked')).toBeNull();
    expect(sectionEl('locked').classList.contains('wb-outline-section--no-drop')).toBe(false);
    drop(SIGNALS);
  });

  it('asks the tool rule with the dragged item and the target section', () => {
    const { tool } = mount();
    const spy = vi.spyOn(tool.definition.binding, 'moveRefusal');
    startDrag('b');
    moveTo(LOCKED);
    expect(spy).toHaveBeenCalledWith('b', 'locked');
    drop(LOCKED);
  });
});

// ------------------------------------------------------------- click intact --

describe('card clicks', () => {
  it('a plain click still opens the card (no drag below the activation distance)', () => {
    const { tool, store } = mount();
    fireEvent.click(rowEl('a'));
    expect(store.get().selection).toMatchObject({ level: 'item', id: 'a' });
    expect(rowEl('a').closest('.wb-card')!.classList.contains('wb-card--open')).toBe(true);
    expect(tool.calls.move).toEqual([]);
  });
});
