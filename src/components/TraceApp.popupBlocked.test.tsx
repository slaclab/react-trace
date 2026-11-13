// @vitest-environment jsdom
//
// Mounts the whole TraceApp to pin issue 116: when the browser blocks the
// pop-up for a detached plot or the Data Insight pop-out, the user gets a
// toast saying so and how to allow pop-ups, instead of nothing happening.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { TraceApp } from './TraceApp';
import { WithCanopy } from '../test/canopy';

// No chart instance: PNG capture for the E-Log dialog skips this plot.
vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);

describe('Blocked pop-up notice', () => {
  beforeEach(() => {
    // jsdom lacks the layout APIs react-resizable-panels and Carbon call on mount.
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
    // No E-Log backend: the config probe fails and the feature stays off.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline')))
    );
    // The browser blocks every pop-up.
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('tells the user when detaching a plot is blocked', () => {
    render(<TraceApp />, { wrapper: WithCanopy });
    fireEvent.click(screen.getByTitle('Detach to window'));

    expect(screen.getByText('Pop-up blocked')).toBeTruthy();
    expect(screen.getByText(/Plot 1 couldn't open in a new window/)).toBeTruthy();
    expect(screen.getByText(/Allow pop-ups for this site/)).toBeTruthy();
    // The plot stays in the main window.
    expect(screen.getByTitle('Detach to window')).toBeTruthy();
  });

  it('still tells the user when the plot has no title', () => {
    render(<TraceApp />, { wrapper: WithCanopy });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '' } });
    fireEvent.click(screen.getByTitle('Detach to window'));

    expect(screen.getByText(/This plot couldn't open in a new window/)).toBeTruthy();
  });

  it('tells the user when popping out Data Insight is blocked', () => {
    render(<TraceApp />, { wrapper: WithCanopy });
    fireEvent.click(screen.getByRole('button', { name: /^Data Insight/ }));
    fireEvent.click(screen.getByTitle('Pop out to window'));

    expect(screen.getByText(/Data Insight couldn't open in a new window/)).toBeTruthy();
    // Data Insight is docked again.
    expect(screen.getByTitle('Pop out to window')).toBeTruthy();
  });
});
