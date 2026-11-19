// @vitest-environment jsdom
// A colour field whose value is a theme variable (a drawing's ink,
// `var(--cds-text-primary)`): the swatch shows the variable, and the native
// colour input, which takes only `#rrggbb`, is never handed it. It gets the
// colour the swatch shows instead, so the picker starts there, not at black.
// The input stays one element when the value changes form, so a focused
// input keeps focus (primary+Z in the sidebar relies on it).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ColourSwatch } from './ColourSwatch';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function paintSwatches(rgb: string) {
  const real = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
    const style = real(el, pseudo);
    if (el instanceof HTMLButtonElement) {
      return { ...style, backgroundColor: rgb } as CSSStyleDeclaration;
    }
    return style;
  });
}

function mount(value: string) {
  const onChange = vi.fn();
  const view = render(<ColourSwatch value={value} label="Color" onChange={onChange} />);
  const input = view.container.querySelector('input[type="color"]') as HTMLInputElement;
  const swatch = view.container.querySelector('button') as HTMLButtonElement;
  return { ...view, input, swatch, onChange };
}

describe('ColourSwatch with a theme colour', () => {
  it('gives the input the colour the swatch shows, never the variable', () => {
    paintSwatches('rgb(244, 244, 244)');
    const { input, swatch } = mount('var(--cds-text-primary)');
    expect(swatch.style.backgroundColor).toBe('var(--cds-text-primary)');
    expect(input.value).toBe('#f4f4f4');
    expect(input.getAttribute('value') ?? '').not.toContain('var(');
  });

  it('opens the picker at the colour shown now', () => {
    paintSwatches('rgb(244, 244, 244)');
    const { input, swatch } = mount('var(--cds-text-primary)');
    vi.restoreAllMocks();
    paintSwatches('rgb(22, 22, 22)');
    fireEvent.click(swatch);
    expect(input.value).toBe('#161616');
  });

  it('hands a hex value to the input as is', () => {
    const { input, swatch } = mount('#123456');
    expect(input.value).toBe('#123456');
    fireEvent.click(swatch);
    expect(input.value).toBe('#123456');
  });

  it('keeps the same input, and its focus, when a theme colour becomes a hex', () => {
    paintSwatches('rgb(244, 244, 244)');
    const { input, rerender, container } = mount('var(--cds-text-primary)');
    input.focus();
    expect(document.activeElement).toBe(input);
    rerender(<ColourSwatch value="#ff8800" label="Color" onChange={() => {}} />);
    const after = container.querySelector('input[type="color"]');
    expect(after).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('#ff8800');
  });
});
