// @vitest-environment jsdom
//
// Card drops outside the Outline (R6): with `ops.drop` on the binding, an
// element marked `[data-workbench-drop]` (a plot's tab or grid cell in Trace)
// is a target while no section is under the pointer. It is marked
// allowed/refused while hovered, `dropRefusal` is asked as for a section, an
// allowed drop calls `ops.drop` once and is announced by the target's label,
// and a drop outside every section and target moves nothing. A tool without
// `ops.drop` (Correlation, Waveform, the stub) ignores such elements.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { createStubTool, type StubTool } from './__fixtures__/stubTool';
import { Outline } from './Outline';
import { DROP_LABEL_ATTR, DROP_STATE_ATTR, DROP_TARGET_ATTR } from './dropTarget';
import { SelectionProvider, createSelectionStore } from './selection';
import type { ToolDefinition } from './types';

type Def = StubTool['definition'];

const REFUSED = 'That target does not take it.';

function Harness({ tool, definition }: { tool: StubTool; definition: Def }) {
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

/** The stub tool, with `ops.drop` and `dropRefusal` when `withDrop`. */
function mount(withDrop: boolean) {
  const tool = createStubTool();
  const drops: { itemId: string; targetId: string }[] = [];
  const base = tool.definition;
  const definition: Def = withDrop
    ? ({
        ...base,
        binding: {
          ...base.binding,
          ops: {
            ...base.binding.ops,
            drop: (itemId, targetId) => drops.push({ itemId, targetId }),
          },
          dropRefusal: (_itemId, targetId) => (targetId === 'p3' ? REFUSED : null),
        },
      } satisfies ToolDefinition<unknown, unknown> as Def)
    : base;
  render(
    <>
      <SelectionProvider store={createSelectionStore()}>
        <Harness tool={tool} definition={definition} />
      </SelectionProvider>
      <div data-testid="tab-p2" {...{ [DROP_TARGET_ATTR]: 'p2', [DROP_LABEL_ATTR]: 'Plot 2' }} />
      <div data-testid="tab-p3" {...{ [DROP_TARGET_ATTR]: 'p3', [DROP_LABEL_ATTR]: 'Plot 3' }} />
    </>
  );
  return { tool, drops };
}

// Geometry: Signals y 0..100, Locked y 100..200 (cards 30 px), the two
// outside targets side by side at y 500..540.
const P2 = { x: 450, y: 520 };
const P3 = { x: 650, y: 520 };
const NOWHERE = { x: 150, y: 400 };

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
  if (el.matches?.('[data-testid="tab-p2"]')) return box(400, 500, 100, 40);
  if (el.matches?.('[data-testid="tab-p3"]')) return box(600, 500, 100, 40);
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
  // @dnd-kit swallows the next click for 50 ms after a drag.
  await new Promise((resolve) => setTimeout(resolve, 60));
});

const rowEl = (id: string) => document.querySelector(`[data-row-id="${id}"]`) as HTMLElement;
const target = (id: string) => document.querySelector(`[data-testid="tab-${id}"]`) as HTMLElement;
const polite = () => document.querySelector('.wb-outline [aria-live="polite"]');
const pointer = (x: number, y: number) => ({
  clientX: x,
  clientY: y,
  isPrimary: true,
  button: 0,
  pointerId: 1,
});

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

describe('dropping a card outside the Outline', () => {
  it('marks the hovered target and calls ops.drop once on an allowed drop', () => {
    const { tool, drops } = mount(true);
    startDrag('a');
    moveTo(P2);
    expect(target('p2').getAttribute(DROP_STATE_ATTR)).toBe('allowed');
    expect(polite()?.textContent).toBe('STUB:A is over Plot 2.');
    drop(P2);
    expect(drops).toEqual([{ itemId: 'a', targetId: 'p2' }]);
    expect(tool.calls.move).toEqual([]);
    expect(target('p2').hasAttribute(DROP_STATE_ATTR)).toBe(false);
    expect(polite()?.textContent).toBe('STUB:A moved to Plot 2.');
  });

  it('a refusing target shows the reason and a drop there calls nothing', () => {
    const { drops } = mount(true);
    startDrag('a');
    moveTo(P3);
    expect(target('p3').getAttribute(DROP_STATE_ATTR)).toBe('refused');
    expect(target('p3').getAttribute('title')).toBe(REFUSED);
    expect(polite()?.textContent).toBe(`STUB:A cannot go to Plot 3: ${REFUSED}`);
    drop(P3);
    expect(drops).toEqual([]);
    expect(target('p3').hasAttribute(DROP_STATE_ATTR)).toBe(false);
    expect(target('p3').hasAttribute('title')).toBe(false);
    expect(polite()?.textContent).toBe(`STUB:A not moved: ${REFUSED}`);
  });

  it('moving off a target clears its mark; a drop outside everything moves nothing', () => {
    const { tool, drops } = mount(true);
    startDrag('a');
    moveTo(P2);
    moveTo(NOWHERE);
    expect(target('p2').hasAttribute(DROP_STATE_ATTR)).toBe(false);
    drop(NOWHERE);
    expect(drops).toEqual([]);
    expect(tool.calls.move).toEqual([]);
    expect(polite()?.textContent).toBe('STUB:A not moved.');
  });

  it('a section under the pointer still takes the drop as before', () => {
    const { tool, drops } = mount(true);
    startDrag('c');
    moveTo({ x: 150, y: 50 });
    drop({ x: 150, y: 50 });
    expect(tool.calls.move).toEqual([{ itemId: 'c', sectionId: 'signals' }]);
    expect(drops).toEqual([]);
  });

  it('a tool without ops.drop ignores the targets', () => {
    const { tool } = mount(false);
    startDrag('a');
    moveTo(P2);
    expect(target('p2').hasAttribute(DROP_STATE_ATTR)).toBe(false);
    drop(P2);
    expect(tool.calls.move).toEqual([]);
    expect(polite()?.textContent).toBe('STUB:A not moved.');
  });

  it('a target clipped away at the point (not in its stack) is no target', () => {
    const { drops } = mount(true);
    // What shows at the point is something else: the target is scrolled out
    // of view under it, though its rect still holds the point.
    const cover = document.createElement('div');
    document.body.appendChild(cover);
    const original = document.elementsFromPoint;
    document.elementsFromPoint = () => [cover, document.body];
    try {
      startDrag('a');
      moveTo(P2);
      expect(target('p2').hasAttribute(DROP_STATE_ATTR)).toBe(false);
      drop(P2);
      expect(drops).toEqual([]);
    } finally {
      document.elementsFromPoint = original;
      cover.remove();
    }
  });

  it('a target that shows at the point takes the drop', () => {
    const { drops } = mount(true);
    const original = document.elementsFromPoint;
    document.elementsFromPoint = () => [target('p2'), document.body];
    try {
      startDrag('a');
      moveTo(P2);
      expect(target('p2').getAttribute(DROP_STATE_ATTR)).toBe('allowed');
      drop(P2);
      expect(drops).toEqual([{ itemId: 'a', targetId: 'p2' }]);
    } finally {
      document.elementsFromPoint = original;
    }
  });
});
