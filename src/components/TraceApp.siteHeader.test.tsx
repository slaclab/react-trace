// @vitest-environment jsdom
//
// The site's header (src/site): Trace's standalone heading shows the site's
// prefix before "Trace", in the shell's brand colour when the site says so;
// embedded, the counter alone, as without one. Every tool's help links are
// the site's, the build's when the site sets none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook } from '@testing-library/react';
import { resetHarness } from '../test/traceAppHarness';
import { WithCanopy } from '../test/canopy';
import { traceHeading } from '../tools/trace/header';
import {
  BUG_REPORT_URL,
  DOCS_URL,
  useStandardActionsOptions,
} from '../tools/standardActionsOptions';
import { resetSiteDefaults } from '../site/store';
import { setSiteConfig } from '../site/testing';
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

const headingEl = () => document.querySelector<HTMLElement>('.wb-workbench__heading');
const nameEl = () => headingEl()?.querySelector('.wb-workbench__name') ?? null;

function mountAt(search: string) {
  window.history.replaceState(null, '', `/${search}`);
  render(<TraceApp />, { wrapper: WithCanopy });
}

beforeEach(() => {
  resetHarness();
  vi.stubGlobal('WebSocket', undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetSiteDefaults();
  window.history.replaceState(null, '', '/');
});

describe('the heading with a site header', () => {
  it('shows the site’s prefix before the name, in the brand colour', () => {
    setSiteConfig({ header: { prefix: 'Lab', brand: true } });
    mountAt('');
    expect(headingEl()?.querySelector('.wb-workbench__prefix')?.textContent).toBe('Lab');
    expect(nameEl()?.textContent).toBe('LabTrace');
    expect(nameEl()?.classList.contains('wb-workbench__name--brand')).toBe(true);
  });

  it('is neutral and unbranded with the built-ins', () => {
    mountAt('');
    expect(headingEl()?.querySelector('.wb-workbench__prefix')).toBeNull();
    expect(nameEl()?.classList.contains('wb-workbench__name--brand')).toBe(false);
  });

  it('names nothing embedded, whatever the site says', () => {
    setSiteConfig({ header: { prefix: 'Lab', brand: true } });
    expect(traceHeading({ traces: [] }, true)).toEqual({ status: '0 Live • 0 Archive' });
    expect(traceHeading({ traces: [] }, false)).toEqual({
      prefix: 'Lab',
      name: 'Trace',
      status: '0 Live • 0 Archive',
      brand: true,
    });
  });
});

describe('the help links', () => {
  it('are the build’s with the built-ins, and the site’s when it sets them', () => {
    const built = renderHook(() => useStandardActionsOptions('light')).result.current;
    expect(built.bugUrl).toBe(BUG_REPORT_URL);
    expect(built.docsUrl).toBe(DOCS_URL);
    setSiteConfig({
      header: { bugReportUrl: 'https://example.org/bugs', docsUrl: 'https://example.org/docs/' },
    });
    const site = renderHook(() => useStandardActionsOptions('light')).result.current;
    expect(site.bugUrl).toBe('https://example.org/bugs');
    expect(site.docsUrl).toBe('https://example.org/docs/');
  });
});
