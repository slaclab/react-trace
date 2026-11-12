// @vitest-environment jsdom
//
// The top block of the properties panel against the stub tool: groups (sections naming one `group` share a heading; a one-section group
// folds the section header into the heading; several sections show
// collapsible sub-headings with chevron, unit tag and count), the inline header
// field with its `data-testid`, cards (status dot, swatch and eye as the
// item's own Colour and Visible fields, remove; a head click opens the card as
// the item selection and a second click closes it; the open card shows the
// item's field groups as blocks), section settings under the cards, muted
// sections and cards, footer actions (a disabled one stays visible with its reason), and the structural view-model
// compare.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, useSyncExternalStore } from 'react';
import { TrashCan } from '@carbon/icons-react';

vi.mock('./fields', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fields')>();
  return { ...actual, FieldControl: vi.fn(actual.FieldControl) };
});

import { FieldControl } from './fields';
import {
  STUB_REFUSAL_MESSAGE,
  colourField,
  createStubTool,
  item,
  sectionCountField,
  sectionVisibleField,
  stubAutoColour,
  stubSchema,
  withSections,
  type StubTool,
} from './__fixtures__/stubTool';
import { Outline } from './Outline';
import { outlineGroups } from './outlineGroups';
import { SelectionProvider, createSelectionStore, type SelectionStore } from './selection';
import type { Action, FieldDef, OutlineSection, ToolDefinition } from './types';
import type { StubCtx, StubModel, StubState, StubUi } from './__fixtures__/stubTool';

// ---------------------------------------------------------------- harness --

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

function mount(
  options: { definition?: (tool: StubTool) => StubDefinition; store?: SelectionStore } = {}
) {
  const tool = createStubTool();
  const store = options.store ?? createSelectionStore();
  const definition = options.definition?.(tool) ?? tool.definition;
  const view = render(
    <SelectionProvider store={store}>
      <Harness tool={tool} definition={definition} />
    </SelectionProvider>
  );
  return { tool, store, view };
}

/** Both stub sections under one `Signals` group heading. */
const oneGroup = (tool: StubTool) =>
  withSections(tool.definition, { signals: { group: 'Signals' }, locked: { group: 'Signals' } });

const groupEl = (slug: string) => document.querySelector(`[data-group="${slug}"]`) as HTMLElement;
const sectionEl = (id: string) =>
  document.querySelector(`[data-section-id="${id}"]`) as HTMLElement;
const headerOf = (id: string) =>
  sectionEl(id).querySelector('.wb-outline-section__header') as HTMLElement;
const rowEl = (id: string) => document.querySelector(`[data-row-id="${id}"]`) as HTMLElement;
const cardEl = (id: string) => document.querySelector(`[data-card-id="${id}"]`) as HTMLElement;
const bodyOf = (id: string) => cardEl(id).querySelector('.wb-card__body') as HTMLElement | null;
const settingsOf = (id: string) =>
  sectionEl(id).querySelector('.wb-outline-section__settings') as HTMLElement | null;
const fieldIn = (root: Element, id: string) => root.querySelector(`[data-field="${id}"]`);

beforeEach(() => {
  vi.mocked(FieldControl).mockClear();
});

afterEach(() => {
  cleanup();
});

// ----------------------------------------------------------------- groups --

describe('outlineGroups', () => {
  const s = (id: string, kind: string, title: string): OutlineSection => ({
    id,
    kind,
    title,
    count: 0,
    rows: [],
  });

  it('puts consecutive sections naming the same group under one heading', () => {
    const group = (kind: string) => (kind === 'axis' ? 'Signals' : undefined);
    const groups = outlineGroups(group, [
      s('y1', 'axis', 'Y axis 1'),
      s('y2', 'axis', 'Y axis 2'),
      s('ann', 'drawings', 'Drawings'),
    ]);
    expect(groups.map((g) => [g.title, g.sections.map((x) => x.id)])).toEqual([
      ['Signals', ['y1', 'y2']],
      ['Drawings', ['ann']],
    ]);
  });

  it('defaults the group to the section title, and splits a group that is not consecutive', () => {
    const group = (kind: string) => (kind === 'ref' ? 'Reference' : undefined);
    const groups = outlineGroups(group, [
      s('a', 'ref', 'Live'),
      s('b', 'x', 'X axis PV'),
      s('c', 'ref', 'Snapshot'),
    ]);
    expect(groups.map((g) => [g.title, g.sections.map((x) => x.id)])).toEqual([
      ['Reference', ['a']],
      ['X axis PV', ['b']],
      ['Reference', ['c']],
    ]);
  });
});

describe('a group of one section', () => {
  it('folds the section header into the group heading: title, n/cap only with a capacity', () => {
    mount();
    const signals = groupEl('signals');
    expect(within(signals).getByRole('heading', { level: 3 }).textContent).toBe('Signals');
    expect(within(headerOf('signals')).getByText('2/3')).toBeTruthy();
    // No sub-heading, no collapse toggle, no unit tag.
    expect(signals.querySelectorAll('.wb-outline-section__header')).toHaveLength(1);
    expect(headerOf('signals').querySelector('.wb-outline-section__toggle')).toBeNull();
    expect(headerOf('signals').querySelector('.wb-outline-section__unit')).toBeNull();

    const locked = groupEl('locked');
    expect(within(locked).getByRole('heading', { level: 3 }).textContent).toBe('Locked');
    expect(within(headerOf('locked')).getByText('1')).toBeTruthy();
    expect(within(headerOf('locked')).queryByText(/\//)).toBeNull();
  });

  it('titles the heading with the section kind group when one is given', () => {
    mount({ definition: (tool) => withSections(tool.definition, { locked: { group: 'Pinned' } }) });
    expect(within(groupEl('pinned')).getByRole('heading', { level: 3 }).textContent).toBe('Pinned');
    expect(groupEl('locked')).toBeNull();
  });

  it('a click on the heading neither collapses nor selects', () => {
    const { store } = mount();
    fireEvent.click(headerOf('signals'));
    expect(rowEl('a')).toBeTruthy();
    expect(store.get().selection).toBeNull();
  });
});

describe('a group of several sections', () => {
  it('shows one group heading, then a sub-heading per section: chevron, unit before title, count', () => {
    mount({ definition: oneGroup });
    const group = groupEl('signals');
    expect(document.querySelectorAll('.wb-group')).toHaveLength(1);
    const headings = within(group).getAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(['Signals']);

    const signals = headerOf('signals');
    expect(signals.querySelector('.wb-outline-section__chevron')).toBeTruthy();
    const unit = within(signals).getByText('mm');
    const title = within(signals).getByText('Signals');
    expect(unit.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(signals).getByText('2/3')).toBeTruthy();

    const locked = headerOf('locked');
    expect(within(locked).getByText('Locked')).toBeTruthy();
    expect(within(locked).getByText('1')).toBeTruthy();
    expect(within(locked).queryByText(/\//)).toBeNull();
    expect(locked.querySelector('.wb-outline-section__unit')).toBeNull();
  });

  it('collapses and expands a section on a sub-heading click', () => {
    mount({ definition: oneGroup });
    const toggle = within(headerOf('signals')).getByRole('button', { name: /Signals/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(rowEl('a')).toBeTruthy();

    fireEvent.click(headerOf('signals'));
    expect(rowEl('a')).toBeNull();
    expect(rowEl('b')).toBeNull();
    expect(settingsOf('signals')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(sectionEl('signals').classList.contains('wb-outline-section--collapsed')).toBe(true);
    // The other section is untouched.
    expect(rowEl('c')).toBeTruthy();

    fireEvent.click(toggle);
    expect(rowEl('a')).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('a sub-heading click does not select the section (headers collapse)', () => {
    const { store } = mount({ definition: oneGroup });
    fireEvent.click(headerOf('signals'));
    expect(store.get().selection).toBeNull();
  });

  it('keeps collapse state when the view-model changes', () => {
    const { tool } = mount({ definition: oneGroup });
    fireEvent.click(headerOf('locked'));
    expect(rowEl('c')).toBeNull();
    act(() => tool.setStatus('a', 'error'));
    expect(rowEl('c')).toBeNull();
  });
});

describe('header controls', () => {
  it('renders the header field with data-testid=<field id> and no #id, targeted at the section', () => {
    const { tool } = mount();
    const eye = within(headerOf('signals')).getByTestId(sectionVisibleField.id);
    expect(eye.id).toBe('');
    expect(document.getElementById(sectionVisibleField.id)).toBeNull();
    // headerField and the row:'eye' section field are the same field: rendered once.
    expect(within(headerOf('signals')).getAllByTestId(sectionVisibleField.id)).toHaveLength(1);

    fireEvent.click(eye);
    expect(tool.getState().sectionVisible.signals).toBe(false);
    expect(tool.getState().sectionVisible.locked).toBe(true);
    expect(sectionEl('signals').classList.contains('wb-outline-section--muted')).toBe(true);
  });

  it('renders the header controls on a sub-heading too, and a click there does not collapse', () => {
    const { tool } = mount({ definition: oneGroup });
    fireEvent.click(within(headerOf('locked')).getByTestId(sectionVisibleField.id));
    expect(tool.getState().sectionVisible.locked).toBe(false);
    expect(rowEl('c')).toBeTruthy();
  });

  it('renders a section field with row:"eye" on the header when it is not the headerField', () => {
    mount({
      definition: (tool) =>
        withSections(tool.definition, {
          signals: { headerField: undefined },
          locked: { headerField: undefined },
        }),
    });
    expect(within(headerOf('locked')).getByTestId(sectionVisibleField.id)).toBeTruthy();
  });
});

// ------------------------------------------------------------------ cards --

describe('card heads', () => {
  it('render status dot, swatch and name; the refusal is the dot title', () => {
    const { tool } = mount();
    const a = rowEl('a');
    expect(within(a).getByText('STUB:A')).toBeTruthy();
    expect(a.querySelector('.wb-outline-row__status--ok')).toBeTruthy();
    const swatch = within(a).getByRole('button', { name: 'Colour' });
    expect(swatch.style.backgroundColor).not.toBe('');

    act(() => tool.setStatus('a', 'refused'));
    const dot = rowEl('a').querySelector('.wb-outline-row__status--refused') as HTMLElement;
    expect(dot).toBeTruthy();
    expect(dot.getAttribute('title')).toBe(STUB_REFUSAL_MESSAGE);
  });

  it('head slots carry no #id and no field testid', () => {
    mount();
    const a = rowEl('a');
    expect(a.querySelector('[data-testid]')).toBeNull();
    expect(a.querySelector(`#${colourField.id}`)).toBeNull();
    expect(document.getElementById('stub-visible')).toBeNull();
    expect(document.querySelector('[data-testid="trace-color-swatch"]')).toBeNull();
  });

  it('shows a swatch iff the item kind has a row:"swatch" Colour field', () => {
    mount({
      definition: (tool) => ({
        ...tool.definition,
        schema: {
          ...stubSchema,
          items: {
            signal: {
              tabs: stubSchema.items.signal.tabs.map((tab) => ({
                ...tab,
                fields: tab.fields.filter((f) => f.kind !== 'colour'),
              })),
            },
          },
        },
      }),
    });
    expect(within(rowEl('a')).queryByRole('button', { name: 'Colour' })).toBeNull();
    // The eye is still there.
    expect(within(rowEl('a')).getByRole('button', { name: 'Hide visible' })).toBeTruthy();
  });

  it('the swatch writes through the Colour field setter for its own card', () => {
    const { tool, store } = mount();
    const input = rowEl('b').querySelector('input[type="color"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '#123456' } });
    expect(tool.getState().items.find((i) => i.id === 'b')!.colour).toBe('#123456');
    expect(tool.getState().items.find((i) => i.id === 'a')!.colour).toBe(stubAutoColour(0));
    // The Colour field is now pinned: the head shows the field's modified dot.
    expect(rowEl('b').querySelector('.wb-outline-row__modified')).toBeTruthy();
    expect(rowEl('a').querySelector('.wb-outline-row__modified')).toBeNull();
    expect(store.get().selection).toBeNull();
  });

  it('the eye toggles the Visible field and a hidden card renders muted', () => {
    const { tool, store } = mount();
    fireEvent.click(within(rowEl('a')).getByRole('button', { name: 'Hide visible' }));
    expect(tool.getState().items.find((i) => i.id === 'a')!.visible).toBe(false);
    expect(cardEl('a').classList.contains('wb-card--muted')).toBe(true);
    expect(cardEl('b').classList.contains('wb-card--muted')).toBe(false);
    // A slot click neither selects nor opens the card.
    expect(store.get().selection).toBeNull();
    expect(bodyOf('a')).toBeNull();
    fireEvent.click(within(rowEl('a')).getByRole('button', { name: 'Show visible' }));
    expect(cardEl('a').classList.contains('wb-card--muted')).toBe(false);
  });

  it('remove calls ops.remove with the row id and does not select', () => {
    const { tool, store } = mount();
    fireEvent.click(within(rowEl('b')).getByRole('button', { name: 'Remove STUB:B' }));
    expect(tool.calls.remove).toEqual(['b']);
    expect(rowEl('b')).toBeNull();
    expect(store.get().selection).toBeNull();
  });

  it('a muted section renders muted', () => {
    const { tool } = mount();
    expect(sectionEl('locked').classList.contains('wb-outline-section--muted')).toBe(false);
    act(() =>
      tool.update((s) => ({ ...s, sectionVisible: { ...s.sectionVisible, locked: false } }))
    );
    expect(sectionEl('locked').classList.contains('wb-outline-section--muted')).toBe(true);
  });

  it('renders one add row per section after its cards', () => {
    mount();
    const signals = sectionEl('signals');
    const add = signals.querySelector('.wb-outline-add') as HTMLElement;
    expect(add).toBeTruthy();
    expect(
      cardEl('b').compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(sectionEl('locked').querySelector('.wb-outline-add')).toBeTruthy();
  });
});

describe('opening a card', () => {
  it('a head click opens the card as the user selection of its item; a second click closes it', () => {
    const { store } = mount();
    fireEvent.click(rowEl('b'));
    expect(store.get().selection).toEqual(item('b'));
    expect(store.get().origin).toBe('user');
    expect(cardEl('b').classList.contains('wb-card--open')).toBe(true);
    expect(
      within(rowEl('b')).getByRole('button', { name: 'STUB:B' }).getAttribute('aria-expanded')
    ).toBe('true');
    expect(bodyOf('b')).not.toBeNull();
    expect(bodyOf('b')!.getAttribute('data-level')).toBe('item');
    expect(cardEl('a').classList.contains('wb-card--open')).toBe(false);
    expect(bodyOf('a')).toBeNull();

    fireEvent.click(rowEl('b'));
    expect(store.get().selection).toBeNull();
    expect(store.get().origin).toBe('reset');
    expect(cardEl('b').classList.contains('wb-card--open')).toBe(false);
    expect(bodyOf('b')).toBeNull();
  });

  it('one card is open at a time: opening another closes the first', () => {
    const { store } = mount();
    fireEvent.click(rowEl('a'));
    fireEvent.click(rowEl('c'));
    expect(store.get().selection).toEqual(item('c'));
    expect(bodyOf('a')).toBeNull();
    expect(bodyOf('c')).not.toBeNull();
    expect(document.querySelectorAll('.wb-card--open')).toHaveLength(1);
  });

  it('the name button opens it from the keyboard', () => {
    const { store } = mount();
    fireEvent.click(within(rowEl('c')).getByRole('button', { name: 'STUB:C' }));
    expect(store.get().selection).toEqual(item('c'));
    expect(bodyOf('c')).not.toBeNull();
  });

  it('a selection from elsewhere opens the card, an initial one too; a reset closes it', () => {
    const store = createSelectionStore({ initial: item('a') });
    mount({ store });
    expect(bodyOf('a')).not.toBeNull();
    act(() => store.select(item('b')));
    expect(bodyOf('a')).toBeNull();
    expect(bodyOf('b')).not.toBeNull();
    act(() => store.reset());
    expect(document.querySelector('.wb-card__body')).toBeNull();
  });

  it('a section selection opens no card', () => {
    const store = createSelectionStore({
      initial: { level: 'section', kind: 'signals', id: 'signals' },
    });
    mount({ store });
    expect(document.querySelector('.wb-card__body')).toBeNull();
  });
});

describe('the open card', () => {
  it('shows the item tabs as titled blocks in order, the Code tab left out', () => {
    mount({ store: createSelectionStore({ initial: item('a') }) });
    const body = bodyOf('a')!;
    const blocks = [...body.querySelectorAll('.wb-block')];
    expect(blocks.map((b) => b.getAttribute('data-block'))).toEqual(['general', 'line']);
    expect(blocks.map((b) => b.querySelector('.wb-block__heading')?.textContent)).toEqual([
      'General',
      'Line',
    ]);
    expect(fieldIn(body, 'stub-item-code')).toBeNull();
  });

  it('shows no block heading when the item has one block', () => {
    mount({
      store: createSelectionStore({ initial: item('a') }),
      definition: (tool) => ({
        ...tool.definition,
        schema: {
          ...stubSchema,
          items: {
            signal: { tabs: stubSchema.items.signal.tabs.filter((t) => t.id !== 'line') },
          },
        },
      }),
    });
    const body = bodyOf('a')!;
    expect(body.querySelectorAll('.wb-block')).toHaveLength(1);
    expect(body.querySelector('.wb-block__heading')).toBeNull();
    expect(fieldIn(body, 'stub-label')).not.toBeNull();
  });

  it('renders the fields with their #id; the eye and lock stay on the head only', () => {
    mount({ store: createSelectionStore({ initial: item('a') }) });
    const body = bodyOf('a')!;
    expect(body.querySelector('#stub-label')).not.toBeNull();
    expect(body.querySelector('#stub-line-width')).not.toBeNull();
    expect(fieldIn(body, 'stub-colour')).not.toBeNull();
    expect(fieldIn(body, 'stub-visible')).toBeNull();
    expect(fieldIn(body, 'stub-pinned')).toBeNull();
    expect(document.getElementById('stub-visible')).toBeNull();
    expect(document.getElementById('stub-pinned')).toBeNull();
    // The head still has them.
    expect(rowEl('a').querySelector('.wb-outline-row__eye')).not.toBeNull();
    expect(rowEl('a').querySelector('.wb-outline-row__lock')).not.toBeNull();
  });

  it('keeps the Status group and the More disclosure of each block', () => {
    mount({ store: createSelectionStore({ initial: item('a') }) });
    const body = bodyOf('a')!;
    const status = within(body).getByRole('region', { name: 'Status' });
    expect(fieldIn(status, 'stub-status')).not.toBeNull();
    const more = within(body).getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(fieldIn(body, 'stub-gain')).toBeNull();
    fireEvent.click(more);
    expect(fieldIn(body, 'stub-gain')).not.toBeNull();
  });

  it('a field change writes through the setter of its own item and re-renders the card', () => {
    const { tool } = mount({ store: createSelectionStore({ initial: item('b') }) });
    fireEvent.change(document.getElementById('stub-label') as HTMLInputElement, {
      target: { value: 'Beam' },
    });
    expect(tool.getState().items.find((i) => i.id === 'b')!.label).toBe('Beam');
    expect(tool.getState().items.find((i) => i.id === 'a')!.label).toBeUndefined();
    expect(within(rowEl('b')).getByRole('button', { name: 'Beam' })).toBeTruthy();
    expect((document.getElementById('stub-label') as HTMLInputElement).value).toBe('Beam');
  });

  it('a click inside the body does not close the card', () => {
    const { store } = mount({ store: createSelectionStore({ initial: item('a') }) });
    fireEvent.click(bodyOf('a')!);
    expect(store.get().selection).toEqual(item('a'));
    expect(bodyOf('a')).not.toBeNull();
  });
});

// ------------------------------------------------------- section settings --

describe('section settings', () => {
  it("shows a section's own fields under its cards and add row, header controls left out", () => {
    mount();
    const settings = settingsOf('signals')!;
    expect(settings).not.toBeNull();
    expect(fieldIn(settings, sectionCountField.id)).not.toBeNull();
    expect(fieldIn(settings, sectionVisibleField.id)).toBeNull();
    const add = sectionEl('signals').querySelector('.wb-outline-add')!;
    expect(add.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(settingsOf('locked')).not.toBeNull();
  });

  it('leaves out the header field and every row field, keeping the rest', () => {
    const headerToggle: FieldDef<StubState, StubModel, StubUi> = {
      ...sectionVisibleField,
      id: 'stub-section-header',
      label: 'Shown',
      row: undefined,
    } as FieldDef<StubState, StubModel, StubUi>;
    mount({
      definition: (tool) =>
        withSections(tool.definition, {
          signals: {
            headerField: headerToggle,
            tabs: [
              {
                id: 'general',
                label: 'General',
                fields: [headerToggle, sectionVisibleField, sectionCountField],
              },
            ],
          },
        }),
    });
    // Both header controls are on the header, by testid.
    expect(within(headerOf('signals')).getByTestId('stub-section-header')).toBeTruthy();
    expect(within(headerOf('signals')).getByTestId(sectionVisibleField.id)).toBeTruthy();
    const settings = settingsOf('signals')!;
    expect(fieldIn(settings, 'stub-section-header')).toBeNull();
    expect(fieldIn(settings, sectionVisibleField.id)).toBeNull();
    expect(fieldIn(settings, sectionCountField.id)).not.toBeNull();
  });

  it("renders no settings for a section placed in Axes, and no settings block when nothing's left", () => {
    mount({
      definition: (tool) =>
        withSections(tool.definition, {
          locked: { placement: 'axes' },
          signals: {
            tabs: [{ id: 'general', label: 'General', fields: [sectionVisibleField] }],
          },
        }),
    });
    expect(settingsOf('locked')).toBeNull();
    expect(document.getElementById(sectionCountField.id)).toBeNull();
    expect(settingsOf('signals')?.querySelector('.wb-block') ?? null).toBeNull();
  });
});

// ----------------------------------------------------------------- footer --

describe('footer', () => {
  it('renders footer actions below the last group', () => {
    const { tool } = mount();
    const clear = screen.getByRole('button', { name: 'Clear all' });
    expect(
      sectionEl('locked').compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    fireEvent.click(clear);
    expect(tool.calls.footer).toBe(1);
  });

  it('a disabled footer action stays visible with its reason and does not run', () => {
    const onClick = vi.fn();
    const disabled: Action = {
      id: 'x',
      label: 'Export',
      icon: TrashCan,
      kind: 'button',
      disabled: 'Nothing to export',
      onClick,
    };
    mount({
      definition: (tool) => ({
        ...tool.definition,
        binding: { ...tool.definition.binding, footer: [disabled] },
      }),
    });
    const button = screen.getByRole('button', { name: /Export/ });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toContain('Nothing to export');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders no footer without footer actions', () => {
    mount({
      definition: (tool) => ({
        ...tool.definition,
        binding: { ...tool.definition.binding, footer: undefined },
      }),
    });
    expect(document.querySelector('.wb-outline__footer')).toBeNull();
  });
});

// ------------------------------------------------------------- rate rule --

describe('structural compare', () => {
  it('a model tick with unchanged content re-renders no head slot or header field', () => {
    const { tool } = mount();
    const before = vi.mocked(FieldControl).mock.calls.length;
    expect(before).toBeGreaterThan(0);
    act(() => tool.tick());
    act(() => tool.tick());
    expect(vi.mocked(FieldControl).mock.calls.length).toBe(before);
  });

  it('a status change re-renders only the changed card', () => {
    const { tool } = mount();
    vi.mocked(FieldControl).mockClear();
    act(() => tool.setStatus('a', 'stale'));
    const targets = vi
      .mocked(FieldControl)
      .mock.calls.map(([props]) => (props as { ctx: { target: { id: string } } }).ctx.target.id);
    expect(new Set(targets)).toEqual(new Set(['a']));
    expect(rowEl('a').querySelector('.wb-outline-row__status--stale')).toBeTruthy();
  });

  it('a colour change re-renders that card through its field getter', () => {
    const { tool } = mount();
    vi.mocked(FieldControl).mockClear();
    act(() =>
      tool.update((s) => ({
        ...s,
        items: s.items.map((i) => (i.id === 'c' ? { ...i, colour: '#abcdef' } : i)),
      }))
    );
    const targets = vi
      .mocked(FieldControl)
      .mock.calls.map(([props]) => (props as { ctx: { target: { id: string } } }).ctx.target.id);
    expect(new Set(targets)).toEqual(new Set(['c']));
    const swatch = within(rowEl('c')).getByRole('button', { name: 'Colour' });
    expect(swatch.style.backgroundColor).toBe('rgb(171, 205, 239)');
  });

  it('a head slot setter reads the latest state, not the state of its last render', () => {
    // An eye whose setter writes a whole state built from ctx.state: a stale
    // ctx would drop the unrelated change made after the card last rendered.
    const { tool } = mount({
      definition: (t) => ({
        ...t.definition,
        schema: {
          ...stubSchema,
          items: {
            signal: {
              tabs: stubSchema.items.signal.tabs.map((tab) => ({
                ...tab,
                fields: tab.fields.map((f) =>
                  f.kind === 'toggle' && f.id === 'stub-visible'
                    ? {
                        ...f,
                        set: (ctx: StubCtx, value: boolean) => {
                          const next = {
                            ...ctx.state,
                            items: ctx.state.items.map((i) =>
                              i.id === ctx.target.id ? { ...i, visible: value } : i
                            ),
                          };
                          ctx.update(() => next);
                        },
                      }
                    : f
                ),
              })),
            },
          },
        },
      }),
    });
    // Change something no head slot shows; the cards do not re-render.
    act(() => tool.update((s) => ({ ...s, reference: 'REF:PV' })));
    fireEvent.click(within(rowEl('a')).getByRole('button', { name: 'Hide visible' }));
    expect(tool.getState().reference).toBe('REF:PV');
    expect(tool.getState().items.find((i) => i.id === 'a')!.visible).toBe(false);
  });
});

// The harness re-renders; a parent re-render with equal props is a no-op too.
describe('parent re-render', () => {
  it('re-rendering the Outline with the same state re-renders no slot', () => {
    const tool = createStubTool();
    function Parent() {
      const [n, setN] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setN(n + 1)}>
            bump {n}
          </button>
          <Outline
            definition={tool.definition}
            state={tool.getState()}
            model={tool.getModel()}
            ui={tool.getUi()}
            update={tool.update}
            capabilities={tool.capabilities}
          />
        </>
      );
    }
    render(
      <SelectionProvider store={createSelectionStore()}>
        <Parent />
      </SelectionProvider>
    );
    const before = vi.mocked(FieldControl).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /^bump/ }));
    expect(screen.getByRole('button', { name: 'bump 1' })).toBeTruthy();
    expect(vi.mocked(FieldControl).mock.calls.length).toBe(before);
  });
});
