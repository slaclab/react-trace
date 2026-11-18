// @vitest-environment jsdom
//
// A plot renamed from its tab is the same title Display's Title field edits:
// the tab shows the new name and the field holds it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TraceApp } from './TraceApp';
import { chartStub } from '../test/chartStub';
import { WithCanopy } from '../test/canopy';

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);
chartStub.instance = {
  getWidth: () => 800,
  getHeight: () => 400,
  isDisposed: () => false,
  getZr: () => ({ setCursorStyle: () => {}, on: () => {}, off: () => {} }),
  getModel: () => null,
  convertToPixel: () => 0,
  convertFromPixel: () => 0,
  getDataURL: () => '',
  getDom: () => document.createElement('div'),
  resize: () => {},
  dispatchAction: () => {},
  on: () => {},
  off: () => {},
};

beforeEach(() => {
  // jsdom lacks these; Carbon and the resizable panels call them on mount.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  // No backend: every request fails.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('no backend')))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('renaming a plot from its tab', () => {
  it('renames the plot: the tab and the Display Title field show the new name', () => {
    render(<TraceApp />, { wrapper: WithCanopy });
    const name = screen.getByTitle('Double-click to rename');
    const before = name.textContent!;
    act(() => {
      fireEvent.doubleClick(name);
    });
    const input = screen.getByRole('textbox', { name: 'Plot name' });
    act(() => {
      fireEvent.change(input, { target: { value: 'Beam current' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(screen.queryByText(before, { selector: '.plot-tab__name' })).toBeNull();
    expect(screen.getByTitle('Double-click to rename').textContent).toBe('Beam current');

    const display = document.querySelector<HTMLElement>(
      '.wb-plot-section[data-section="display"] .wb-plot-section__head'
    );
    if (!display) throw new Error('no Display section');
    act(() => {
      fireEvent.click(display);
    });
    expect((document.getElementById('plot-title') as HTMLInputElement).value).toBe('Beam current');
  });
});
