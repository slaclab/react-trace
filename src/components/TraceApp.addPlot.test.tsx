// @vitest-environment jsdom
//
// Mounts the whole TraceApp to pin issue 110: adding a plot must select the
// new plot's Plot Settings, so the selection, the active plot and the
// Properties panel agree instead of Properties falling back to its empty state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { TraceApp } from './TraceApp';
import { WithCanopy } from '../test/canopy';

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);

const EMPTY_PROPERTIES = 'Select a trace, axis, or plot to view properties.';

describe('Add plot', () => {
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
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("selects the new plot's settings in grid view", () => {
    const { container } = render(<TraceApp />, { wrapper: WithCanopy });
    fireEvent.click(screen.getByTitle('Grid view'));
    // Select Plot 1's axis. (The initial selection is already a plot, which
    // Properties renders for whichever plot is active.)
    fireEvent.click(screen.getByText('Y-Axis 1'));
    expect(container.querySelector('.axis-section__header--selected')).not.toBeNull();

    fireEvent.click(screen.getByTitle('Add plot'));

    expect(screen.queryByText(EMPTY_PROPERTIES)).toBeNull();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Plot 2');
    // Layers no longer highlights Plot 1's axis; Plot 2's settings row is selected.
    expect(container.querySelector('.axis-section__header--selected')).toBeNull();
    const selected = container.querySelectorAll('.plot-settings-row--selected');
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain('Plot 2');
  });
});
