// @vitest-environment jsdom
//
// A plot detached into its own browser window keeps the host theme of its
// opener. The popup is a real second jsdom window handed out by window.open,
// and the plot is detached through the app's own "Detach to window" button, so
// the popup root under test is the one TraceApp renders.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { JSDOM } from 'jsdom';
import { WithCanopy } from '../test/canopy';
import { setHostTheme } from '../state/colorMode';

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

import { TraceApp } from './TraceApp';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class InertWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {
    this.readyState = 3;
  }
  addEventListener() {}
  removeEventListener() {}
}

const OPENER_BACKGROUND = 'rgb(18, 52, 86)';
const SHEET_HREF = 'http://localhost:3000/host/adapter.css';

let popup: Window;
let warn: ReturnType<typeof vi.spyOn>;
const added: Element[] = [];

beforeEach(() => {
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
  vi.stubGlobal('WebSocket', InertWebSocket);

  popup = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: location.href,
  }).window as unknown as Window;
  vi.spyOn(window, 'open').mockReturnValue(popup);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  act(() => setHostTheme(null, 'dark'));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  for (const el of added.splice(0)) el.remove();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.canopyHost;
  document.body.style.background = '';
  window.history.replaceState(null, '', '/');
});

/** Mark the opener as hosted, the way canopy_mcp's entry page does. */
function hostOpener(): void {
  document.documentElement.dataset.canopyHost = '';
}

/** A host stylesheet link in the opener's head. */
function addHostSheet(): void {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = SHEET_HREF;
  link.setAttribute('data-canopy-host-sheet', '');
  document.head.appendChild(link);
  added.push(link);
}

/** Open the app and detach its one plot; cloned stylesheets are still loading. */
function detach(): void {
  window.history.replaceState(null, '', '/trace/');
  render(<TraceApp />, { wrapper: WithCanopy });
  fireEvent.click(screen.getByTitle('Detach to window'));
}

/** Let the stylesheet promise settle so the popup root mounts. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function popupAnchor(): HTMLElement {
  const found = popup.document.querySelectorAll<HTMLElement>('[data-canopy-host-root]');
  expect(found.length).toBe(1);
  return found[0];
}

function fallbackWarnings(): unknown[][] {
  return warn.mock.calls.filter((c: unknown[]) =>
    String(c[0]).includes('host stylesheet did not load')
  );
}

describe('detached plot window', () => {
  it('copies the host marker from a hosted opener', async () => {
    hostOpener();
    detach();
    expect(popup.document.documentElement.getAttribute('data-canopy-host')).toBe('');
    await settle();
    expect(popup.document.documentElement.getAttribute('data-canopy-host')).toBe('');
    expect(fallbackWarnings()).toEqual([]);
  });

  it('leaves the popup unmarked when the opener carries no host marker', async () => {
    detach();
    await settle();
    expect(popup.document.documentElement.hasAttribute('data-canopy-host')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('makes the popup root the host-theme anchor', async () => {
    detach();
    await settle();
    const el = popupAnchor();
    expect(el.tagName).toBe('DIV');
    expect(el.getAttribute('data-canopy-host-root')).toBe('');
    expect(el.getAttribute('data-floating-menu-container')).toBe('');
    expect(el.getAttribute('data-theme')).toBe('dark');
    expect(el.classList.contains('cds--g100')).toBe(true);
    expect(el.style.height).toBe('100vh');

    act(() => setHostTheme('retro-light', 'light'));
    expect(popupAnchor().getAttribute('data-theme')).toBe('retro-light');
    expect(popupAnchor().classList.contains('cds--g10')).toBe(true);
  });

  it('keeps the popup html[data-theme] on the colour mode across a flip', async () => {
    detach();
    await settle();
    expect(popup.document.documentElement.dataset.theme).toBe('dark');

    act(() => setHostTheme('retro-light', 'light'));
    expect(popup.document.documentElement.dataset.theme).toBe('light');

    act(() => setHostTheme('retro-dark', 'dark'));
    expect(popup.document.documentElement.dataset.theme).toBe('dark');
  });

  it("paints the popup body with the opener's background before styles load", async () => {
    document.body.style.background = OPENER_BACKGROUND;
    addHostSheet();
    detach();
    // The cloned link has not loaded: the root is not mounted yet.
    expect(popup.document.querySelector('[data-canopy-host-root]')).toBeNull();
    expect(popup.document.body.style.backgroundColor).toBe(OPENER_BACKGROUND);
    expect(getComputedStyle(document.body).backgroundColor).toBe(OPENER_BACKGROUND);
  });

  it('falls back to the standalone theme when the cloned host sheet is dead', async () => {
    hostOpener();
    addHostSheet();
    detach();
    expect(popup.document.documentElement.hasAttribute('data-canopy-host')).toBe(true);

    const clone = popup.document.head.querySelector<HTMLLinkElement>(
      'link[data-canopy-host-sheet]'
    );
    expect(clone).not.toBeNull();
    Object.defineProperty(clone, 'sheet', { value: { cssRules: [] }, configurable: true });
    clone!.dispatchEvent(new Event('load'));
    await settle();

    expect(popup.document.documentElement.hasAttribute('data-canopy-host')).toBe(false);
    // Only the popup falls back; the opener's own sheet state is its own.
    expect(document.documentElement.hasAttribute('data-canopy-host')).toBe(true);
    expect(fallbackWarnings().length).toBe(1);
    expect(String(fallbackWarnings()[0][0])).toContain(SHEET_HREF);
    // The marker was cleared before the root mounted, so the root is in place
    // and reads no host contract.
    expect(popupAnchor().getAttribute('data-theme')).toBe('dark');
    expect(warn.mock.calls.length).toBe(1);
  });
});
