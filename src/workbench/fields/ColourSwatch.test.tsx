// @vitest-environment jsdom
//
// The colour renderer's swatch, ported from RightPanel.swatch.test.tsx:
// a swatch button drawn in the field's colour fronts the
// invisible native colour input and opens it; the browser's own colour-input
// chrome is never what the user sees. On the Properties rendering the swatch
// carries `data-testid=trace-color-swatch`; a row slot does not.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { colourField, createStubTool, item, type StubTool } from '../__fixtures__/stubTool';
import { Field } from './Field';
import { FieldControl } from './FieldControl';
import { COLOUR_SWATCH_TESTID, type FieldPlacement } from './hooks';

function Harness({ stub, placement }: { stub: StubTool; placement: FieldPlacement }) {
  useSyncExternalStore(stub.subscribe, stub.getState);
  const ctx = stub.ctx(item('a'));
  return placement === 'properties' ? (
    <Field field={colourField} ctx={ctx} />
  ) : (
    <FieldControl field={colourField} ctx={ctx} placement={placement} />
  );
}

function mount(placement: FieldPlacement = 'properties') {
  const stub = createStubTool();
  const view = render(<Harness stub={stub} placement={placement} />);
  return { stub, ...view };
}

/** The one swatch of a rendered field and the native input it fronts. */
function swatchAndInput(container: HTMLElement) {
  const swatches = screen.getAllByTestId(COLOUR_SWATCH_TESTID);
  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="color"]'));
  expect(swatches).toHaveLength(1);
  expect(inputs).toHaveLength(1);
  return { swatch: swatches[0] as HTMLButtonElement, input: inputs[0] };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('colour swatch', () => {
  it('renders a swatch button that carries the current colour', () => {
    const { container, stub } = mount();
    const value = stub.getState().items[0].colour;
    const { swatch, input } = swatchAndInput(container);
    expect(swatch.tagName).toBe('BUTTON');
    expect(swatch.type).toBe('button');
    expect(swatch.classList.contains('trace-color-swatch')).toBe(true);
    expect(swatch.getAttribute('aria-label')).toBe('Colour');
    expect(input.value).toBe(value);
    // jsdom normalises the inline colour to rgb(); compare through the DOM.
    const probe = document.createElement('span');
    probe.style.backgroundColor = value;
    expect(swatch.style.backgroundColor).toBe(probe.style.backgroundColor);
    expect(swatch.style.backgroundColor).not.toBe('');
  });

  it('hides the native input behind the swatch', () => {
    const { container } = mount();
    const { swatch, input } = swatchAndInput(container);
    expect(input.style.opacity).toBe('0');
    expect(input.style.position).toBe('absolute');
    expect(input.style.pointerEvents).toBe('none');
    // One tab stop per control: the swatch, not the input behind it.
    expect(input.tabIndex).toBe(-1);
    expect(input.getAttribute('aria-hidden')).toBe('true');
    expect(swatch.tabIndex).toBe(0);
    // Both live in one positioned box, so the picker opens at the swatch.
    expect(input.parentElement).toBe(swatch.parentElement);
    expect(input.parentElement?.classList.contains('trace-color-swatch-wrap')).toBe(true);
  });

  it('opens its input when the swatch is clicked', () => {
    const { container } = mount();
    const { swatch, input } = swatchAndInput(container);
    const opened = vi.fn();
    input.addEventListener('click', opened);
    fireEvent.click(swatch);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('prefers showPicker where the browser has it', () => {
    const { container } = mount();
    const { swatch, input } = swatchAndInput(container);
    const showPicker = vi.fn();
    Object.defineProperty(input, 'showPicker', { value: showPicker, configurable: true });
    const clicked = vi.fn();
    input.addEventListener('click', clicked);
    fireEvent.click(swatch);
    expect(showPicker).toHaveBeenCalledTimes(1);
    expect(clicked).not.toHaveBeenCalled();
  });

  it('falls back to a click when showPicker throws', () => {
    const { container } = mount();
    const { swatch, input } = swatchAndInput(container);
    Object.defineProperty(input, 'showPicker', {
      value: () => {
        throw new DOMException('not allowed', 'NotAllowedError');
      },
      configurable: true,
    });
    const clicked = vi.fn();
    input.addEventListener('click', clicked);
    fireEvent.click(swatch);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('writes a colour picked in the native input', () => {
    const { container, stub } = mount();
    fireEvent.change(swatchAndInput(container).input, { target: { value: '#ff0000' } });
    expect(stub.getState().items[0].colour).toBe('#ff0000');
  });

  it('carries no #id on the Properties rendering: the testid is its hook', () => {
    const { container } = mount();
    expect(container.querySelector('#stub-colour')).toBeNull();
  });

  it('a row slot carries neither hook', () => {
    const { container } = mount('row');
    expect(screen.queryByTestId(COLOUR_SWATCH_TESTID)).toBeNull();
    expect(container.querySelector('#stub-colour')).toBeNull();
    expect(container.querySelectorAll('button.trace-color-swatch')).toHaveLength(1);
  });
});
