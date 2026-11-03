// @vitest-environment jsdom
//
// Mounts the whole TraceApp to pin issue 111: Escape closes the fullscreen
// plot overlay, but a dialog opened on top of it (Post to E-Log, a Carbon
// ComposedModal) takes that Escape first and leaves the overlay open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { TraceApp } from './TraceApp';
import { WithCanopy } from '../test/canopy';

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component {
    getEchartsInstance() {
      // No DOM: PNG capture for the E-Log dialog skips this plot.
      return { isDisposed: () => true, getDom: () => null };
    }
    render() {
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

// E-Log configured, so the Post to E-Log button is shown.
vi.mock('../hooks/useElogConfig', () => ({
  useElogConfig: () => ({ enabled: true, logbooks: [], defaultLogbooks: [] }),
}));

const fullscreenPlot = () => document.querySelector('[data-fullscreen]');
const visibleModal = () => document.querySelector('.cds--modal.is-visible');
const pressEscape = () =>
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
  });

describe('Fullscreen plot overlay', () => {
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
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('closes on Escape', () => {
    render(<TraceApp />, { wrapper: WithCanopy });
    fireEvent.click(screen.getByTitle('Fullscreen'));
    expect(fullscreenPlot()).not.toBeNull();

    pressEscape();
    expect(fullscreenPlot()).toBeNull();
  });

  it('lets a dialog opened on top take the first Escape', () => {
    render(<TraceApp />, { wrapper: WithCanopy });
    fireEvent.click(screen.getByTitle('Fullscreen'));
    fireEvent.click(screen.getByRole('button', { name: /Post to E-Log/ }));
    expect(visibleModal()).not.toBeNull();

    pressEscape();
    expect(visibleModal()).toBeNull();
    expect(fullscreenPlot()).not.toBeNull();

    pressEscape();
    expect(fullscreenPlot()).toBeNull();
  });
});
