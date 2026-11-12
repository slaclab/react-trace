// Pins the Waveform link format v1 (without drawings): each recorded link in
// __fixtures__/waveform-links.json decodes to the recorded state over its base
// fields (`baseOf`: added fields pass) and re-encodes byte for byte, and each recorded input state serializes to exactly that link,
// including the over-budget states that exercise the shedding levels (labels,
// then the whole plot, then trailing Live PVs; never ref or xs). Fields added
// later take their defaults when the base state is replayed.
// A fixture is never edited to make a refactor pass.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseOf } from '../../test/fixtureBase';
import raw from './__fixtures__/waveform-links.json?raw';
import {
  defaultWaveformState,
  MAX_QUERY_BYTES,
  parseWaveformQuery,
  serializeWaveformQuery,
  type WaveformState,
} from './query';

interface LinkFixture {
  name: string;
  /** The input state the link was serialized from (base fields only). */
  state: Partial<WaveformState>;
  query: string;
  parsed: WaveformState;
}

const CASES = (JSON.parse(raw) as { cases: LinkFixture[] }).cases;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const replay = (base: Partial<WaveformState>): WaveformState => ({
  ...defaultWaveformState(),
  ...base,
});

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('Waveform links (base fixtures)', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(bytes(c.query)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    const parsed = parseWaveformQuery(c.query);
    expect(baseOf(parsed, c.parsed)).toEqual(c.parsed);
    expect(serializeWaveformQuery(parsed)).toBe(c.query);

    warn.mockClear();
    expect(serializeWaveformQuery(replay(c.state))).toBe(c.query);
    // An over-budget input sheds (one warning); every other input fits as is.
    expect(warn).toHaveBeenCalledTimes(c.name.startsWith('over budget') ? 1 : 0);
  });

  it('covers both shedding levels and keeps ref and xs', () => {
    const shed = CASES.filter((c) => c.name.startsWith('over budget'));
    const params = shed.map((c) => new URLSearchParams(c.query));
    // Labels shed, styles kept.
    expect(
      params.some(
        (p) =>
          p.get('plot') !== null && p.get('xl') === null && !p.get('plot')!.includes('displayName')
      )
    ).toBe(true);
    // The whole plot shed and trailing Live PVs dropped.
    expect(
      shed.some(
        (c) => c.parsed.pvs.length < (c.state.pvs ?? []).length && !c.query.includes('plot=')
      )
    ).toBe(true);
    for (const [i, p] of params.entries()) {
      const s = replay(shed[i].state);
      if (s.reference?.kind === 'pv') expect(p.get('ref')).toBe(s.reference.pv);
      if (s.xs !== '') expect(p.get('xs')).toBe(s.xs);
    }
  });
});
