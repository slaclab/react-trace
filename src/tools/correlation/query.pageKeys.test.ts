// The 4 KB link budget is the query's own: the page keys the publisher writes
// in front of it (theme, embedded, hostbar, bench) are not counted when the
// page reads its opening query, so a query the serializer accepted reopens
// on a tile reload.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultCorrelationState,
  MAX_QUERY_BYTES,
  parseCorrelationQuery,
  serializeCorrelationQuery,
  type CorrelationState,
} from './query';

const bytes = (s: string): number => new TextEncoder().encode(s).length;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Eight long-named Ys and an X label: a query just under the 4 KB budget, no drawings. */
function nearBudget(): { state: CorrelationState; query: string } {
  const named = (last: number): CorrelationState => ({
    ...defaultCorrelationState(),
    x: 'TEST:SINE',
    ys: Array.from({ length: 8 }, (_, i) => `DEMO:${'Y'.repeat(i === 7 ? last : 400)}:${i}`),
    labels: { 'TEST:SINE': 'x label' },
  });
  // The last Y's name brings the query to 20 bytes under the limit.
  const free = MAX_QUERY_BYTES - 20 - bytes(serializeCorrelationQuery(named(400)));
  const state = named(400 + free);
  const query = serializeCorrelationQuery(state);
  expect(bytes(query)).toBe(MAX_QUERY_BYTES - 20);
  return { state, query };
}

describe('page keys and the 4 KB budget', () => {
  it('a query the serializer accepted reopens with the page keys in front of it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { state, query } = nearBudget();
    expect(bytes(query)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    expect(warn).not.toHaveBeenCalled();
    const page = `?theme=dark&embedded=true&hostbar=1&bench=1&${query}`;
    expect(bytes(page)).toBeGreaterThan(MAX_QUERY_BYTES);
    const back = parseCorrelationQuery(page);
    expect(warn).not.toHaveBeenCalled();
    expect(back.x).toBe(state.x);
    expect(back.ys).toEqual(state.ys);
    expect(back.labels).toEqual(state.labels);
  });

  it('page keys anywhere in the query are left out of the budget', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { state, query } = nearBudget();
    const back = parseCorrelationQuery(`${query}&theme=light&embedded=true`);
    expect(warn).not.toHaveBeenCalled();
    expect(back.ys).toEqual(state.ys);
  });

  it('a query over 4 KB on its own is still rejected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const q = `theme=dark&x=TEST:SINE&y=DEMO:Y&xl=${'a'.repeat(MAX_QUERY_BYTES)}`;
    expect(parseCorrelationQuery(q)).toEqual(defaultCorrelationState());
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
