// @vitest-environment jsdom
//
// Decision C8, pinned so it is not "fixed" later: in the fullscreen plot,
// Escape peels one layer at a time. With a drawing tool armed, the first press
// disarms the tool and leaves fullscreen open (the plot keymap claims it); the
// next press leaves fullscreen. Main had no drawing tools, so its one press
// always closed fullscreen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TraceApp } from './TraceApp';
import { WithCanopy } from '../test/canopy';

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fullscreenPlot = () => document.querySelector<HTMLElement>('[data-fullscreen]');

function pressEscape(target: Element) {
  act(() => {
    fireEvent.keyDown(target, { key: 'Escape', code: 'Escape', keyCode: 27 });
  });
}

describe('Escape in fullscreen with a drawing tool armed (C8)', () => {
  it('the first press disarms the tool, the next leaves fullscreen', () => {
    render(<TraceApp />, { wrapper: WithCanopy });
    fireEvent.click(screen.getByTitle('Fullscreen'));
    const plot = fullscreenPlot();
    expect(plot).not.toBeNull();

    // Arm a tool from the fullscreen copy's rail.
    const rail = within(plot!).getByRole('toolbar', { name: 'Drawing tools' });
    const tool = rail.querySelector<HTMLButtonElement>('[data-drawing-tool]')!;
    act(() => {
      fireEvent.click(tool);
    });
    const armed = () =>
      fullscreenPlot()
        ?.querySelector(`[data-drawing-tool="${tool.dataset.drawingTool}"]`)
        ?.getAttribute('aria-pressed');
    expect(armed()).toBe('true');

    plot!.focus();
    pressEscape(plot!);
    expect(armed()).toBe('false');
    expect(fullscreenPlot()).not.toBeNull();

    pressEscape(fullscreenPlot()!);
    expect(fullscreenPlot()).toBeNull();
  });
});
