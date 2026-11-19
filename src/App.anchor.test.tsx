// @vitest-environment jsdom
//
// The three page roots as theming anchors: the Carbon <Theme> element of the
// main app, the correlation page and the waveform page carries the host-theme attributes, and
// a Carbon floating menu opened below it is portalled into it, not into
// <body>, so it stays inside the themed subtree.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { HareConnectionStatus } from '@slaclab/canopy-client';
import { getColorMode } from '@slaclab/canopy-shell/color-mode';
import { setHostTheme } from './state/colorMode';
import { WithCanopy } from './test/canopy';
import { FakeHare } from './tools/shared/fakeHare.test-util';
import type { FormulaEngineFactory, FormulaEngineTableService } from './tools/correlation/useTable';

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

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component<{ className?: string }> {
    getEchartsInstance() {
      return { getDataURL: () => 'data:image/png;base64,AAAA' };
    }
    render() {
      return React.createElement('div', { className: this.props.className });
    }
  }
  return { default: MockECharts };
});

// The waveform Plot drives ECharts directly (not through echarts-for-react).
vi.mock('echarts', () => ({
  init: () => ({
    setOption: () => {},
    resize: () => {},
    dispose: () => {},
    getDataURL: () => 'data:image/png;base64,AAAA',
  }),
}));

const { default: App } = await import('./App');
const { CorrelationApp } = await import('./tools/correlation/App');
const { WaveformApp } = await import('./tools/waveform/App');

class Hare extends FakeHare {
  status: HareConnectionStatus = 'connected';
}

const engine: FormulaEngineTableService = {
  status: 'connected',
  connect() {},
  dispose() {},
  subscribe: () => () => {},
};
const createFormulaEngine: FormulaEngineFactory = () => engine;
const search = async () => [] as string[];

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

describe('correlation app root', () => {
  function mount(): void {
    window.history.replaceState(null, '', '/correlation.html');
    render(
      <CorrelationApp
        hare={new Hare()}
        createFormulaEngine={createFormulaEngine}
        search={search}
      />,
      { wrapper: WithCanopy }
    );
  }

  it('standalone, the theme zone is the anchor and wraps the page', () => {
    mount();
    const el = anchor();
    expectAnchor(el, getColorMode());
    expectZone(el);
    expect(el.contains(screen.getByTestId('correlation-app'))).toBe(true);
  });

  it('carries the host theme id while the Carbon zone follows the mode', () => {
    mount();
    act(() => setHostTheme('retro-light', 'light'));
    const el = anchor();
    expectAnchor(el, 'retro-light');
    expect(el.classList.contains('cds--g10')).toBe(true);
  });
});

describe('waveform app root', () => {
  function mount(): void {
    window.history.replaceState(null, '', '/waveform.html');
    render(<WaveformApp hare={new Hare()} />, { wrapper: WithCanopy });
  }

  it('standalone, the theme zone is the anchor and wraps the page', () => {
    mount();
    const el = anchor();
    expectAnchor(el, getColorMode());
    expectZone(el);
    expect(el.contains(screen.getByTestId('waveform-app'))).toBe(true);
  });

  it('carries the host theme id while the Carbon zone follows the mode', () => {
    mount();
    act(() => setHostTheme('retro-dark', 'dark'));
    const el = anchor();
    expectAnchor(el, 'retro-dark');
    expect(el.classList.contains('cds--g100')).toBe(true);
    expect(el.classList.contains('cds--g10')).toBe(false);
  });
});
