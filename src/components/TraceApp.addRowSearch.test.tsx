// @vitest-environment jsdom
//
// The Signals pane's Add PV row searches the way main's PV name field did: a
// typed glob becomes an unanchored regex (`toSearchRegex`), on the active
// plot's archiver. The stack sent text with a `.` or `*` raw, so `TEST:SI*`
// found nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createFakeFetch, jsonResponse } from '@slaclab/canopy-client/testing';
import { resetHarness } from '../test/traceAppHarness';
import { WithCanopy } from '../test/canopy';
import { canopyConnection } from '../api/connection';
import { resetChannelCatalog, toSearchRegex } from '../pvSearch';
import { TESTIDS } from '../workbench/testids';
import { TraceApp } from './TraceApp';

vi.mock('./PlotArea', async (importOriginal) =>
  (await import('../test/traceAppHarness')).mocks.PlotArea(await importOriginal())
);
vi.mock(
  '../hooks/useElogConfig',
  async () => (await import('../test/traceAppHarness')).mocks.useElogConfig
);

beforeEach(() => {
  resetHarness();
  resetChannelCatalog();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetChannelCatalog();
});

describe('the Add PV row search', () => {
  it('turns a typed glob into an unanchored regex', async () => {
    const fetch = createFakeFetch(
      { 'GET /mole/v1/search': jsonResponse({ archiver: '', pattern: '', pvs: ['TEST:SINE'] }) },
      { baseUrl: canopyConnection.baseUrl }
    );
    vi.stubGlobal('fetch', fetch);
    const { container } = render(<TraceApp />, { wrapper: WithCanopy });
    const input = container.querySelector<HTMLInputElement>(
      `[data-testid="${TESTIDS.outlineAddInput}"]`
    )!;
    expect(input).not.toBeNull();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'TEST:SI*' } });
    const searches = () => fetch.calls.filter((c) => c.path === '/mole/v1/search');
    await waitFor(() => expect(searches().length).toBeGreaterThan(0));
    const pattern = searches().at(-1)!.query.pattern;
    expect(pattern).toBe(toSearchRegex('TEST:SI*'));
    expect(new RegExp(`^(?:${pattern})$`).test('TEST:SINE')).toBe(true);
  });
});
