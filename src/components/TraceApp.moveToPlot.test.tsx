// @vitest-environment jsdom
//
// R6, end to end: a Signals card dragged onto another plot's tab (tab view)
// or grid cell (grid view) moves the curve to that plot. The source plot
// stays active, a toast names the curve and the target ("Moved TEST:SINE to
// Plot 2") and the Outline announces it politely. A drop outside every
// section and target moves nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TraceApp } from './TraceApp';
import { WithCanopy } from '../test/canopy';
import { FORMULA_BINDS_REASON } from '../tools/trace/outline';

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);

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

// The Signals pane on the left (one section, cards 30 px tall), the plot
// tabs or grid cells to its right, side by side.
function rectOf(el: Element): DOMRect | null {
  if (el.matches?.('[data-section-id]')) return box(0, 0, 300, 200);
  if (el.matches?.('[data-row-id]')) {
    const card = el.closest('[data-card-id]')!;
    const index = Array.from(card.parentElement?.children ?? []).indexOf(card);
    return box(0, 30 + index * 30, 300, 30);
  }
  if (el.matches?.('[data-workbench-drop]')) {
    const all = [...document.querySelectorAll('[data-workbench-drop]')];
    return box(400 + all.indexOf(el) * 150, 0, 140, 32);
  }
  return null;
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/?pv=TEST:SINE&pv=TEST:FAST&range=-1h');
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline')))
  );
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rectOf(this) ?? original.call(this);
  });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  await new Promise((resolve) => setTimeout(resolve, 60));
});

const pointer = (x: number, y: number) => ({
  clientX: x,
  clientY: y,
  isPrimary: true,
  button: 0,
  pointerId: 1,
});

const rows = () =>
  [...document.querySelectorAll<HTMLElement>('[data-row-id]')].map((r) => r.textContent ?? '');
const rowNamed = (pv: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-row-id]')].find((r) =>
    r.textContent?.includes(pv)
  )!;
const dropTargets = () => [...document.querySelectorAll<HTMLElement>('[data-workbench-drop]')];
/** The plot tab titled `title` (the tab bar's, not the panel's title field). */
const tab = (title: string) =>
  [...document.querySelectorAll<HTMLElement>('.plot-tab')].find(
    (t) => t.querySelector('span')?.textContent === title
  )!;
const polite = () => document.querySelector('.wb-outline [aria-live="polite"]')?.textContent;

/** Drag the card of `pv` to (x, y) and release it there. */
function dragTo(pv: string, x: number, y: number) {
  const r = rowNamed(pv).getBoundingClientRect();
  fireEvent.pointerDown(rowNamed(pv), pointer(r.left + 100, r.top + 15));
  act(() => {
    fireEvent.pointerMove(document, pointer(r.left + 100, r.top + 25));
  });
  act(() => {
    fireEvent.pointerMove(document, pointer(x, y));
  });
  act(() => {
    fireEvent.pointerUp(document, pointer(x, y));
  });
}

/** TraceApp with Plot 1 (TEST:SINE, TEST:FAST) active and an empty Plot 2. */
function mount() {
  render(<TraceApp />, { wrapper: WithCanopy });
  fireEvent.click(screen.getByTitle('Add plot'));
  // Adding activates Plot 2; go back to Plot 1, whose curves Signals lists.
  fireEvent.click(tab('Plot 1'));
  expect(rows().some((r) => r.includes('TEST:SINE'))).toBe(true);
}

describe('dragging a Signals card to another plot', () => {
  it("in tab view, onto the plot's tab: the curve moves and Plot 1 stays active", async () => {
    mount();
    const [target] = dropTargets();
    expect(target).toBe(tab('Plot 2'));
    const at = target.getBoundingClientRect();
    dragTo('TEST:SINE', at.left + 20, at.top + 10);

    expect(rows().some((r) => r.includes('TEST:SINE'))).toBe(false);
    expect(rows().some((r) => r.includes('TEST:FAST'))).toBe(true);
    expect(screen.getByText('Moved TEST:SINE to Plot 2')).toBeTruthy();
    expect(polite()).toBe('TEST:SINE moved to Plot 2.');
    expect(target.hasAttribute('data-workbench-drop-state')).toBe(false);

    // @dnd-kit swallows the first click for 50 ms after a drag.
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    fireEvent.click(tab('Plot 2'));
    expect(rows().some((r) => r.includes('TEST:SINE'))).toBe(true);
  });

  it("in grid view, onto the plot's cell", () => {
    mount();
    fireEvent.click(screen.getByTitle('Grid view'));
    const [cell] = dropTargets();
    expect(cell.classList.contains('plot-grid__cell')).toBe(true);
    const at = cell.getBoundingClientRect();
    dragTo('TEST:FAST', at.left + 20, at.top + 10);

    expect(rows().some((r) => r.includes('TEST:FAST'))).toBe(false);
    expect(screen.getByText('Moved TEST:FAST to Plot 2')).toBeTruthy();
  });

  it('a drop outside every section and target moves nothing', () => {
    mount();
    dragTo('TEST:SINE', 150, 700);
    expect(rows().some((r) => r.includes('TEST:SINE'))).toBe(true);
    expect(screen.queryByText(/^Moved /)).toBeNull();
    expect(polite()).toBe('TEST:SINE not moved.');
  });

  it('a refused drop (a formula uses the curve) is marked, announced and moves nothing', () => {
    mount();
    // Open TEST:SINE's card and derive a formula from it: the formula binds it.
    fireEvent.click(rowNamed('TEST:SINE'));
    fireEvent.click(screen.getByRole('button', { name: /create formula from this curve/i }));
    const target = tab('Plot 2');
    const at = target.getBoundingClientRect();
    const r = rowNamed('TEST:SINE').getBoundingClientRect();
    fireEvent.pointerDown(rowNamed('TEST:SINE'), pointer(r.left + 100, r.top + 15));
    act(() => {
      fireEvent.pointerMove(document, pointer(r.left + 100, r.top + 25));
    });
    act(() => {
      fireEvent.pointerMove(document, pointer(at.left + 20, at.top + 10));
    });
    expect(target.getAttribute('data-workbench-drop-state')).toBe('refused');
    expect(target.getAttribute('title')).toBe(FORMULA_BINDS_REASON);
    act(() => {
      fireEvent.pointerUp(document, pointer(at.left + 20, at.top + 10));
    });
    expect(polite()).toBe(`TEST:SINE not moved: ${FORMULA_BINDS_REASON}`);
    expect(rows().some((row) => row.includes('TEST:SINE'))).toBe(true);
    expect(screen.queryByText(/^Moved /)).toBeNull();
    expect(target.hasAttribute('data-workbench-drop-state')).toBe(false);
  });

  it("moving the open card's curve away closes its card on the source plot", () => {
    mount();
    fireEvent.click(rowNamed('TEST:FAST'));
    expect(document.querySelector('.wb-card--open')?.textContent).toContain('TEST:FAST');
    const at = tab('Plot 2').getBoundingClientRect();
    dragTo('TEST:FAST', at.left + 20, at.top + 10);
    expect(rows().some((row) => row.includes('TEST:FAST'))).toBe(false);
    expect(document.querySelector('.wb-card--open')).toBeNull();
  });
});

describe('Move to plot in the signal menu (the keyboard path)', () => {
  /** Opens TEST:SINE's signal menu as the Menu key or Shift+F10 does: on the focused card. */
  function openMenuFromKeyboard(pv: string) {
    const head = rowNamed(pv);
    head.focus();
    const r = head.getBoundingClientRect();
    fireEvent.contextMenu(head, { clientX: r.left, clientY: r.top, button: 0 });
    return screen.getByRole('menuitem', { name: /Move to plot/ });
  }

  it('lists the other plots and moves the curve from the keyboard', () => {
    mount();
    const entry = openMenuFromKeyboard('TEST:SINE');
    entry.focus();
    fireEvent.keyDown(entry, { key: 'ArrowRight' });
    const plot2 = screen.getByRole('menuitem', { name: 'Plot 2' });
    expect(screen.queryByRole('menuitem', { name: 'Plot 1' })).toBeNull();
    plot2.focus();
    // Carbon activates a menu item on Enter's key-up.
    fireEvent.keyDown(plot2, { key: 'Enter' });
    fireEvent.keyUp(plot2, { key: 'Enter' });

    expect(rows().some((r) => r.includes('TEST:SINE'))).toBe(false);
    expect(screen.getByText('Moved TEST:SINE to Plot 2')).toBeTruthy();
    // The toast sits in a polite live region: the move is announced.
    const toast = screen.getByText('Moved TEST:SINE to Plot 2');
    expect(toast.closest('[aria-live="polite"]')).not.toBeNull();
  });

  it('a plot it cannot go to is listed disabled, with the reason', () => {
    mount();
    fireEvent.click(rowNamed('TEST:SINE'));
    fireEvent.click(screen.getByRole('button', { name: /create formula from this curve/i }));
    const entry = openMenuFromKeyboard('TEST:SINE');
    entry.focus();
    fireEvent.keyDown(entry, { key: 'ArrowRight' });
    const plot2 = screen.getByRole('menuitem', { name: `Plot 2: ${FORMULA_BINDS_REASON}` });
    expect(plot2.getAttribute('aria-disabled')).toBe('true');
    plot2.focus();
    // Carbon activates a menu item on Enter's key-up.
    fireEvent.keyDown(plot2, { key: 'Enter' });
    fireEvent.keyUp(plot2, { key: 'Enter' });
    fireEvent.click(plot2);
    expect(rows().some((r) => r.includes('TEST:SINE'))).toBe(true);
    expect(screen.queryByText(/^Moved /)).toBeNull();
  });
});
