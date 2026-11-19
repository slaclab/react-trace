// toSearchRegex: the regex the Search PVs dialog sends Mole for what the user
// typed. The Archiver Appliance matches it against the whole PV name, so a
// glob becomes an unanchored regex. moleSearch sends it only when asked
// (`toPattern`); the PV fields keep moleSearchPattern.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moleSearch, toSearchRegex } from './mole';

describe('toSearchRegex', () => {
  it.each([
    ['SIM', '.*(?:SIM).*'],
    ['  SIM  ', '.*(?:SIM).*'],
    ['SIM:BPM2*:X', '.*(?:SIM:BPM2.*:X).*'],
    ['SIM:BPM2%:X', '.*(?:SIM:BPM2.*:X).*'],
    ['SIM:BPM2?:X', '.*(?:SIM:BPM2.:X).*'],
    ['SIM.*', '.*(?:SIM.*)'],
    ['^SIM', '(?:^SIM).*'],
    ['VAL$', '.*(?:VAL$)'],
    ['SIM:BPM2[0-9]:', '.*(?:SIM:BPM2[0-9]:).*'],
    ['SIM|TEST', '.*(?:SIM|TEST).*'],
    // Regex group prefixes survive; `?*` means one character then any.
    ['^SIM(?:A|B).*$', '(?:^SIM(?:A|B).*$)'],
    ['SIM:BPM2?*:X', '.*(?:SIM:BPM2..*:X).*'],
    // An escaped wildcard character stays literal.
    ['SIM\\*', '.*(?:SIM\\*).*'],
    ['SIM\\?A', '.*(?:SIM\\?A).*'],
    ['SIM\\.*', '.*(?:SIM\\..*)'],
    // An end of the text belongs to one branch of a top-level alternation, so
    // a wildcard or anchor there does not stand in for the wrap.
    ['SIM|TEST*', '.*(?:SIM|TEST.*).*'],
    ['*SIM|TEST', '.*(?:.*SIM|TEST).*'],
    ['^SIM|TEST', '.*(?:^SIM|TEST).*'],
    ['SIM|TEST$', '.*(?:SIM|TEST$).*'],
    // Not top level: inside a group, a character class, or escaped.
    ['^SIM(A|B)$', '(?:^SIM(A|B)$)'],
    ['^SIM[|]A', '(?:^SIM[|]A).*'],
    ['^SIM\\|A', '(?:^SIM\\|A).*'],
  ])('%j becomes %j', (text, regex) => {
    expect(toSearchRegex(text)).toBe(regex);
  });

  // The Appliance matches the regex against the whole PV name.
  it.each([
    ['SIM|TEST*', 'SIM:BPM21:X'],
    ['SIM|TEST*', 'TEST:BPM21:X'],
    ['^SIM|TEST', 'X:TEST:1'],
    ['^SIM|TEST', 'SIM:1'],
    ['SIM|TEST$', 'SIM:1'],
  ])('%j full-matches %j', (text, pv) => {
    expect(new RegExp(`^(?:${toSearchRegex(text)})$`).test(pv)).toBe(true);
  });

  it('keeps an anchor meaningful within its alternation branch', () => {
    expect(new RegExp(`^(?:${toSearchRegex('^SIM|TEST')})$`).test('X:SIM:1')).toBe(false);
  });
});

describe('moleSearch with toSearchRegex', () => {
  afterEach(() => vi.unstubAllGlobals());

  // The request the Search PVs dialog makes: Mole's search under the page's
  // base, with the converted pattern, the archiver and the dialog's limit.
  it('sends the converted pattern, the archiver and the limit to Mole', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ archiver: 'arch-a', pattern: 'x', pvs: ['SIM:BPM'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const search = moleSearch({ archiver: 'arch-a', limit: 25, toPattern: toSearchRegex });
    await expect(search('BPM*')).resolves.toEqual(['SIM:BPM']);
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]), 'http://page.test');
    expect(url.pathname.endsWith('/mole/v1/search')).toBe(true);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      pattern: '.*(?:BPM.*)',
      archiver: 'arch-a',
      limit: '25',
    });
  });
});
