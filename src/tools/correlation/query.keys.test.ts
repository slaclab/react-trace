// The flat query keys of the per-PV and plot settings: each key's exact
// text, defaults omitted, a key written iff its record exists, parsing creating
// a record per key, invalid values warned, and the 4 KB shedding order, with
// the drawings' ann= key after the settings steps and before trailing Ys.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAnnotationColor } from '../../annotationTheme';
import { encodeJsonParam } from '../../annotations/config';
import type { Annotation } from '../../annotations/model';
import {
  defaultCorrelationState,
  MAX_QUERY_BYTES,
  PAGE_KEY_RESERVE,
  parseCorrelationQuery,
  serializeCorrelationQuery,
  serializeCorrelationQueryWithShed,
  type CorrelationState,
} from './query';
import { CORRELATION_METRICS } from './metrics';
import {
  MAX_METRICS,
  MAX_METRIC_EXPR_LENGTH,
  MAX_METRIC_LABEL_LENGTH,
  defaultMetrics,
  encodeMetricToken,
  presetMetric,
  presetOf,
  type Metric,
} from '../../statistics/model';
import { BUILTIN_CATALOG } from '../../annotations/catalog';

/** A built-in tool's wire code. */
const code = (kind: string): number => BUILTIN_CATALOG.byKind(kind)!.code;

const X = 'SIM:X';
const Y1 = 'SIM:Y1';
const Y2 = 'SIM:Y2';
const Y3 = 'SIM:Y3';
const T = 'SIM:TRIG';
const BASE = `x=${X}&y=${Y1}&y=${Y2}&dt=1&n=1000&lookback=1h&view=scatter`;

function state(over: Partial<CorrelationState> = {}): CorrelationState {
  return { ...defaultCorrelationState(), x: X, ys: [Y1, Y2], ...over };
}

function silenceWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

function bytes(q: string): number {
  return new TextEncoder().encode(q).length;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('serializer: defaults omitted', () => {
  it('writes none of the new keys at the defaults', () => {
    expect(serializeCorrelationQuery(state())).toBe(BASE);
  });

  it('writes a Timer state with an explicit Every update and auto scales unchanged', () => {
    expect(
      serializeCorrelationQuery(state({ xScale: {}, yScale: { auto: true, log: false } }))
    ).toBe(BASE);
  });
});

describe('serializer: per-PV keys written iff the record exists', () => {
  it('xl and l<i> carry labels, by written Y position', () => {
    const q = serializeCorrelationQuery(state({ labels: { [X]: 'Pos X', [Y2]: 'second' } }));
    expect(q).toBe(`${BASE}&xl=Pos%20X&l2=second`);
  });

  it('writes a label whatever its value, even empty or equal to the PV', () => {
    const q = serializeCorrelationQuery(state({ labels: { [Y1]: '', [Y2]: Y2 } }));
    expect(q).toBe(`${BASE}&l1=&l2=${Y2}`);
    expect(parseCorrelationQuery(q).labels).toEqual({ [Y1]: '', [Y2]: Y2 });
  });

  it('c<i> carries a pinned colour, encoded', () => {
    const q = serializeCorrelationQuery(state({ colors: { [Y1]: '#ff0000' } }));
    expect(q).toBe(`${BASE}&c1=%23ff0000`);
  });

  it('m<i> carries marker fields with absent ones empty', () => {
    expect(
      serializeCorrelationQuery(
        state({ markers: { [Y1]: { shape: 'diamond', size: 9, opacity: 0.5 } } })
      )
    ).toBe(`${BASE}&m1=diamond,9,0.5`);
    expect(serializeCorrelationQuery(state({ markers: { [Y2]: { opacity: 0.5 } } }))).toBe(
      `${BASE}&m2=,,0.5`
    );
    expect(serializeCorrelationQuery(state({ markers: { [Y2]: { shape: 'pin' } } }))).toBe(
      `${BASE}&m2=pin`
    );
  });

  it('hide lists hidden Y positions', () => {
    const q = serializeCorrelationQuery(
      state({ ys: [Y1, Y2, Y3], hidden: { [Y3]: true, [Y1]: true } })
    );
    expect(q).toContain('&hide=1,3');
  });

  it('skips records of PVs that are not in the role', () => {
    const q = serializeCorrelationQuery(
      state({
        colors: { [X]: '#000', other: '#111' },
        hidden: { [T]: true },
        labels: { other: 'z' },
      })
    );
    expect(q).toBe(BASE);
  });
});

describe('serializer: tool-level keys', () => {
  it('writes each toggle only off its default', () => {
    const q = serializeCorrelationQuery(
      state({ fit: false, readout: true, legend: false, grid: false, crosshair: true, fade: true })
    );
    expect(q).toBe(`${BASE}&fit=0&readout=1&legend=0&grid=0&cross=1&fade=1`);
  });

  it('writes fire only in Trigger PV mode', () => {
    expect(
      serializeCorrelationQuery(state({ trigger: { mode: 'pv', pv: T }, fire: 'rising' }))
    ).toContain('&fire=rising');
    expect(serializeCorrelationQuery(state({ fire: 'falling' }))).not.toContain('fire=');
  });

  it('writes each axis scale field that is present', () => {
    const q = serializeCorrelationQuery(
      state({ xScale: { auto: false, min: -1.5, max: 2e21 }, yScale: { log: true, min: 0.001 } })
    );
    expect(q).toBe(`${BASE}&xauto=0&xmin=-1.5&xmax=2e%2B21&ymin=0.001&ylog=1`);
    expect(parseCorrelationQuery(q).xScale).toEqual({ auto: false, min: -1.5, max: 2e21 });
  });
});

describe('parser: a record for every key present', () => {
  it('maps <i> onto the deduplicated Ys', () => {
    const s = parseCorrelationQuery(
      `x=${X}&y=${Y1}&y=${Y1}&y=${Y2}&l2=two&c2=%23ff0000&m2=rect,,1&hide=2&xl=ex`
    );
    expect(s.labels).toEqual({ [X]: 'ex', [Y2]: 'two' });
    expect(s.colors).toEqual({ [Y2]: '#ff0000' });
    expect(s.markers).toEqual({ [Y2]: { shape: 'rect', opacity: 1 } });
    expect(s.hidden).toEqual({ [Y2]: true });
  });

  it.each(['red;background:url(x)', 'expression(alert(1))', 'url(x)', 'red'])(
    'refuses the unsafe colour %s',
    (color) => {
      const warn = silenceWarn();
      const s = parseCorrelationQuery(`y=${Y1}&c1=${encodeURIComponent(color)}`);
      expect(s.colors).toEqual({});
      expect(String(warn.mock.calls[0][0])).toContain('c1');
    }
  );

  it.each(['#abc', 'rgb(1,2,3)', 'rgba(1, 2, 3, 0.5)'])('keeps the colour literal %s', (color) => {
    const s = parseCorrelationQuery(`y=${Y1}&c1=${encodeURIComponent(color)}`);
    expect(s.colors).toEqual({ [Y1]: color });
  });

  it('reads the toggles, fire and the axis scales', () => {
    const s = parseCorrelationQuery(
      `trig=${T}&fire=falling&fit=0&readout=0&legend=0&grid=0&cross=1&fade=1&xauto=0&xmax=3&ylog=1`
    );
    expect(s).toMatchObject({
      fit: false,
      readout: false,
      legend: false,
      grid: false,
      crosshair: true,
      fade: true,
      fire: 'falling',
      xScale: { auto: false, max: 3 },
      yScale: { log: true },
    });
  });

  it('clamps marker fields through the normalizer', () => {
    const s = parseCorrelationQuery(`y=${Y1}&m1=,99,-1`);
    expect(s.markers).toEqual({ [Y1]: { size: 40, opacity: 0 } });
  });

  it('warns once naming every invalid key and keeps the defaults for them', () => {
    const warn = silenceWarn();
    const s = parseCorrelationQuery(
      `y=${Y1}&l2=nope&c1=%20&m1=star&hide=1,9&xl=no-x&fit=yes&fire=rising&xmin=abc&ylog=2`
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    for (const key of ['l2', 'c1', 'm1', 'hide', 'xl', 'fit', 'fire', 'xmin', 'ylog']) {
      expect(msg).toContain(key);
    }
    expect(s.labels).toEqual({});
    expect(s.colors).toEqual({});
    expect(s.markers).toEqual({});
    expect(s.hidden).toEqual({ [Y1]: true });
    expect(s.fit).toBe(true);
    expect(s.fire).toBeUndefined();
    expect(s.xScale).toBeUndefined();
    expect(s.yScale).toBeUndefined();
  });

  it('does not warn on a query it wrote', () => {
    const warn = silenceWarn();
    parseCorrelationQuery(
      serializeCorrelationQuery(
        state({
          labels: { [X]: 'a', [Y1]: 'b' },
          colors: { [Y2]: '#123' },
          markers: { [Y1]: { size: 3 } },
          hidden: { [Y2]: true },
        })
      )
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('serializer: the shedding order over 4 KB', () => {
  // Each label is 80 euro signs: 720 bytes once percent-encoded.
  const big = '€'.repeat(80);
  const ys = Array.from({ length: 8 }, (_, i) => `SIM:Y${i + 1}`);
  const all = (over: Partial<CorrelationState> = {}) =>
    state({
      ys,
      labels: Object.fromEntries([X, ...ys].map((pv) => [pv, big])),
      ...over,
    });

  it('sheds labels from the last Y first, then xl, keeping every Y', () => {
    const warn = silenceWarn();
    const q = serializeCorrelationQuery(all());
    expect(bytes(q)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    const s = parseCorrelationQuery(q);
    expect(s.ys).toEqual(ys);
    // 9 labels of ~726 bytes each: shedding l8..l5 leaves xl and l1..l4 under 4 KB.
    expect(Object.keys(s.labels)).toEqual([X, ys[0], ys[1], ys[2], ys[3]]);
    expect(s.labels[X]).toBe(big);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('sheds xl only after every l<i>', () => {
    silenceWarn();
    const huge = 'é'.repeat(80); // 480 bytes encoded
    const labelled = (zs: number) => {
      const many = Array.from({ length: 8 }, (_, i) => `PV:${'Z'.repeat(zs)}:${i}`);
      const q = serializeCorrelationQuery(
        state({ ys: many, labels: Object.fromEntries([X, ...many].map((pv) => [pv, huge])) })
      );
      expect(bytes(q)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
      const s = parseCorrelationQuery(q);
      expect(s.ys).toEqual(many);
      return s.labels;
    };
    // Room for one label: it is the X's, not the first Y's.
    expect(labelled(420)).toEqual({ [X]: huge });
    // Room for none: xl goes too, and still every Y stays.
    expect(labelled(480)).toEqual({});
  });

  it('sheds colours and markers before hide, and hide before any Y', () => {
    silenceWarn();
    const many = Array.from({ length: 8 }, (_, i) => `PV:${'Z'.repeat(440)}:${i}`);
    const colour = `rgb(${'1'.repeat(40)})`;
    const q = serializeCorrelationQuery(
      state({
        ys: many,
        labels: { [many[0]]: 'gone first' },
        colors: Object.fromEntries(many.map((pv) => [pv, colour])),
        markers: Object.fromEntries(many.map((pv) => [pv, { shape: 'diamond' as const }])),
        hidden: { [many[0]]: true },
      })
    );
    const s = parseCorrelationQuery(q);
    expect(s.ys).toEqual(many);
    expect(s.labels).toEqual({});
    // Colours and markers shed from the last Y: whatever remains is a prefix.
    const kept = Object.keys(s.colors);
    expect(kept).toEqual(many.slice(0, kept.length));
    expect(Object.keys(s.markers)).toEqual(kept);
    expect(kept.length).toBeLessThan(8);
    expect(s.hidden).toEqual({ [many[0]]: true });
  });

  it('drops trailing Ys only after every per-PV key is gone', () => {
    silenceWarn();
    const many = Array.from({ length: 8 }, (_, i) => `PV:${'Z'.repeat(600)}:${i}`);
    const q = serializeCorrelationQuery(
      state({
        ys: many,
        labels: { [X]: 'x', [many[0]]: 'a' },
        colors: { [many[0]]: '#123456' },
        hidden: { [many[0]]: true },
      })
    );
    expect(bytes(q)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    expect(q).not.toMatch(/(^|&)(xl|l\d|c\d|m\d|hide)=/);
    expect(parseCorrelationQuery(q).ys).toEqual(many.slice(0, 6));
  });
});

describe('metrics: the m= keys', () => {
  const preset = (id: string, on: boolean, strip = false): Metric => ({
    ...presetMetric(presetOf(CORRELATION_METRICS, id)!, on),
    strip,
  });
  const custom = (
    id: string,
    label: string,
    expr: string,
    unit: Metric['unit'] = '',
    on = true,
    strip = false
  ): Metric => ({ id, label, expr, unit, on, strip });

  const changed: Metric[] = [
    preset('r', true, true),
    custom('c1', 'Spread %', 'std(y) / mean(y) * 100'),
    preset('mean', false),
    preset('slope', false, true),
    custom('c2', 'Gain', 'slope(x, y)', 'y/x', false, true),
  ];

  it('writes no m key for the default list', () => {
    expect(serializeCorrelationQuery(state({ metrics: defaultMetrics(CORRELATION_METRICS) }))).toBe(
      BASE
    );
  });

  it('writes one m key per metric, in order, after the toggles and before the scales', () => {
    const q = serializeCorrelationQuery(
      state({ metrics: changed, grid: false, xScale: { log: true } })
    );
    const tokens = changed.map(
      (m) => `m=${encodeURIComponent(encodeMetricToken(CORRELATION_METRICS, m))}`
    );
    expect(q).toBe(`${BASE}&grid=0&${tokens.join('&')}&xlog=1`);
    expect(q).toContain('m=~r&m=Spread%20%25%3Dstd(y)%20%2F%20mean(y)%20*%20100&m=-mean');
    expect(q).toContain('m=-~slope&m=-~Gain%3Dslope(x%2C%20y)%3Dy%2Fx');
  });

  it('round-trips a changed list: flags, customs with and without unit, order', () => {
    const warn = silenceWarn();
    const back = parseCorrelationQuery(serializeCorrelationQuery(state({ metrics: changed })));
    expect(back.metrics).toEqual(changed);
    expect(warn).not.toHaveBeenCalled();
  });

  it('numbers customs c1, c2... in token order whatever their in-memory ids', () => {
    silenceWarn();
    const s = state({
      metrics: [custom('c7', 'A', 'mean(y)'), preset('n', true), custom('c3', 'B', 'max(x)', 'x')],
    });
    expect(parseCorrelationQuery(serializeCorrelationQuery(s)).metrics.map((m) => m.id)).toEqual([
      'c1',
      'n',
      'c2',
    ]);
  });

  it('parse(serialize(s)) equals s for a state with custom metrics', () => {
    const warn = silenceWarn();
    const s = parseCorrelationQuery(
      serializeCorrelationQuery(state({ metrics: changed, fit: false, labels: { [Y1]: 'one' } }))
    );
    expect(parseCorrelationQuery(serializeCorrelationQuery(s))).toEqual(s);
    expect(s.metrics).toEqual(changed);
    expect(warn).not.toHaveBeenCalled();
  });

  it('with no m key the list is the default', () => {
    expect(parseCorrelationQuery(BASE).metrics).toEqual(defaultMetrics(CORRELATION_METRICS));
  });

  it('skips a bad token and warns once naming m', () => {
    const warn = silenceWarn();
    const s = parseCorrelationQuery(`${BASE}&m=r&m=%3Dnolabel&m=bogus&m=-mean&m=a%3Db%3Dc%3Dd`);
    expect(s.metrics).toEqual([preset('r', true), preset('mean', false)]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/invalid m;/);
  });

  it('drops an unknown preset', () => {
    silenceWarn();
    expect(parseCorrelationQuery(`${BASE}&m=kurtosis&m=std`).metrics).toEqual([
      preset('std', true),
    ]);
  });

  it('an m key whose tokens are all bad gives an empty list, not the default', () => {
    const warn = silenceWarn();
    expect(parseCorrelationQuery(`${BASE}&m=bogus&m=`).metrics).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('an empty list has no token to write, so it reopens as the default', () => {
    expect(serializeCorrelationQuery(state({ metrics: [] }))).toBe(BASE);
  });

  it('over 4 KB sheds every m key after hide and before any trailing Y, and says so', () => {
    const warn = silenceWarn();
    const many = Array.from({ length: 8 }, (_, i) => `PV:${'Z'.repeat(300)}:${i}`);
    const customs = Array.from({ length: MAX_METRICS }, (_, i) =>
      custom(
        `c${i + 1}`,
        // Characters that percent-encode, so the tokens alone are over 4 KB.
        `${i}`.padEnd(MAX_METRIC_LABEL_LENGTH, '€'),
        'y / '.repeat(MAX_METRIC_EXPR_LENGTH / 4)
      )
    );
    const q = serializeCorrelationQuery(
      state({
        ys: many,
        labels: Object.fromEntries(many.map((pv) => [pv, 'é'.repeat(80)])),
        hidden: { [many[0]]: true },
        metrics: customs,
      })
    );
    const tokens = customs.map(
      (m) => `m=${encodeURIComponent(encodeMetricToken(CORRELATION_METRICS, m))}`
    );
    expect(bytes(tokens.join('&'))).toBeGreaterThan(MAX_QUERY_BYTES);
    expect(bytes(q)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    expect(q).not.toMatch(/(^|&)m=/);
    const back = parseCorrelationQuery(q);
    expect(back.ys).toEqual(many);
    expect(back.metrics).toEqual(defaultMetrics(CORRELATION_METRICS));
    expect(back.labels).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toMatch(/shed [^]*\bhide, m\b/);
    expect(msg).toContain('kept 8 of 8 Y PVs');
  });
});

describe('drawings: the ann= key', () => {
  const line = (i: number, over: Partial<Annotation> = {}): Annotation => ({
    id: `annotation-${i}`,
    kind: 'hline',
    points: [{ t: 0, v: i + 0.5 }],
    axisId: Y1,
    color: defaultAnnotationColor(i),
    width: 0.75,
    text: '',
    ...over,
  });

  it('writes ann last, the axis and magnet named by Y PV in the reference table', () => {
    const q = serializeCorrelationQuery(
      state({ drawings: [line(0, { axisId: Y2, traceId: Y2 })], yScale: { log: true } })
    );
    const ann = encodeJsonParam({ r: [Y2], b: [], d: [[code('hline'), [0.5], 0, 0]] });
    expect(q).toBe(`${BASE}&ylog=1&ann=${ann}`);
  });

  it('writes no ann key with no drawings', () => {
    expect(serializeCorrelationQuery(state({ drawings: [] }))).toBe(BASE);
  });

  it('reads ann into drawings, and ignores an unreadable value with one warning', () => {
    const q = serializeCorrelationQuery(state({ drawings: [line(0), line(1)] }));
    expect(parseCorrelationQuery(q).drawings.map((a) => a.points[0].v)).toEqual([0.5, 1.5]);
    const warn = silenceWarn();
    expect(parseCorrelationQuery(`${BASE}&ann=%7Bnot-json`).drawings).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('sheds labels before any drawing, and drawings before any trailing Y', () => {
    const warn = silenceWarn();
    const many = Array.from({ length: 8 }, (_, i) => `PV:${'Z'.repeat(380)}:${i}`);
    // Each drawing is ~20 bytes once its Y is in the reference table: not all 40 fit.
    const drawings = Array.from({ length: 40 }, (_, i) => line(i, { axisId: many[0] }));
    const s = state({
      ys: many,
      labels: { [many[0]]: 'gone first' },
      drawings,
    });
    const { query, shed } = serializeCorrelationQueryWithShed(s);
    expect(bytes(query)).toBeLessThanOrEqual(MAX_QUERY_BYTES - PAGE_KEY_RESERVE);
    const back = parseCorrelationQuery(query);
    expect(back.ys).toEqual(many);
    expect(back.labels).toEqual({});
    expect(shed.dropped).toBeGreaterThan(0);
    expect(back.drawings.length).toBe(drawings.length - shed.dropped);
    expect(back.drawings.length).toBeGreaterThan(0);
    // Dropped from the end: what remains is a prefix.
    expect(back.drawings.map((a) => a.points[0].v)).toEqual(
      drawings.slice(0, back.drawings.length).map((a) => a.points[0].v)
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('kept 8 of 8 Y PVs');
  });

  it('an incoming link over 4 KB is read without its drawings when that fits', () => {
    const warn = silenceWarn();
    const ann = encodeJsonParam({
      r: [Y1],
      b: [],
      d: [[code('note'), [0, 1], 0, null, '', 'x'.repeat(200)]],
    });
    const q = `${BASE}&fit=0&ann=${ann}${'&ann=x'.repeat(700)}`;
    expect(bytes(q)).toBeGreaterThan(MAX_QUERY_BYTES);
    const s = parseCorrelationQuery(q);
    expect(s.ys).toEqual([Y1, Y2]);
    expect(s.fit).toBe(false);
    expect(s.drawings).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/ignoring its drawings/);
  });

  it('an incoming link still over 4 KB without its drawings opens the defaults', () => {
    const warn = silenceWarn();
    const q = `${BASE}&xl=${'a'.repeat(MAX_QUERY_BYTES)}&ann=%7B%7D`;
    expect(parseCorrelationQuery(q)).toEqual(defaultCorrelationState());
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
