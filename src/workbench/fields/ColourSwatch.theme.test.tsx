// @vitest-environment jsdom
// A colour field whose value is a theme variable (a drawing's ink,
// `var(--cds-text-primary)`): the swatch shows the variable, and the native
// colour input, which takes only `#rrggbb`, is never handed it. When the
// picker opens it starts at the colour the swatch shows, not at black.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ColourSwatch } from './ColourSwatch';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(value: string) {
  const onChange = vi.fn();
  const { container } = render(<ColourSwatch value={value} label="Color" onChange={onChange} />);
  const input = container.querySelector('input[type="color"]') as HTMLInputElement;
  const swatch = container.querySelector('button') as HTMLButtonElement;
  return { input, swatch, onChange };
}

describe('ColourSwatch with a theme colour', () => {
  it('opens the picker at the colour the swatch shows', () => {
    const real = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const style = real(el, pseudo);
      if (el instanceof HTMLButtonElement) {
        return { ...style, backgroundColor: 'rgb(244, 244, 244)' } as CSSStyleDeclaration;
      }
      return style;
    });
    const { input, swatch } = mount('var(--cds-text-primary)');
    expect(swatch.style.backgroundColor).toBe('var(--cds-text-primary)');
    // No value until it opens: the browser warns on any value but #rrggbb.
    expect(input.hasAttribute('value')).toBe(false);
    fireEvent.click(swatch);
    expect(input.value).toBe('#f4f4f4');
  });

  it('hands a hex value to the input as is', () => {
    const { input, swatch } = mount('#123456');
    expect(input.value).toBe('#123456');
    fireEvent.click(swatch);
    expect(input.value).toBe('#123456');
  });
});
