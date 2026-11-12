// @vitest-environment jsdom
//
// One block of fields as the properties panel shows it everywhere: the L1 then L2 fields in declared order, the read-only Status group,
// the More disclosure for L3 (closed by default, its open state remembered per
// `memoryKey` in the panel's OpenMemory), `when` false hiding a field, an
// empty block rendering nothing, `subgroup` sub-headings where the subgroup
// changes, `omit`, the optional heading, and the L1 budget check.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { createStubTool, tool as toolTarget } from './__fixtures__/stubTool';
import type { StubModel, StubState, StubUi } from './__fixtures__/stubTool';
import { blockGroups } from './blockGroups';
import { FieldBlock, OpenMemoryProvider } from './FieldBlock';
import { OpenMemory } from './openMemory';
import type { FieldDef, FieldLevel, TabDef } from './types';

type Def = FieldDef<StubState, StubModel, StubUi>;
type Block = TabDef<StubState, StubModel, StubUi>;

/** A read-only field showing its own id. */
function ro(id: string, level: FieldLevel, extra: Partial<Def> = {}): Def {
  return { id, label: id, kind: 'readonly', tab: 'b', level, get: () => id, ...extra } as Def;
}

function block(fields: Def[], id = 'b'): Block {
  return { id, label: 'Block', fields };
}

const ctx = () => createStubTool().ctx(toolTarget);

/** The rendered field ids, in document order. */
const shownIds = (root: ParentNode = document) =>
  [...root.querySelectorAll('[data-field]')].map((el) => el.getAttribute('data-field'));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ order --

describe('order', () => {
  it('renders L1 then L2 in declared order, then the Status group, then More', () => {
    const fields = [
      ro('l2-a', 'L2'),
      ro('l1-a', 'L1'),
      ro('state', 'L1', { group: 'status' }),
      ro('l3-a', 'L3'),
      ro('l1-b', 'L1'),
      ro('l2-b', 'L2'),
    ];
    const { container } = render(<FieldBlock block={block(fields)} ctx={ctx()} memoryKey="k" />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(shownIds(container)).toEqual(['l1-a', 'l1-b', 'l2-a', 'l2-b', 'state', 'l3-a']);
    const status = screen.getByRole('region', { name: 'Status' });
    expect(shownIds(status)).toEqual(['state']);
    const more = container.querySelector('.wb-block__more')!;
    expect(status.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders each field through the properties placement, with its #id', () => {
    render(<FieldBlock block={block([ro('l1-a', 'L1')])} ctx={ctx()} memoryKey="k" />);
    expect(document.getElementById('l1-a')).not.toBeNull();
  });

  it('blockGroups splits the shown fields the same way', () => {
    const fields = [
      ro('l2', 'L2'),
      ro('s', 'L2', { group: 'status' }),
      ro('l3', 'L3'),
      ro('l1', 'L1'),
    ];
    const groups = blockGroups(fields, ctx());
    expect(groups.main.map((f) => f.id)).toEqual(['l1', 'l2']);
    expect(groups.status.map((f) => f.id)).toEqual(['s']);
    expect(groups.more.map((f) => f.id)).toEqual(['l3']);
  });
});

// ---------------------------------------------------------------- shown --

describe('what is shown', () => {
  it('leaves out a field whose `when` is false', () => {
    const fields = [ro('a', 'L1'), ro('b', 'L1', { when: () => false }), ro('c', 'L2')];
    render(<FieldBlock block={block(fields)} ctx={ctx()} memoryKey="k" />);
    expect(shownIds()).toEqual(['a', 'c']);
    expect(document.getElementById('b')).toBeNull();
  });

  it('renders nothing for a block with no shown field', () => {
    const fields = [ro('a', 'L1', { when: () => false }), ro('b', 'L3', { when: () => false })];
    const { container } = render(<FieldBlock block={block(fields)} ctx={ctx()} memoryKey="k" />);
    expect(container.innerHTML).toBe('');
    cleanup();
    const empty = render(<FieldBlock block={block([])} ctx={ctx()} memoryKey="k" heading />);
    expect(empty.container.innerHTML).toBe('');
  });

  it('renders no Status group and no More without such fields', () => {
    const { container } = render(
      <FieldBlock block={block([ro('a', 'L1')])} ctx={ctx()} memoryKey="k" />
    );
    expect(screen.queryByRole('region', { name: 'Status' })).toBeNull();
    expect(container.querySelector('.wb-block__more')).toBeNull();
  });

  it('a block of only L3 fields shows just the More disclosure', () => {
    const { container } = render(
      <FieldBlock block={block([ro('deep', 'L3')])} ctx={ctx()} memoryKey="k" />
    );
    expect(container.querySelector('.wb-block')).not.toBeNull();
    expect(shownIds(container)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(shownIds(container)).toEqual(['deep']);
  });

  it('leaves out the fields `omit` names', () => {
    const fields = [ro('a', 'L1'), ro('b', 'L1'), ro('c', 'L3')];
    render(
      <FieldBlock
        block={block(fields)}
        ctx={ctx()}
        memoryKey="k"
        omit={(f) => f.id === 'b' || f.id === 'c'}
      />
    );
    expect(shownIds()).toEqual(['a']);
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('shows the block label as a heading only when asked', () => {
    const { container, rerender } = render(
      <FieldBlock block={block([ro('a', 'L1')])} ctx={ctx()} memoryKey="k" />
    );
    expect(container.querySelector('.wb-block__heading')).toBeNull();
    rerender(<FieldBlock block={block([ro('a', 'L1')])} ctx={ctx()} memoryKey="k" heading />);
    expect(container.querySelector('.wb-block__heading')!.textContent).toBe('Block');
    expect(container.querySelector('.wb-block')!.getAttribute('data-block')).toBe('b');
  });
});

// -------------------------------------------------------------- subgroups --

describe('subgroups', () => {
  it('prints a sub-heading where the subgroup changes, before its first field', () => {
    const fields = [
      ro('top', 'L1'),
      ro('y-min', 'L1', { subgroup: 'Y axis' }),
      ro('y-max', 'L1', { subgroup: 'Y axis' }),
      ro('x-min', 'L1', { subgroup: 'X axis' }),
      ro('x-max', 'L2', { subgroup: 'X axis' }),
    ];
    const { container } = render(<FieldBlock block={block(fields)} ctx={ctx()} memoryKey="k" />);
    const sequence = [...container.querySelectorAll('.wb-block__subheading, [data-field]')].map(
      (el) => (el.matches('[data-field]') ? el.getAttribute('data-field') : `# ${el.textContent}`)
    );
    expect(sequence).toEqual(['top', '# Y axis', 'y-min', 'y-max', '# X axis', 'x-min', 'x-max']);
  });

  it('prints a subgroup again when it returns after another', () => {
    const fields = [
      ro('a', 'L1', { subgroup: 'Y axis' }),
      ro('b', 'L1', { subgroup: 'X axis' }),
      ro('c', 'L1', { subgroup: 'Y axis' }),
    ];
    const { container } = render(<FieldBlock block={block(fields)} ctx={ctx()} memoryKey="k" />);
    expect(
      [...container.querySelectorAll('.wb-block__subheading')].map((h) => h.textContent)
    ).toEqual(['Y axis', 'X axis', 'Y axis']);
  });
});

// ------------------------------------------------------------------- more --

describe('the More disclosure', () => {
  const fields = [ro('a', 'L1'), ro('deep', 'L3')];

  it('starts closed and toggles the L3 fields', () => {
    render(<FieldBlock block={block(fields)} ctx={ctx()} memoryKey="k" />);
    const more = screen.getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('deep')).toBeNull();
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('deep')).not.toBeNull();
    fireEvent.click(more);
    expect(document.getElementById('deep')).toBeNull();
  });

  it('is remembered per memoryKey across an unmount, under the same OpenMemory', () => {
    const memory = new OpenMemory();
    const mount = (memoryKey: string) =>
      render(
        <OpenMemoryProvider memory={memory}>
          <FieldBlock block={block(fields)} ctx={ctx()} memoryKey={memoryKey} />
        </OpenMemoryProvider>
      );
    mount('item:signal:general');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    cleanup();

    mount('item:signal:general');
    expect(screen.getByRole('button', { name: 'More' }).getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('deep')).not.toBeNull();
    cleanup();

    // Another key has its own flag.
    mount('item:signal:line');
    expect(screen.getByRole('button', { name: 'More' }).getAttribute('aria-expanded')).toBe(
      'false'
    );
  });

  it('a new memoryKey in the same slot reads its own flag', () => {
    const memory = new OpenMemory();
    const view = (memoryKey: string) => (
      <OpenMemoryProvider memory={memory}>
        <FieldBlock block={block(fields)} ctx={ctx()} memoryKey={memoryKey} />
      </OpenMemoryProvider>
    );
    const { rerender } = render(view('one'));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    rerender(view('two'));
    expect(screen.getByRole('button', { name: 'More' }).getAttribute('aria-expanded')).toBe(
      'false'
    );
    rerender(view('one'));
    expect(screen.getByRole('button', { name: 'More' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('without an OpenMemory, a remount starts closed again', () => {
    render(<FieldBlock block={block(fields)} ctx={ctx()} memoryKey="k" />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    cleanup();
    render(<FieldBlock block={block(fields)} ctx={ctx()} memoryKey="k" />);
    expect(screen.getByRole('button', { name: 'More' }).getAttribute('aria-expanded')).toBe(
      'false'
    );
  });
});

// ----------------------------------------------------------------- budget --

describe('the L1 budget', () => {
  const l1 = (n: number) => Array.from({ length: n }, (_, i) => ro(`f${i}`, 'L1'));

  it('warns once per block over 7 L1 fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const over = block(l1(8), 'crowded');
    const { rerender } = render(<FieldBlock block={over} ctx={ctx()} memoryKey="k" />);
    rerender(<FieldBlock block={over} ctx={ctx()} memoryKey="k" />);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('"crowded"');
  });

  it('does not count the Status group', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fields = [...l1(7), ro('s', 'L1', { group: 'status' })];
    render(<FieldBlock block={block(fields)} ctx={ctx()} memoryKey="k" />);
    expect(warn).not.toHaveBeenCalled();
    expect(shownIds(screen.getByRole('region', { name: 'Status' }))).toEqual(['s']);
  });
});
