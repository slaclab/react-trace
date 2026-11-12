// @vitest-environment jsdom
//
// The field renderers against the stub tool: every kind reads
// through `get(ctx)` and writes through `set(ctx, v)`; the modified dot shows
// iff `modified(ctx)` and reset calls `reset(ctx)`; `when` false renders
// nothing and a `disabled(ctx)` reason disables the control and is shown;
// the action kind is a button with no dot; the custom kind renders the
// tool's renderer inside the chrome. Hooks: the schema id
// is the control's `#id` on the Properties rendering only, a header field
// carries `data-testid=<field id>`, a row slot neither.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import {
  colourField,
  createStubTool,
  gainField,
  inspectField,
  item,
  itemCodeField,
  labelField,
  lineWidthField,
  modeField,
  offsetField,
  statusField,
  stubAutoColour,
  tagsField,
  titleField,
  tool as toolTarget,
  visibleField,
  windowField,
  type StubModel,
  type StubState,
  type StubTool,
  type StubUi,
} from '../__fixtures__/stubTool';
import type { FieldDef, Target } from '../types';
import { Field } from './Field';
import { FieldControl } from './FieldControl';
import { parseNumber } from './logic';
import type { FieldPlacement } from './hooks';

type StubField = FieldDef<StubState, StubModel, StubUi>;

function Harness({
  stub,
  target,
  field,
  placement,
  bare,
}: {
  stub: StubTool;
  target: Target;
  field: StubField;
  placement?: FieldPlacement;
  bare?: boolean;
}) {
  // Re-render on every state or model change, as the properties panel does.
  useSyncExternalStore(stub.subscribe, stub.getState);
  useSyncExternalStore(stub.subscribe, stub.getModel);
  const ctx = stub.ctx(target);
  return bare ? (
    <FieldControl field={field} ctx={ctx} placement={placement} />
  ) : (
    <Field field={field} ctx={ctx} placement={placement} />
  );
}

function mount(
  field: StubField,
  {
    stub = createStubTool(),
    target = item('a'),
    placement,
    bare,
  }: { stub?: StubTool; target?: Target; placement?: FieldPlacement; bare?: boolean } = {}
) {
  const view = render(
    <Harness stub={stub} target={target} field={field} placement={placement} bare={bare} />
  );
  return { stub, ...view };
}

const itemA = (stub: StubTool) => stub.getState().items.find((i) => i.id === 'a')!;
const dot = (container: HTMLElement) => container.querySelector('.wb-field__dot');
const resetButton = (label: string) => screen.queryByRole('button', { name: `Reset ${label}` });

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {}))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('text', () => {
  it('writes through set and lights the dot; reset clears it', () => {
    const { stub, container } = mount(labelField);
    const input = container.querySelector<HTMLInputElement>('#stub-label')!;
    expect(input.value).toBe('');
    expect(dot(container)).toBeNull();
    expect(resetButton('Display name')).toBeNull();

    fireEvent.change(input, { target: { value: 'Beam' } });
    expect(itemA(stub).label).toBe('Beam');
    expect(input.value).toBe('Beam');
    expect(dot(container)).not.toBeNull();

    fireEvent.click(resetButton('Display name')!);
    expect(itemA(stub).label).toBeUndefined();
    expect(input.value).toBe('');
    expect(dot(container)).toBeNull();
  });

  it('shows the placeholder and the label', () => {
    const { container } = mount(labelField);
    expect(container.querySelector('#stub-label')!.getAttribute('placeholder')).toBe('PV name');
    expect(container.querySelector('.wb-field__label')!.textContent).toBe('Display name');
  });

  it('carries the level for the field block', () => {
    const { container } = mount(gainField);
    expect(container.querySelector('.wb-field')!.getAttribute('data-level')).toBe('L3');
  });

  it('works at tool level (optionalPath dot)', () => {
    const { stub, container } = mount(titleField, { target: toolTarget });
    fireEvent.change(container.querySelector('#stub-title')!, { target: { value: 'Mine' } });
    expect(stub.getState().title).toBe('Mine');
    expect(dot(container)).not.toBeNull();
    fireEvent.click(resetButton('Title')!);
    expect(stub.getState().title).toBeUndefined();
  });
});

describe('hooks per placement', () => {
  it('Properties: the schema id is the control id, no testid', () => {
    const { container } = mount(labelField);
    const input = container.querySelector('#stub-label')!;
    expect(input.tagName).toBe('INPUT');
    expect(input.hasAttribute('data-testid')).toBe(false);
  });

  it('header: data-testid=<field id> and no #id', () => {
    const { container } = mount(labelField, { placement: 'header', bare: true });
    expect(container.querySelector('#stub-label')).toBeNull();
    expect(screen.getByTestId('stub-label').tagName).toBe('INPUT');
  });

  it('row: neither hook', () => {
    const { container } = mount(visibleField, { placement: 'row', bare: true });
    expect(container.querySelector('#stub-visible')).toBeNull();
    expect(screen.queryByTestId('stub-visible')).toBeNull();
  });

  it.each([
    ['show-symbols', { ...visibleField, row: undefined, id: 'show-symbols' }, 'BUTTON'],
    ['axis-autoscale', { ...visibleField, row: undefined, id: 'axis-autoscale' }, 'BUTTON'],
    ['density-y', { ...lineWidthField, id: 'density-y' }, 'SELECT'],
    ['role', { ...lineWidthField, id: 'role' }, 'SELECT'],
    ['time-range', { ...tagsField, id: 'time-range' }, 'INPUT'],
    ['pv-name', { ...labelField, id: 'pv-name' }, 'INPUT'],
  ] as Array<[string, StubField, string]>)('keeps #%s working', (id, field, tag) => {
    const { container } = mount(field);
    const control = container.querySelector(`#${id}`)!;
    expect(control).not.toBeNull();
    expect(control.tagName).toBe(tag);
    // No field testid beside the #id (the stub's custom input has its own).
    expect(screen.queryByTestId(id)).toBeNull();
  });
});

describe('when and disabled', () => {
  it('renders nothing while when(ctx) is false', () => {
    const { stub, container } = mount(windowField);
    expect(container.innerHTML).toBe('');
    act(() =>
      stub.update((s) => ({ ...s, items: s.items.map((i) => ({ ...i, mode: 'smooth' })) }))
    );
    expect(container.querySelector('#stub-window')).not.toBeNull();
  });

  it('disables the control and shows the reason', () => {
    const field: StubField = { ...labelField, disabled: () => 'Not while paused' };
    const { container } = mount(field);
    expect(container.querySelector<HTMLInputElement>('#stub-label')!.disabled).toBe(true);
    expect(screen.getByText('Not while paused')).toBeTruthy();
  });

  it('shows help when there is no reason', () => {
    const { container } = mount({ ...labelField, help: 'Shown in the legend' });
    expect(container.querySelector('.wb-field__note')!.textContent).toBe('Shown in the legend');
  });
});

describe('number', () => {
  it('writes the parsed value and lights the recordKey dot', () => {
    const { stub, container } = mount(offsetField);
    const input = container.querySelector<HTMLInputElement>('#stub-offset')!;
    expect(input.value).toBe('0');
    fireEvent.change(input, { target: { value: '1.5' } });
    expect(stub.getState().offsets['STUB:A']).toBe(1.5);
    expect(dot(container)).not.toBeNull();
    fireEvent.click(resetButton('Offset')!);
    expect(stub.getState().offsets['STUB:A']).toBeUndefined();
    expect(input.value).toBe('0');
  });

  it('keeps a half-typed number without writing it', () => {
    const { stub, container } = mount(offsetField);
    const input = container.querySelector<HTMLInputElement>('#stub-offset')!;
    fireEvent.change(input, { target: { value: '-' } });
    expect(input.value).toBe('-');
    expect(stub.getState().offsets['STUB:A']).toBeUndefined();
  });

  it('writes null for an empty input', () => {
    const stub = createStubTool();
    stub.update((s) => ({ ...s, items: s.items.map((i) => ({ ...i, gain: 2 })) }));
    const { container } = mount(gainField, { stub });
    const input = container.querySelector<HTMLInputElement>('#stub-gain')!;
    expect(input.value).toBe('2');
    fireEvent.change(input, { target: { value: '' } });
    expect(itemA(stub).gain).toBeNull();
  });

  it('refuses a value below min and shows the unit', () => {
    const stub = createStubTool();
    stub.update((s) => ({
      ...s,
      items: s.items.map((i) => ({ ...i, mode: 'smooth', window: 5 })),
    }));
    const { container } = mount(windowField, { stub });
    const input = container.querySelector<HTMLInputElement>('#stub-window')!;
    fireEvent.change(input, { target: { value: '0' } });
    expect(itemA(stub).window).toBe(5);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('samples')).toBeTruthy();
    fireEvent.change(input, { target: { value: '7' } });
    expect(itemA(stub).window).toBe(7);
  });

  it('parseNumber: empty is null, junk and out-of-range are undefined', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber(' 3 ')).toBe(3);
    expect(parseNumber('abc')).toBeUndefined();
    expect(parseNumber('0', { min: 1 })).toBeUndefined();
    expect(parseNumber('9', { max: 8 })).toBeUndefined();
  });
});

describe('select', () => {
  it('writes the picked option', () => {
    const { stub, container } = mount(lineWidthField);
    const select = container.querySelector<HTMLSelectElement>('#stub-line-width')!;
    fireEvent.change(select, { target: { value: '2' } });
    expect(itemA(stub).width).toBe('2');
  });

  it('disables an option with its reason', () => {
    const { container } = mount(lineWidthField);
    const option = container.querySelector<HTMLOptionElement>('option[value="4"]')!;
    expect(option.disabled).toBe(true);
    expect(option.title).toBe('Too wide for the stub');
    expect(option.textContent).toContain('Too wide for the stub');
  });
});

describe('segmented', () => {
  it('is a radio group that writes the picked option', () => {
    const { stub, container } = mount(modeField);
    const group = container.querySelector('#stub-mode')!;
    expect(group.getAttribute('role')).toBe('radiogroup');
    const raw = screen.getByRole('radio', { name: 'Raw' });
    const smooth = screen.getByRole('radio', { name: 'Smooth' });
    expect(raw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(smooth);
    expect(itemA(stub).mode).toBe('smooth');
    expect(smooth.getAttribute('aria-checked')).toBe('true');
  });

  it('disables an option with its reason', () => {
    const field: StubField = {
      ...modeField,
      options: () => [
        { value: 'raw', label: 'Raw' },
        { value: 'smooth', label: 'Smooth', disabled: 'Needs two samples' },
      ],
    } as StubField;
    mount(field);
    const smooth = screen.getByRole('radio', { name: 'Smooth' }) as HTMLButtonElement;
    expect(smooth.disabled).toBe(true);
    expect(smooth.title).toBe('Needs two samples');
  });
});

describe('toggle', () => {
  it('Properties: a switch carrying the #id', () => {
    const { stub, container } = mount(visibleField);
    const button = container.querySelector('#stub-visible')!;
    expect(button.getAttribute('role')).toBe('switch');
    expect(button.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(button);
    expect(itemA(stub).visible).toBe(false);
    expect(button.getAttribute('aria-checked')).toBe('false');
  });

  it('row eye: a pressed button that flips the value', () => {
    const { stub } = mount(visibleField, { placement: 'row', bare: true });
    const eye = screen.getByRole('button', { name: 'Hide visible' });
    expect(eye.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(eye);
    expect(itemA(stub).visible).toBe(false);
    expect(screen.getByRole('button', { name: 'Show visible' })).toBeTruthy();
  });
});

describe('colour dot (stampedValue)', () => {
  it('pins on a non-automatic colour; reset writes the automatic colour', () => {
    const { stub, container } = mount(colourField);
    expect(dot(container)).toBeNull();
    fireEvent.change(container.querySelector('input[type="color"]')!, {
      target: { value: '#123456' },
    });
    expect(itemA(stub).colour).toBe('#123456');
    expect(dot(container)).not.toBeNull();
    fireEvent.click(resetButton('Colour')!);
    expect(itemA(stub).colour).toBe(stubAutoColour(0));
    expect(dot(container)).toBeNull();
  });
});

describe('readonly', () => {
  it('shows the value and follows the model', () => {
    const { stub, container } = mount(statusField);
    const output = container.querySelector('#stub-status')!;
    expect(output.textContent).toBe('pending');
    expect(container.querySelector('input')).toBeNull();
    act(() => stub.setStatus('a', 'ok'));
    expect(output.textContent).toBe('ok');
    expect(dot(container)).toBeNull();
  });
});

describe('code', () => {
  it('shows the source and copies it', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { container } = mount(itemCodeField);
    const pre = container.querySelector('#stub-item-code')!;
    expect(pre.textContent).toContain('"pv": "STUB:A"');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(writeText).toHaveBeenCalledWith(pre.textContent);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('says so when the copy fails', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    mount(itemCodeField);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(screen.getByRole('button', { name: 'Copy failed' })).toBeTruthy();
  });
});

describe('custom', () => {
  it("renders the tool's renderer inside the chrome with the #id", () => {
    const { stub, container } = mount(tagsField);
    const input = screen.getByTestId('stub-tags-input') as HTMLInputElement;
    expect(input.id).toBe('stub-tags');
    expect(input.closest('.wb-field')).not.toBeNull();
    expect(container.querySelector('.wb-field__label')!.textContent).toBe('Tags');
    fireEvent.change(input, { target: { value: 'x, y' } });
    expect(itemA(stub).tags).toBe('x, y');
  });

  it('shows the dot and reset when the tool supplies them', () => {
    const reset = vi.fn();
    const field = { ...tagsField, modified: () => true, reset } as StubField;
    mount(field);
    fireEvent.click(resetButton('Tags')!);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('gets no id off the Properties rendering', () => {
    mount(tagsField, { placement: 'row', bare: true });
    expect(screen.getByTestId('stub-tags-input').hasAttribute('id')).toBe(false);
  });
});

describe('action', () => {
  it('is hidden when its capability is absent', () => {
    const { container } = mount(inspectField);
    expect(container.innerHTML).toBe('');
  });

  it('runs on click, with no dot or reset', () => {
    const stub = createStubTool({ capabilities: { inspect: true } });
    const { container } = mount(inspectField, { stub });
    const button = container.querySelector<HTMLButtonElement>('#stub-inspect')!;
    expect(button.textContent).toBe('Inspect data');
    fireEvent.click(button);
    expect(stub.calls.action).toEqual(['a']);
    expect(dot(container)).toBeNull();
    expect(container.querySelector('.wb-field__reset')).toBeNull();
    expect(container.querySelector('.wb-field__label')).toBeNull();
  });

  it('is disabled with its reason when temporarily unusable', () => {
    const stub = createStubTool({ capabilities: { inspect: true } });
    const field: StubField = { ...inspectField, disabled: () => 'No data yet' };
    const { container } = mount(field, { stub });
    const button = container.querySelector<HTMLButtonElement>('#stub-inspect')!;
    expect(button.disabled).toBe(true);
    expect(screen.getByText('No data yet')).toBeTruthy();
    fireEvent.click(button);
    expect(stub.calls.action).toEqual([]);
  });
});
