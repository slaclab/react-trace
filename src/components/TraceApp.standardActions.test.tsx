// @vitest-environment jsdom
//
// Main's TraceHeader cases that still apply, on the workbench actions bar:
// the theme toggle flips the shared colour mode, persists it under
// trace.theme, repaints <html> and relabels itself; Report a bug and Docs
// open Trace's links (the repository's by default, or the deployment's
// VITE_BUG_REPORT_URL / VITE_DOCS_URL) in a new tab without an opener.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
// Before TraceApp: the harness installs the browser stubs the stores read.
import { resetHarness } from '../test/traceAppHarness';
import { WithCanopy } from '../test/canopy';
import { setupColorMode } from '../state/colorMode';
import { formatShortcut } from '../workbench/useCanvasActions';
import { THEME_SHORTCUT } from '../workbench/standardActions';
import { BUG_REPORT_URL, DOCS_URL } from '../tools/standardActionsOptions';
import { TraceApp } from './TraceApp';

vi.mock('@slaclab/canopy-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slaclab/canopy-client')>()),
  fetchData: () => new Promise(() => {}),
  fetchMetadata: () => new Promise(() => {}),
  listArchivers: () => new Promise(() => {}),
  searchPVs: () => new Promise(() => {}),
}));
vi.mock('./PlotArea', async (importOriginal) =>
  (await import('../test/traceAppHarness')).mocks.PlotArea(await importOriginal())
);
vi.mock('../workbench/WorkbenchLayout', async (importOriginal) =>
  (await import('../test/traceAppHarness')).mocks.WorkbenchLayout(await importOriginal())
);
vi.mock(
  '../hooks/useElogConfig',
  async () => (await import('../test/traceAppHarness')).mocks.useElogConfig
);
vi.mock('../io/download', async () => (await import('../test/traceAppHarness')).mocks.download);

const toolbar = () => screen.getByRole('toolbar', { name: 'Tool actions' });
const hint = formatShortcut(THEME_SHORTCUT);

beforeEach(() => {
  // Standalone (no `embedded`): embedded, the host owns the theme and Trace has no toggle.
  window.history.replaceState(null, '', '/');
  resetHarness(); // clears localStorage: nothing stored
  vi.stubGlobal('WebSocket', undefined);
  document.documentElement.className = '';
  delete document.documentElement.dataset.theme;
  // Trace's store under trace.theme; nothing stored, so dark.
  setupColorMode();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

function mount() {
  render(<TraceApp />, { wrapper: WithCanopy });
}

describe("Trace's theme toggle", () => {
  it('toggles the shared color mode and persists it under trace.theme', () => {
    mount();
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.click(
      within(toolbar()).getByRole('button', { name: `Switch to light mode (${hint})` })
    );
    expect(window.localStorage.getItem('trace.theme')).toBe('light');
    expect(document.documentElement.classList.contains('cds--g10')).toBe(true);
    expect(document.documentElement.classList.contains('cds--g100')).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(
      within(toolbar()).getByRole('button', { name: `Switch to dark mode (${hint})` })
    ).toBeTruthy();
  });
});

describe('Report a bug and Docs', () => {
  it("default to the repository's issue chooser and docs site", () => {
    expect(BUG_REPORT_URL).toBe(
      (import.meta.env.VITE_BUG_REPORT_URL as string | undefined) ||
        'https://github.com/slaclab/react-trace/issues/new/choose'
    );
    expect(DOCS_URL).toBe(
      (import.meta.env.VITE_DOCS_URL as string | undefined) ||
        'https://slaclab.github.io/react-trace/'
    );
  });

  it("open Trace's links in a new tab without an opener", () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mount();
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Report a bug' }));
    fireEvent.click(within(toolbar()).getByRole('button', { name: 'Docs' }));
    expect(open).toHaveBeenNthCalledWith(1, BUG_REPORT_URL, '_blank', 'noopener,noreferrer');
    expect(open).toHaveBeenNthCalledWith(2, DOCS_URL, '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });
});
