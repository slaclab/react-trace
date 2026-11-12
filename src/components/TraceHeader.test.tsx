// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ColorModeTheme } from '@slaclab/canopy-shell';
import { memoryStorage, stubCarbonDom } from '../test/dom';
import { setupColorMode } from '../state/colorMode';
import { formatShortcut } from '../hooks/useKeyboardShortcuts';
import { TraceHeader } from './TraceHeader';
import { Toolbar } from './Toolbar';

stubCarbonDom();

let storage: Storage;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  setupColorMode(); // nothing stored: dark
});

// No `test.globals`, so @testing-library/react's auto-cleanup never registers.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderHeader({ elog = false } = {}) {
  const noop = () => {};
  return render(
    <ColorModeTheme>
      <TraceHeader
        liveCount={2}
        archiveCount={1}
        actions={
          <Toolbar
            onSave={noop}
            onPrint={noop}
            onImport={noop}
            onExport={noop}
            onExportImage={noop}
            onOpenDataInsight={noop}
            onRefreshArchive={noop}
            onOpenConfigStore={noop}
            onPostElog={elog ? noop : undefined}
          />
        }
      />
    </ColorModeTheme>
  );
}

function headerButtonLabels(): string[] {
  return within(screen.getByRole('banner'))
    .queryAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
}

describe('TraceHeader', () => {
  it('renders the SLAC-branded name and the live/archive counts', () => {
    const { container } = renderHeader();
    expect(screen.getByRole('banner').getAttribute('aria-label')).toBe('Trace');
    expect(container.querySelector('.cds--header__name--prefix')?.textContent).toBe('SLAC');
    expect(container.querySelector('.canopy-header__name')?.textContent).toContain('Trace');
    expect(screen.getByText('2 Live • 1 Archive')).toBeDefined();
  });

  it('puts trace actions first, then theme toggle, bug report and docs', () => {
    renderHeader();
    expect(headerButtonLabels()).toEqual([
      'Refresh archive data',
      `Data Insight (${formatShortcut('alt', 'D')})`,
      `Save (${formatShortcut('primary', 'S')})`,
      'Config store (save / share workspace)',
      `Print (${formatShortcut('primary', 'P')})`,
      `Import (${formatShortcut('primary', 'O')})`,
      'Export CSV',
      `Export PNG (${formatShortcut('primary', 'I')})`,
      `Switch to light mode (${formatShortcut('alt', 'T')})`,
      'Report a bug',
      'Docs',
    ]);
  });

  it('shows the E-Log action only when e-log is configured', () => {
    renderHeader({ elog: true });
    expect(headerButtonLabels()).toContain(`Post to E-Log (${formatShortcut('primary', 'E')})`);
  });

  it('toggles the shared color mode and persists it under trace.theme', () => {
    renderHeader();
    fireEvent.click(
      screen.getByRole('button', { name: `Switch to light mode (${formatShortcut('alt', 'T')})` })
    );
    expect(storage.getItem('trace.theme')).toBe('light');
    expect(document.documentElement.classList.contains('cds--g10')).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(
      screen.getByRole('button', { name: `Switch to dark mode (${formatShortcut('alt', 'T')})` })
    ).toBeDefined();
  });

  it('opens the bug report and the docs in a new tab', () => {
    // The defaults; VITE_BUG_REPORT_URL and VITE_DOCS_URL are unset in tests.
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
    expect(open).toHaveBeenNthCalledWith(
      1,
      'https://github.com/slaclab/react-trace/issues/new/choose',
      '_blank',
      'noopener,noreferrer'
    );
    expect(open).toHaveBeenNthCalledWith(
      2,
      'https://slaclab.github.io/react-trace/',
      '_blank',
      'noopener,noreferrer'
    );
  });
});
