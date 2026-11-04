// Pins the Correlation link format v1 (without drawings): each recorded link
// in __fixtures__/correlation-links.json decodes to the recorded state over its
// base fields (`baseOf`: added fields pass) and re-encodes byte for byte, and
// each recorded input state serializes to exactly that link, including the
// over-budget states that exercise the 4 KB shedding order. Fields added later
// take their defaults when the base state is replayed.
// A fixture is never edited to make a refactor pass.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseOf } from '../../test/fixtureBase';
import raw from './__fixtures__/correlation-links.json?raw';
import {
  type CorrelationState,
  defaultCorrelationState,
  MAX_QUERY_BYTES,
  parseCorrelationQuery,
  serializeCorrelationQuery,
} from './query';

interface LinkFixture {
  name: string;
  /** The input state the link was serialized from (base fields only). */
  state: Partial<CorrelationState>;
  query: string;
  parsed: CorrelationState;
}

const CASES = (JSON.parse(raw) as { cases: LinkFixture[] }).cases;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const replay = (base: Partial<CorrelationState>): CorrelationState => ({
  ...defaultCorrelationState(),
  ...base,
});

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('Correlation links (base fixtures)', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(bytes(c.query)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    const parsed = parseCorrelationQuery(c.query);
    expect(baseOf(parsed, c.parsed)).toEqual(c.parsed);
    expect(serializeCorrelationQuery(parsed)).toBe(c.query);

    warn.mockClear();
    expect(serializeCorrelationQuery(replay(c.state))).toBe(c.query);
    // An over-budget input sheds (one warning); every other input fits as is.
    expect(warn).toHaveBeenCalledTimes(c.name.startsWith('over budget') ? 1 : 0);
  });

  it('covers every shedding step', () => {
    const shed = CASES.filter((c) => c.name.startsWith('over budget'));
    const lost = (c: LinkFixture) => {
      const p = c.parsed;
      const s = replay(c.state);
      return {
        label: Object.keys(p.labels).length < Object.keys(s.labels).length,
        xl: s.x in s.labels && !(p.x in p.labels),
        colour: Object.keys(p.colors).length < Object.keys(s.colors).length,
        marker: Object.keys(p.markers).length < Object.keys(s.markers).length,
        y: p.ys.length < s.ys.length,
      };
    };
    const any = (k: keyof ReturnType<typeof lost>) => shed.some((c) => lost(c)[k]);
    for (const k of ['label', 'xl', 'colour', 'marker', 'y'] as const) expect(any(k)).toBe(true);
  });
});
