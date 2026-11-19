// @vitest-environment jsdom
//
// Trace's PV name field searches the way main's did: what the user types is
// a glob (`*` any run, `?` one character) turned into an unanchored regex
// (`toSearchRegex`), so `TEST:SI*` finds TEST:SINE. The stack sent text with a
// `.` or `*` raw, which the archiver matched against the whole name: `TEST:SI*`
// meant "TEST:S then any number of I" and found nothing. The search reads the
// archiver it is given (the curve's own, else its plot's) with the PV
// fields' limit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createFakeFetch, jsonResponse } from '@slaclab/canopy-client/testing';
import { canopyConnection } from '../../../api/connection';
import { MOLE_SEARCH_LIMIT, resetChannelCatalog, toSearchRegex } from '../../../pvSearch';
import { PvNameControl } from './pvName';

beforeEach(() => resetChannelCatalog());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetChannelCatalog();
});

function stubMole(pvs: string[]) {
  // Unrouted /channels answers 404: no catalog, Mole's hits alone.
  const fetch = createFakeFetch(
    { 'GET /mole/v1/search': jsonResponse({ archiver: 'arch-b', pattern: '', pvs }) },
    { baseUrl: canopyConnection.baseUrl }
  );
  vi.stubGlobal('fetch', fetch);
  return () => fetch.calls.filter((c) => c.path === '/mole/v1/search');
}

function typeInto(text: string) {
  render(<PvNameControl value="" archiver="arch-b" onChange={vi.fn()} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'PV name' }), {
    target: { value: text },
  });
}

describe('PvNameControl search request', () => {
  it('turns a glob into an unanchored regex, as main did', async () => {
    const searches = stubMole(['TEST:SINE']);
    typeInto('TEST:SI*');
    await waitFor(() => expect(searches()).toHaveLength(1));
    const { pattern, archiver, limit } = searches()[0].query;
    expect(pattern).toBe(toSearchRegex('TEST:SI*'));
    expect(new RegExp(`^(?:${pattern})$`).test('TEST:SINE')).toBe(true);
    expect(new RegExp(`^(?:${pattern})$`).test('DEMO:TEST:SINE:RATE')).toBe(true);
    expect({ archiver, limit }).toEqual({ archiver: 'arch-b', limit: String(MOLE_SEARCH_LIMIT) });
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['TEST:SINE'])
    );
  });

  it("matches a fragment anywhere and keeps an explicit regex's meaning", async () => {
    const searches = stubMole([]);
    typeInto('SINE');
    await waitFor(() => expect(searches()).toHaveLength(1));
    const fragment = searches()[0].query.pattern;
    expect(new RegExp(`^(?:${fragment})$`).test('TEST:SINE')).toBe(true);
    cleanup();
    const again = stubMole([]);
    typeInto('^TEST:.*');
    await waitFor(() => expect(again()).toHaveLength(1));
    const anchored = again()[0].query.pattern;
    expect(new RegExp(`^(?:${anchored})$`).test('TEST:SINE')).toBe(true);
    expect(new RegExp(`^(?:${anchored})$`).test('DEMO:TEST:SINE')).toBe(false);
  });
});
