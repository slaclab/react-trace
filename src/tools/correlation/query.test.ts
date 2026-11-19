import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultCorrelationState,
  densityY,
  lookbackMs,
  MAX_LABEL_LENGTH,
  MAX_QUERY_BYTES,
  normalizeCorrelationState,
  parseCorrelationQuery,
  serializeCorrelationQuery,
  type CorrelationState,
} from './query';
import { CORRELATION_METRICS } from './metrics';
import { defaultMetrics } from '../../statistics/model';

const X = 'SIM:DIAG:BPM:01:POSITION:X';
const Y1 = 'SIM:DIAG:BPM:02:POSITION:X';
const Y2 = 'SIM:DIAG:BPM:03:POSITION:X';
const T = 'SIM:TIMING:TRIGGER';

function state(over: Partial<CorrelationState> = {}): CorrelationState {
  return { ...defaultCorrelationState(), ...over };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function silenceWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

describe('parseCorrelationQuery defaults', () => {
  it('opens Timer 1 s, n=1000, lookback 1h, scatter with an empty query', () => {
    const warn = silenceWarn();
    expect(parseCorrelationQuery('')).toEqual({
      x: '',
      ys: [],
      trigger: { mode: 'timer', dtS: 1 },
      n: 1000,
      lookback: '1h',
      view: 'scatter',
      axes: 'shared',
      dy: '',
      labels: {},
      colors: {},
      hidden: {},
      markers: {},
      fit: true,
      readout: false,
      dist: false,
      legend: true,
      grid: true,
      crosshair: false,
      fade: false,
      tooltip: true,
      drag: 'zoom',
      metrics: defaultMetrics(CORRELATION_METRICS),
      drawings: [],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads the strip toggles: tip=0 hides the read-out, drag=pan pans', () => {
    const s = parseCorrelationQuery(`x=${X}&y=${Y1}&tip=0&drag=pan`);
    expect(s.tooltip).toBe(false);
    expect(s.drag).toBe('pan');
    const q = serializeCorrelationQuery(s);
    expect(q).toContain('tip=0');
    expect(q).toContain('drag=pan');
    // At their defaults neither key is written.
    const d = serializeCorrelationQuery(parseCorrelationQuery(`x=${X}&y=${Y1}`));
    expect(d).not.toContain('tip=');
    expect(d).not.toContain('drag=');
  });

  it('strips a leading "?" and ignores unknown and page keys', () => {
    const warn = silenceWarn();
    const s = parseCorrelationQuery(`?embedded=true&theme=dark&foo=bar&x=${X}&y=${Y1}`);
    expect(s.x).toBe(X);
    expect(s.ys).toEqual([Y1]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('parseCorrelationQuery keys', () => {
  it('keeps Y in order, drops duplicates, allows Y = X', () => {
    const s = parseCorrelationQuery(`x=${X}&y=${Y2}&y=${X}&y=${Y2}&y=${Y1}`);
    expect(s.ys).toEqual([Y2, X, Y1]);
  });

  it('trig wins over dt', () => {
    const warn = silenceWarn();
    expect(parseCorrelationQuery(`dt=5&trig=${T}`).trigger).toEqual({ mode: 'pv', pv: T });
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads dt in seconds, down to 0.1', () => {
    expect(parseCorrelationQuery('dt=0.1').trigger).toEqual({ mode: 'timer', dtS: 0.1 });
    expect(parseCorrelationQuery('dt=2.5').trigger).toEqual({ mode: 'timer', dtS: 2.5 });
  });

  it('reads n at both bounds', () => {
    expect(parseCorrelationQuery('n=1').n).toBe(1);
    expect(parseCorrelationQuery('n=10000').n).toBe(10000);
  });

  it("reads lookback in Trace's span syntax and clamps it to [1m, 24h]", () => {
    const warn = silenceWarn();
    expect(parseCorrelationQuery('lookback=30m').lookback).toBe('30m');
    expect(parseCorrelationQuery('lookback=1.5h').lookback).toBe('1.5h');
    expect(lookbackMs(parseCorrelationQuery('lookback=1.5h'))).toBe(90 * 60 * 1000);
    expect(parseCorrelationQuery('lookback=0.5m').lookback).toBe('1m');
    expect(parseCorrelationQuery('lookback=2d').lookback).toBe('24h');
    expect(lookbackMs(parseCorrelationQuery('lookback=1w'))).toBe(24 * 60 * 60 * 1000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads view and dy, dy by PV name', () => {
    const s = parseCorrelationQuery(`x=${X}&y=${Y1}&y=${Y2}&view=density&dy=${Y2}`);
    expect(s.view).toBe('density');
    expect(s.dy).toBe(Y2);
    expect(densityY(s)).toBe(Y2);
  });

  it('reads axes; shared by default', () => {
    expect(parseCorrelationQuery(`x=${X}&y=${Y1}`).axes).toBe('shared');
    for (const axes of ['shared', 'overlay', 'split'] as const) {
      expect(parseCorrelationQuery(`x=${X}&y=${Y1}&axes=${axes}`).axes).toBe(axes);
    }
  });

  it('density Y defaults to the first Y', () => {
    const s = parseCorrelationQuery(`x=${X}&y=${Y1}&y=${Y2}&view=density`);
    expect(s.dy).toBe('');
    expect(densityY(s)).toBe(Y1);
  });
});

describe('parseCorrelationQuery invalid values', () => {
  const cases: [string, string, Partial<CorrelationState>][] = [
    ['n=0', 'n', { n: 1000 }],
    ['n=10001', 'n', { n: 1000 }],
    ['n=12.5', 'n', { n: 1000 }],
    ['n=abc', 'n', { n: 1000 }],
    ['dt=0.05', 'dt', { trigger: { mode: 'timer', dtS: 1 } }],
    ['dt=-1', 'dt', { trigger: { mode: 'timer', dtS: 1 } }],
    ['dt=fast', 'dt', { trigger: { mode: 'timer', dtS: 1 } }],
    ['trig=', 'trig', { trigger: { mode: 'timer', dtS: 1 } }],
    ['lookback=-1h', 'lookback', { lookback: '1h' }],
    ['lookback=10x', 'lookback', { lookback: '1h' }],
    ['lookback=', 'lookback', { lookback: '1h' }],
    ['view=line', 'view', { view: 'scatter' }],
    ['axes=stacked', 'axes', { axes: 'shared' }],
    ['axes=', 'axes', { axes: 'shared' }],
    [`y=${Y1}&dy=${Y2}`, 'dy', { ys: [Y1], dy: '' }],
    ['x=', 'x', { x: '' }],
  ];

  for (const [query, key, expected] of cases) {
    it(`${query} falls back to the default with one warning`, () => {
      const warn = silenceWarn();
      expect(parseCorrelationQuery(query)).toEqual(state(expected));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(key);
    });
  }

  it('an invalid trig falls to a valid dt', () => {
    const warn = silenceWarn();
    expect(parseCorrelationQuery('trig=%20&dt=3').trigger).toEqual({ mode: 'timer', dtS: 3 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the first 8 distinct Y and warns once', () => {
    const warn = silenceWarn();
    const ys = Array.from({ length: 10 }, (_, i) => `PV:Y${i}`);
    const s = parseCorrelationQuery(ys.map((y) => `y=${y}`).join('&'));
    expect(s.ys).toEqual(ys.slice(0, 8));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('several invalid keys still cost one warning; valid keys are kept', () => {
    const warn = silenceWarn();
    const s = parseCorrelationQuery(`x=${X}&y=${Y1}&n=0&dt=0&view=pie&lookback=forever`);
    expect(s).toEqual(state({ x: X, ys: [Y1] }));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects a query over 4 KB as a whole, with one warning', () => {
    const warn = silenceWarn();
    const big = `x=${X}&y=${'A'.repeat(MAX_QUERY_BYTES)}`;
    expect(parseCorrelationQuery(big)).toEqual(defaultCorrelationState());
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('serializeCorrelationQuery', () => {
  it('writes only the active trigger key', () => {
    const timer = serializeCorrelationQuery(state({ x: X, ys: [Y1] }));
    expect(timer).toBe(`x=${X}&y=${Y1}&dt=1&n=1000&lookback=1h&view=scatter`);
    const pv = serializeCorrelationQuery(state({ x: X, ys: [Y1], trigger: { mode: 'pv', pv: T } }));
    expect(pv).toBe(`x=${X}&y=${Y1}&trig=${T}&n=1000&lookback=1h&view=scatter`);
    expect(new URLSearchParams(pv).has('dt')).toBe(false);
  });

  it('writes an out-of-domain field as its default with one warning', () => {
    const warn = silenceWarn();
    const q = serializeCorrelationQuery(state({ x: X, n: 0, lookback: 'soon' }));
    expect(q).toBe(`x=${X}&dt=1&n=1000&lookback=1h&view=scatter`);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('writes axes only when not shared, after view', () => {
    expect(serializeCorrelationQuery(state({ x: X, axes: 'shared' }))).not.toContain('axes=');
    expect(serializeCorrelationQuery(state({ x: X, ys: [Y1], axes: 'overlay' }))).toBe(
      `x=${X}&y=${Y1}&dt=1&n=1000&lookback=1h&view=scatter&axes=overlay`
    );
  });

  it('an out-of-domain axes is omitted (the default) with one warning', () => {
    const warn = silenceWarn();
    const bad = state({ x: X, axes: 'stacked' as unknown as CorrelationState['axes'] });
    expect(serializeCorrelationQuery(bad)).toBe(`x=${X}&dt=1&n=1000&lookback=1h&view=scatter`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('axes');
  });

  it('drops trailing Y until the query fits in 4 KB', () => {
    const warn = silenceWarn();
    const long = (i: number) => `PV:${String(i).repeat(1000)}`;
    const ys = [long(1), long(2), long(3), long(4), long(5)];
    const q = serializeCorrelationQuery(state({ x: X, ys }));
    expect(new TextEncoder().encode(q).length).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    expect(parseCorrelationQuery(q).ys).toEqual(ys.slice(0, 4));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('query round-trip', () => {
  const states: [string, CorrelationState][] = [
    ['defaults', defaultCorrelationState()],
    ['timer', state({ x: X, ys: [Y1, Y2], trigger: { mode: 'timer', dtS: 0.25 }, n: 1 })],
    [
      'trigger PV, density by PV',
      state({
        x: X,
        ys: [Y1, X, Y2],
        trigger: { mode: 'pv', pv: T },
        n: 10000,
        lookback: '24h',
        view: 'density',
        dy: Y2,
      }),
    ],
    ['fractional lookback', state({ x: X, ys: [Y1], lookback: '1.5m' })],
    ['overlay axes', state({ x: X, ys: [Y1, Y2], axes: 'overlay' })],
    ['split axes, density by PV', state({ x: X, ys: [Y1, Y2], axes: 'split', dy: Y2 })],
    ['names needing encoding', state({ x: 'A B&C=D', ys: ['é:ü', 'x+y'], dy: 'x+y' })],
    ['statistics with the distribution', state({ x: X, ys: [Y1], readout: true, dist: true })],
  ];

  for (const [name, s] of states) {
    it(`state -> query -> state: ${name}`, () => {
      const warn = silenceWarn();
      expect(parseCorrelationQuery(serializeCorrelationQuery(s))).toEqual(s);
      expect(warn).not.toHaveBeenCalled();
    });
  }

  it('query -> state -> query is stable for a canonical query', () => {
    const q = `x=${X}&y=${Y1}&y=${Y2}&trig=${T}&n=500&lookback=30m&view=density&axes=split&dy=${Y1}`;
    expect(serializeCorrelationQuery(parseCorrelationQuery(q))).toBe(q);
  });
});

describe('normalizeCorrelationState', () => {
  const Y3 = 'SIM:DIAG:BPM:04:POSITION:X';
  const full = (): CorrelationState =>
    state({
      x: X,
      ys: [Y1, Y2, Y3],
      trigger: { mode: 'pv', pv: T },
      dy: Y2,
      labels: { [X]: 'X title', [Y1]: 'first', [Y2]: '', [T]: 'trigger', other: 'gone' },
      colors: { [Y1]: '#123456', [X]: '#abcdef', [T]: '#000000' },
      hidden: { [Y2]: true, [X]: true },
      markers: { [Y3]: { shape: 'diamond', size: 9, opacity: 0.5 }, [T]: { size: 3 } },
      fit: false,
      readout: false,
      legend: false,
      grid: false,
      crosshair: true,
      fade: true,
      fire: 'rising',
      xScale: { auto: false, min: -1, max: 1 },
      yScale: { log: true },
    });

  it('is the identity on the defaults', () => {
    expect(normalizeCorrelationState(defaultCorrelationState())).toEqual(defaultCorrelationState());
  });

  it('is idempotent', () => {
    const inputs: CorrelationState[] = [
      defaultCorrelationState(),
      full(),
      state({
        x: ` ${X} `,
        ys: [Y1, ' ', Y1, ...Array.from({ length: 10 }, (_, i) => `P:${i}`)],
        dy: 'nope',
        labels: { [Y1]: 'é'.repeat(200) },
        markers: { [Y1]: { size: 99, opacity: -2, shape: 'star' as never }, 'P:0': {} },
        xScale: { auto: true, log: false },
        yScale: { min: Number.NaN },
        fire: 'falling',
      }),
    ];
    for (const input of inputs) {
      const once = normalizeCorrelationState(input);
      expect(normalizeCorrelationState(once)).toEqual(once);
    }
  });

  it('does not mutate its input', () => {
    const input = full();
    const copy = structuredClone(input);
    normalizeCorrelationState(input);
    expect(input).toEqual(copy);
  });

  it('prunes each record to the roles that show its field', () => {
    const s = normalizeCorrelationState(full());
    expect(s.labels).toEqual({ [X]: 'X title', [Y1]: 'first', [Y2]: '' });
    expect(s.colors).toEqual({ [Y1]: '#123456' });
    expect(s.hidden).toEqual({ [Y2]: true });
    expect(s.markers).toEqual({ [Y3]: { shape: 'diamond', size: 9, opacity: 0.5 } });
  });

  it('keeps tool-level settings and the axis scales', () => {
    const s = normalizeCorrelationState(full());
    expect(s).toMatchObject({
      fit: false,
      readout: false,
      legend: false,
      grid: false,
      crosshair: true,
      fade: true,
      fire: 'rising',
      xScale: { auto: false, min: -1, max: 1 },
      yScale: { log: true },
    });
  });

  it('prunes on a role change: a Y moved to X keeps only its label', () => {
    const before = normalizeCorrelationState(
      state({
        x: X,
        ys: [Y1, Y2],
        labels: { [X]: 'old X', [Y2]: 'second' },
        colors: { [Y2]: '#ff0000' },
        hidden: { [Y2]: true },
        markers: { [Y2]: { size: 8 } },
      })
    );
    const after = normalizeCorrelationState({ ...before, x: Y2, ys: [Y1] });
    expect(after.labels).toEqual({ [Y2]: 'second' });
    expect(after.colors).toEqual({});
    expect(after.hidden).toEqual({});
    expect(after.markers).toEqual({});
  });

  it('prunes on a role change: a Y moved to Trigger keeps nothing', () => {
    const before = normalizeCorrelationState(
      state({ x: X, ys: [Y1, Y2], labels: { [Y2]: 'l' }, colors: { [Y2]: '#ff0000' } })
    );
    const after = normalizeCorrelationState({
      ...before,
      ys: [Y1],
      trigger: { mode: 'pv', pv: Y2 },
    });
    expect(after.labels).toEqual({});
    expect(after.colors).toEqual({});
  });

  it('keeps a Y record when the same PV is also the X or the trigger', () => {
    const s = normalizeCorrelationState(
      state({
        x: X,
        ys: [X],
        trigger: { mode: 'pv', pv: X },
        labels: { [X]: 'both' },
        colors: { [X]: '#00ff00' },
      })
    );
    expect(s.labels).toEqual({ [X]: 'both' });
    expect(s.colors).toEqual({ [X]: '#00ff00' });
  });

  it('caps labels at 80 characters', () => {
    const s = normalizeCorrelationState(
      state({ x: X, ys: [Y1], labels: { [X]: 'a'.repeat(81), [Y1]: '🙂'.repeat(100) } })
    );
    expect(s.labels[X]).toBe('a'.repeat(MAX_LABEL_LENGTH));
    expect([...s.labels[Y1]]).toHaveLength(MAX_LABEL_LENGTH);
  });

  it('drops fire outside Trigger PV mode', () => {
    expect(normalizeCorrelationState(state({ fire: 'falling' })).fire).toBeUndefined();
    expect(
      normalizeCorrelationState(state({ trigger: { mode: 'pv', pv: T }, fire: 'falling' })).fire
    ).toBe('falling');
    expect(
      normalizeCorrelationState(
        state({ trigger: { mode: 'pv', pv: T }, fire: 'sideways' as never })
      ).fire
    ).toBeUndefined();
  });

  it('canonicalizes axis scales: absent = automatic', () => {
    expect(normalizeCorrelationState(state({ xScale: { auto: true, log: false } })).xScale).toBe(
      undefined
    );
    expect('xScale' in normalizeCorrelationState(state({ xScale: {} }))).toBe(false);
    expect(
      normalizeCorrelationState(state({ yScale: { auto: false, min: 2, max: Infinity } })).yScale
    ).toEqual({ auto: false, min: 2 });
  });

  it('clamps marker fields and drops an empty marker', () => {
    const s = normalizeCorrelationState(
      state({
        ys: [Y1, Y2],
        markers: { [Y1]: { size: 0, opacity: 2 }, [Y2]: { shape: 'star' as never } },
      })
    );
    expect(s.markers).toEqual({ [Y1]: { size: 1, opacity: 1 } });
  });

  it('dedupes, trims and caps Ys, and resets a dy that is not a Y', () => {
    const ys = [Y1, ` ${Y1} `, '', ...Array.from({ length: 9 }, (_, i) => `P:${i}`)];
    const s = normalizeCorrelationState(state({ ys, dy: Y2 }));
    expect(s.ys).toEqual([Y1, ...Array.from({ length: 7 }, (_, i) => `P:${i}`)]);
    expect(s.dy).toBe('');
  });

  it('runs on parse', () => {
    expect(parseCorrelationQuery(`trig=${T}`).fire).toBeUndefined();
    expect(parseCorrelationQuery(`x=${X}&y=${Y1}`)).toEqual(
      normalizeCorrelationState(parseCorrelationQuery(`x=${X}&y=${Y1}`))
    );
  });
});

describe('metrics in the state', () => {
  it('defaults to the default list and normalizes it', () => {
    expect(defaultCorrelationState().metrics).toEqual(defaultMetrics(CORRELATION_METRICS));
    const s = normalizeCorrelationState({
      ...defaultCorrelationState(),
      metrics: [
        { id: 'r', label: 'renamed', expr: 'n', unit: 'x', on: true, strip: true },
        { id: 'r', label: 'r', expr: 'corr(x, y)', unit: '', on: false, strip: false },
        { id: 'zzz', label: 'gone', expr: 'n', unit: '', on: true, strip: false },
      ],
    });
    expect(s.metrics).toEqual([
      { id: 'r', label: 'r', expr: 'corr(x, y)', unit: '', on: true, strip: true },
    ]);
  });

  it('round-trips a custom metric through the query', () => {
    const warn = silenceWarn();
    const s = normalizeCorrelationState({
      ...defaultCorrelationState(),
      x: X,
      ys: [Y1],
      metrics: [
        { id: 'c1', label: 'Ratio', expr: 'mean(y1) / mean(x)', unit: '', on: true, strip: true },
        ...defaultMetrics(CORRELATION_METRICS).slice(0, 3),
      ],
    });
    expect(parseCorrelationQuery(serializeCorrelationQuery(s))).toEqual(s);
    expect(warn).not.toHaveBeenCalled();
  });
});
