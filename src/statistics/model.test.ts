// The metric list model, exercised through Correlation's catalog: the normalizer's canonical form, the
// default check that keeps `m=` out of default queries, and the token grammar.
import { describe, expect, it } from 'vitest';
import { CORRELATION_METRICS, METRIC_UNITS, PRESETS } from '../tools/correlation/metrics';
import {
  decodeMetricToken,
  defaultMetrics,
  encodeMetricToken,
  metricsAreDefault,
  normalizeMetrics,
  presetMetric,
  type Metric,
} from './model';
import {
  MAX_METRIC_EXPR_LENGTH,
  MAX_METRIC_LABEL_LENGTH,
  MAX_METRICS,
  nextCustomId,
} from './model';

const custom = (over: Partial<Metric> = {}): Metric => ({
  id: 'c1',
  label: 'Ratio',
  expr: 'mean(y) / mean(x)',
  unit: '',
  on: true,
  strip: false,
  ...over,
});

describe('defaultMetrics', () => {
  it('is every preset in order, the first five on, no strips, within the cap', () => {
    const d = defaultMetrics(CORRELATION_METRICS);
    expect(d.map((m) => m.id)).toEqual(PRESETS.map((p) => p.id));
    expect(d.filter((m) => m.on).map((m) => m.id)).toEqual(['n', 'mean', 'std', 'r', 'slope']);
    expect(d.some((m) => m.strip)).toBe(false);
    expect(d.length).toBeLessThanOrEqual(MAX_METRICS);
    expect(normalizeMetrics(CORRELATION_METRICS, d)).toEqual(d);
  });
});

describe('normalizeMetrics', () => {
  it('drops later duplicates and unknown ids', () => {
    const out = normalizeMetrics(CORRELATION_METRICS, [
      custom(),
      custom({ label: 'second' }),
      custom({ id: 'bogus' }),
      custom({ id: 'c0' }),
      presetMetric(PRESETS[0]),
      presetMetric(PRESETS[0], false),
    ]);
    expect(out.map((m) => [m.id, m.label, m.on])).toEqual([
      ['c1', 'Ratio', true],
      ['n', 'n', true],
    ]);
  });

  it(`caps the list at ${MAX_METRICS}`, () => {
    const many = Array.from({ length: MAX_METRICS + 3 }, (_, i) => custom({ id: `c${i + 1}` }));
    const out = normalizeMetrics(CORRELATION_METRICS, many);
    expect(out).toHaveLength(MAX_METRICS);
    expect(out.at(-1)?.id).toBe(`c${MAX_METRICS}`);
  });

  it("re-stamps a preset's label, expression and unit, keeping on and strip", () => {
    const r = PRESETS.find((p) => p.id === 'r')!;
    expect(
      normalizeMetrics(CORRELATION_METRICS, [
        { id: 'r', label: 'x', expr: 'n', unit: 'y', on: false, strip: true },
      ])
    ).toEqual([{ ...presetMetric(r, false), strip: true }]);
  });

  it("cleans a custom: trims, removes '=', caps label and expression", () => {
    const [m] = normalizeMetrics(CORRELATION_METRICS, [
      custom({
        label: `  a=b${'L'.repeat(50)}  `,
        expr: ` x = ${'y'.repeat(200)} `,
      }),
    ]);
    expect(m.label).toBe(`ab${'L'.repeat(MAX_METRIC_LABEL_LENGTH - 2)}`);
    expect(m.label).toHaveLength(MAX_METRIC_LABEL_LENGTH);
    expect(m.expr).toHaveLength(MAX_METRIC_EXPR_LENGTH);
    expect(m.expr.startsWith('x  y')).toBe(true);
    expect(m.expr).not.toContain('=');
  });

  it("sets a bad unit to '' and coerces on/strip to booleans", () => {
    const bad = { ...custom(), unit: 'mm', on: 1, strip: 'yes' } as unknown as Metric;
    expect(normalizeMetrics(CORRELATION_METRICS, [bad])[0]).toMatchObject({
      unit: '',
      on: false,
      strip: false,
    });
  });

  it('is idempotent and accepts undefined', () => {
    const once = normalizeMetrics(CORRELATION_METRICS, [
      custom({ label: ' a=b ' }),
      presetMetric(PRESETS[2], false),
    ]);
    expect(normalizeMetrics(CORRELATION_METRICS, once)).toEqual(once);
    expect(normalizeMetrics(CORRELATION_METRICS, undefined)).toEqual([]);
  });
});

describe('metricsAreDefault', () => {
  it('holds for the default list only', () => {
    const d = defaultMetrics(CORRELATION_METRICS);
    expect(metricsAreDefault(CORRELATION_METRICS, d)).toBe(true);
    expect(metricsAreDefault(CORRELATION_METRICS, d.slice(1))).toBe(false);
    expect(metricsAreDefault(CORRELATION_METRICS, [d[1], d[0], ...d.slice(2)])).toBe(false);
    expect(
      metricsAreDefault(
        CORRELATION_METRICS,
        d.map((m, i) => (i === 0 ? { ...m, strip: true } : m))
      )
    ).toBe(false);
    expect(
      metricsAreDefault(
        CORRELATION_METRICS,
        d.map((m, i) => (i === 5 ? { ...m, on: true } : m))
      )
    ).toBe(false);
    expect(metricsAreDefault(CORRELATION_METRICS, [])).toBe(false);
  });
});

describe('nextCustomId', () => {
  it('is the highest custom id plus one, ignoring presets', () => {
    expect(nextCustomId([])).toBe('c1');
    expect(nextCustomId(defaultMetrics(CORRELATION_METRICS))).toBe('c1');
    expect(nextCustomId([custom({ id: 'c3' }), custom({ id: 'c1' })])).toBe('c4');
  });
});

describe('metric tokens', () => {
  it('round-trips every preset with every flag combination', () => {
    for (const p of PRESETS) {
      for (const on of [true, false]) {
        for (const strip of [true, false]) {
          const m = { ...presetMetric(p, on), strip };
          const token = encodeMetricToken(CORRELATION_METRICS, m);
          expect(token).toBe(`${on ? '' : '-'}${strip ? '~' : ''}${p.id}`);
          expect(decodeMetricToken(CORRELATION_METRICS, token, 'c1')).toEqual(m);
        }
      }
    }
  });

  it('round-trips a custom with each unit, the unit omitted when none', () => {
    for (const unit of METRIC_UNITS) {
      const m = custom({ id: 'c4', unit, on: false, strip: true });
      const token = encodeMetricToken(CORRELATION_METRICS, m);
      expect(token).toBe(`-~Ratio=mean(y) / mean(x)${unit === '' ? '' : `=${unit}`}`);
      expect(decodeMetricToken(CORRELATION_METRICS, token, 'c4')).toEqual(m);
    }
  });

  it("accepts the flags only as '-' then '~'", () => {
    expect(decodeMetricToken(CORRELATION_METRICS, '-~r', 'c1')).toMatchObject({
      id: 'r',
      on: false,
      strip: true,
    });
    expect(decodeMetricToken(CORRELATION_METRICS, '~-r', 'c1')).toBeNull();
  });

  it('keeps an empty expression (a metric still being written) and a flag-free label', () => {
    expect(decodeMetricToken(CORRELATION_METRICS, 'Metric 1=', 'c1')).toEqual({
      id: 'c1',
      label: 'Metric 1',
      expr: '',
      unit: '',
      on: true,
      strip: false,
    });
    const fresh: Metric = {
      id: 'c1',
      label: 'Metric 1',
      expr: '',
      unit: '',
      on: true,
      strip: false,
    };
    expect(
      decodeMetricToken(CORRELATION_METRICS, encodeMetricToken(CORRELATION_METRICS, fresh), 'c1')
    ).toEqual(fresh);
    // A label that starts with a flag character would decode as that flag.
    expect(normalizeMetrics(CORRELATION_METRICS, [{ ...fresh, label: '-~ dev' }])[0]?.label).toBe(
      'dev'
    );
    const flagged = normalizeMetrics(CORRELATION_METRICS, [
      { ...fresh, label: '-dev', expr: 'std(y)' },
    ])[0];
    expect(flagged).toBeDefined();
    if (flagged)
      expect(
        decodeMetricToken(
          CORRELATION_METRICS,
          encodeMetricToken(CORRELATION_METRICS, flagged),
          'c1'
        )
      ).toEqual(flagged);
  });

  it('rejects structurally bad tokens', () => {
    for (const token of ['', '-', '-~', 'kurtosis', '=mean(y)', ' = ', 'a=b=y=x', 'a=b=mm']) {
      expect(decodeMetricToken(CORRELATION_METRICS, token, 'c1'), token).toBeNull();
    }
  });

  it('rejects a custom body with a bad custom id, but not a preset', () => {
    expect(decodeMetricToken(CORRELATION_METRICS, 'a=b', 'x1')).toBeNull();
    expect(decodeMetricToken(CORRELATION_METRICS, 'a=b', 'c0')).toBeNull();
    expect(decodeMetricToken(CORRELATION_METRICS, 'r', 'x1')).toMatchObject({ id: 'r' });
  });
});
