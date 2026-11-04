// @vitest-environment jsdom
//
// Embedded (`?embedded=true`) the host owns the theme, so Trace's own toggle
// is not rendered and its keyboard shortcut does nothing. Standalone both
// still flip the theme store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { getColorMode } from '@slaclab/canopy-shell/color-mode';
import { WithCanopy } from '../test/canopy';
import { TraceApp } from './TraceApp';

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  const fakeInstance = {
    getWidth: () => 800,
    getHeight: () => 400,
    isDisposed: () => false,
    getZr: () => ({ setCursorStyle: () => {}, on: () => {}, off: () => {} }),
    getModel: () => null,
    convertToPixel: () => 0,
    convertFromPixel: () => 0,
    getDataURL: () => '',
    resize: () => {},
    dispatchAction: () => {},
    on: () => {},
    off: () => {},
  };
  class MockECharts extends React.Component {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

const TOGGLE_NAME = /switch to (light|dark) mode/i;

function setEmbedded(on: boolean) {
  window.history.replaceState(null, '', on ? '/trace/?embedded=true' : '/');
}

// `code` makes the event resolve the same way on every platform.
function pressThemeShortcut() {
  act(() => {
    fireEvent.keyDown(window, { key: 't', code: 'KeyT', altKey: true });
  });
}

// jsdom lacks the layout APIs Carbon and react-resizable-panels touch on mount.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {}))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setEmbedded(false);
  window.localStorage.clear();
});

describe('theme toggle when embedded', () => {
  it('is not rendered', () => {
    setEmbedded(true);
    render(<TraceApp />, { wrapper: WithCanopy });
    // The rest of the actions bar is there, so the query is looking at a mounted bar.
    expect(screen.getByRole('button', { name: /^import/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: TOGGLE_NAME })).toBeNull();
  });

  it('leaves the theme store alone on the keyboard shortcut', () => {
    setEmbedded(true);
    render(<TraceApp />, { wrapper: WithCanopy });
    const before = getColorMode();
    pressThemeShortcut();
    expect(getColorMode()).toBe(before);
  });
});

describe('theme toggle standalone', () => {
  it('is rendered and flips the theme store on click', () => {
    render(<TraceApp />, { wrapper: WithCanopy });
    const before = getColorMode();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: TOGGLE_NAME }));
    });
    expect(getColorMode()).not.toBe(before);
  });

  it('flips the theme store on the keyboard shortcut', () => {
    render(<TraceApp />, { wrapper: WithCanopy });
    const before = getColorMode();
    pressThemeShortcut();
    expect(getColorMode()).not.toBe(before);
  });
});
