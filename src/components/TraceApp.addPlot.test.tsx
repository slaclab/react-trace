// @vitest-environment jsdom
//
// Mounts the whole TraceApp to pin issue 110: adding a plot must select the
// new plot's settings, so the selection, the active plot and the properties
// panel agree. Adding a plot activates it, and activating a plot resets the
// workbench selection to the tool level, which is that plot's settings.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { TraceApp } from './TraceApp';
import { WithCanopy } from '../test/canopy';

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component {
    getEchartsInstance() {
      return { isDisposed: () => true };
    }
    render() {
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

// The plot-wide sections of the properties panel start closed.
function openPlotSection(id: string) {
  const head = document.querySelector<HTMLElement>(
    `.wb-plot-section[data-section="${id}"] .wb-plot-section__head`
  );
  if (!head) throw new Error(`no plot section ${id}`);
  fireEvent.click(head);
}

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
    // Select an axis of Plot 1: Add axis selects the axis it creates, which
    // the Axes section marks. (The initial selection is already the tool
    // level, which the panel renders for whichever plot is active.)
    fireEvent.click(screen.getByRole('button', { name: /add axis/i }));
    expect(container.querySelector('.wb-axes-block--selected')).not.toBeNull();

    fireEvent.click(screen.getByTitle('Add plot'));

    // The panel shows Plot 2's settings, and nothing of Plot 1 stays selected.
    expect(container.querySelector('.wb-axes-block--selected')).toBeNull();
    expect(container.querySelector('.wb-card--open')).toBeNull();
    expect(
      container.querySelectorAll('[aria-label="Plot properties"] .wb-plot-section')
    ).toHaveLength(4);
    openPlotSection('display');
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Plot 2');
    expect(container.querySelectorAll('[data-section-id]')).toHaveLength(1);
  });
});
