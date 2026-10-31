// @vitest-environment jsdom
//
// A section's add row against the stub tool: a pick adds, Enter adds, click-away keeps the typed text
// and adds nothing, a refusal shows its message and its action button, a slow
// add makes the input read-only with "checking…" and drops a second add, and
// a full section shows a one-line note in place of the row. The row never
// checks capacity or duplicates itself: the stub's commit writer does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';

import {
  STUB_FULL_REFUSAL,
  STUB_REFUSAL_ACTION,
  STUB_REFUSAL_MESSAGE,
  STUB_SIGNALS_CAPACITY,
  createStubTool,
  type StubTool,
} from './__fixtures__/stubTool';
import { OutlineAddRow } from './OutlineAddRow';
import { TESTIDS } from './testids';
import type { OutlineSection } from './types';

// ---------------------------------------------------------------- harness --

function Harness({
  tool,
  sectionId,
  search,
}: {
  tool: StubTool;
  sectionId: string;
  search: (pattern: string) => Promise<string[]>;
}) {
  useSyncExternalStore(tool.subscribe, () => tool.getState());
  const { binding } = tool.definition;
  const outline = binding.outline(tool.getState(), tool.getModel());
  const section = outline.sections.find((s) => s.id === sectionId)!;
  const withSearch: OutlineSection = section.add
    ? { ...section, add: { ...section.add, search } }
    : section;
  return <OutlineAddRow section={withSearch} add={binding.ops.add} catalog={[]} />;
}

function mount(sectionId = 'signals', hits: string[] = []) {
  const tool = createStubTool();
  const search = vi.fn(async () => hits);
  render(<Harness tool={tool} sectionId={sectionId} search={search} />);
  return { tool, search };
}

const input = () => screen.getByTestId(TESTIDS.outlineAddInput) as HTMLInputElement;

async function settle(ms = 300) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Lets the async `ops.add` resolve and the row re-render. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function typeAndEnter(text: string) {
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.keyDown(input(), { key: 'Enter' });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ------------------------------------------------------------------ tests --

describe('OutlineAddRow adds', () => {
  it('adds a picked suggestion through ops.add and empties the field', async () => {
    const { tool } = mount('signals', ['SIM:PICKED:PV', 'SIM:OTHER']);
    fireEvent.change(input(), { target: { value: 'sim' } });
    await settle();
    expect(tool.calls.add).toEqual([]);
    fireEvent.click(screen.getByRole('option', { name: 'SIM:PICKED:PV' }));
    await flush();
    expect(tool.calls.add).toEqual([{ sectionId: 'signals', pv: 'SIM:PICKED:PV' }]);
    expect(tool.getState().items.some((i) => i.pv === 'SIM:PICKED:PV')).toBe(true);
    expect(screen.queryByTestId(TESTIDS.outlineAddRefusal)).toBeNull();
  });

  it('adds the typed text on Enter', async () => {
    const { tool } = mount('locked');
    typeAndEnter('TEST:TYPED:PV ');
    await flush();
    expect(tool.calls.add).toEqual([{ sectionId: 'locked', pv: 'TEST:TYPED:PV' }]);
    expect(tool.getState().items.some((i) => i.pv === 'TEST:TYPED:PV')).toBe(true);
    expect(input().value).toBe('');
  });

  it('keeps the half-typed text on click-away and adds nothing', async () => {
    const { tool } = mount();
    fireEvent.change(input(), { target: { value: 'TEST:HALF' } });
    fireEvent.blur(input());
    await flush();
    expect(tool.calls.add).toEqual([]);
    expect(input().value).toBe('TEST:HALF');
  });
});

describe('OutlineAddRow refusals', () => {
  it('shows a refusal with its action button and keeps the text', async () => {
    const { tool } = mount();
    typeAndEnter('REFUSE:X');
    await flush();
    const refusal = screen.getByTestId(TESTIDS.outlineAddRefusal);
    expect(refusal.textContent).toContain(STUB_REFUSAL_MESSAGE);
    fireEvent.click(screen.getByRole('button', { name: STUB_REFUSAL_ACTION }));
    expect(tool.calls.refusalAction).toBe(1);
    expect(input().value).toBe('REFUSE:X');
    // Typing again clears the stale refusal.
    fireEvent.change(input(), { target: { value: 'TEST:NEXT' } });
    expect(screen.queryByTestId(TESTIDS.outlineAddRefusal)).toBeNull();
  });

  it('leaves duplicate checks to the commit writer and shows its refusal', async () => {
    const { tool } = mount('locked');
    const existing = tool.getState().items[0]!.pv;
    typeAndEnter(existing);
    await flush();
    expect(tool.calls.add).toHaveLength(1);
    expect(screen.getByTestId(TESTIDS.outlineAddRefusal).textContent).toContain(
      `${existing} is already here`
    );
    // A refusal without an action shows no button.
    expect(screen.queryByRole('button', { name: STUB_REFUSAL_ACTION })).toBeNull();
  });
});

describe('OutlineAddRow pending add', () => {
  it('a slow add makes the input read-only, reads "checking…" and blocks a second add', async () => {
    // Locked has no capacity, so the row stays after the slow add lands.
    const { tool } = mount('locked');
    typeAndEnter('SLOW:A');
    await flush();
    expect(tool.pendingSlowAdds()).toBe(1);
    expect(screen.getByTestId(TESTIDS.outlineAddStatus).textContent).toBe('checking…');
    expect(input().readOnly).toBe(true);

    // A second Enter while the first is in flight adds nothing.
    fireEvent.keyDown(input(), { key: 'Enter' });
    typeAndEnter('TEST:SECOND');
    await flush();
    expect(tool.calls.add).toEqual([{ sectionId: 'locked', pv: 'SLOW:A' }]);

    await act(async () => {
      await tool.releaseSlowAdds();
    });
    await flush();
    expect(screen.queryByTestId(TESTIDS.outlineAddStatus)).toBeNull();
    expect(input().readOnly).toBe(false);
    expect(tool.getState().items.some((i) => i.pv === 'SLOW:A')).toBe(true);

    // Once settled, the next add goes through.
    typeAndEnter('TEST:THIRD');
    await flush();
    expect(tool.calls.add.map((c) => c.pv)).toEqual(['SLOW:A', 'TEST:THIRD']);
  });
});

describe('OutlineAddRow full section', () => {
  it('replaces the row with a one-line note once the section is full', async () => {
    const { tool } = mount();
    const signals = () => tool.getState().items.filter((i) => i.section === 'signals').length;
    expect(signals()).toBe(STUB_SIGNALS_CAPACITY - 1);
    typeAndEnter('TEST:LAST');
    await flush();
    expect(signals()).toBe(STUB_SIGNALS_CAPACITY);
    expect(screen.queryByTestId(TESTIDS.outlineAddInput)).toBeNull();
    expect(
      screen.getByText(`Signals is full (${STUB_SIGNALS_CAPACITY}/${STUB_SIGNALS_CAPACITY})`)
    ).toBeTruthy();
    expect(STUB_FULL_REFUSAL).toContain('full');
  });

  it('shows the note for a section rendered at capacity, and the row below it', () => {
    const base: OutlineSection = {
      id: 's',
      kind: 's',
      title: 'S',
      count: 2,
      rows: [],
      add: { placeholder: 'Add to S' },
    };
    const add = vi.fn(async () => {});
    const { rerender } = render(<OutlineAddRow section={{ ...base, capacity: 2 }} add={add} />);
    expect(screen.getByText('S is full (2/2)')).toBeTruthy();
    expect(screen.queryByTestId(TESTIDS.outlineAddInput)).toBeNull();
    rerender(<OutlineAddRow section={{ ...base, capacity: 3 }} add={add} />);
    expect(screen.queryByText(/is full/)).toBeNull();
    expect(screen.getByTestId(TESTIDS.outlineAddInput)).toBeTruthy();
  });

  it('renders nothing for a section without an add row', () => {
    const { container } = render(
      <OutlineAddRow
        section={{ id: 's', kind: 's', title: 'S', count: 0, rows: [] }}
        add={async () => {}}
      />
    );
    expect(container.innerHTML).toBe('');
  });
});
