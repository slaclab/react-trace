// @vitest-environment jsdom
//
// The page root as a theming anchor: the main app's Carbon <Theme> element
// carries the host-theme attributes, and a Carbon floating menu opened below it
// is portalled into it, not into <body>, so it stays inside the themed subtree.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { getColorMode } from '@slaclab/canopy-shell/color-mode';
import { setHostTheme } from './state/colorMode';

// The real TraceApp's only overflow menu sits in a tool that is disabled until
// data loads; a bare menu under the real root tests the anchor itself.
vi.mock('./components/TraceApp', async () => {
  const React = await import('react');
  const { OverflowMenu, OverflowMenuItem } = await import('@carbon/react');
  return {
    TraceApp: () =>
      React.createElement(OverflowMenu, {
        iconDescription: 'Export',
        children: React.createElement(OverflowMenuItem, { itemText: 'Export CSV' }),
      }),
  };
});

const { default: App } = await import('./App');

function anchors(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-canopy-host-root]'));
}

/** The one anchor on the page, which must be the Carbon theme zone itself. */
function anchor(): HTMLElement {
  const found = anchors();
  expect(found.length).toBe(1);
  return found[0];
}

function expectAnchor(el: HTMLElement, id: string): void {
  expect(el.tagName).toBe('DIV');
  expect(el.getAttribute('data-canopy-host-root')).toBe('');
  expect(el.getAttribute('data-floating-menu-container')).toBe('');
  expect(el.getAttribute('data-theme')).toBe(id);
}

function expectZone(el: HTMLElement): void {
  const zone = getColorMode() === 'dark' ? 'cds--g100' : 'cds--g10';
  expect(el.classList.contains(zone)).toBe(true);
  expect(el.style.height).toBe('100%');
}

afterEach(() => {
  cleanup();
  act(() => setHostTheme(null, 'dark'));
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  window.history.replaceState(null, '', '/');
});

describe('main app root', () => {
  it('standalone, the theme zone is the anchor and names the colour mode', () => {
    render(<App />);
    const el = anchor();
    expectAnchor(el, getColorMode());
    expectZone(el);
  });

  it('carries the host theme id while the Carbon zone follows the mode', () => {
    render(<App />);
    act(() => setHostTheme('retro-light', 'light'));
    const el = anchor();
    expectAnchor(el, 'retro-light');
    expect(el.classList.contains('cds--g10')).toBe(true);
    expect(el.classList.contains('cds--g100')).toBe(false);

    act(() => setHostTheme('retro-dark', 'dark'));
    expectAnchor(anchor(), 'retro-dark');
    expect(anchor().classList.contains('cds--g100')).toBe(true);
  });

  it('opens overflow menu options inside the anchor', () => {
    render(<App />);
    const el = anchor();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const option = screen.getByText('Export CSV');
    expect(el.contains(option)).toBe(true);
    expect(option.closest('[data-floating-menu-container]')).toBe(el);
  });
});
