// The resolved defaults: the built-ins, then each source in order, later
// winning key by key; within a source the shared `plot` first and the tool's
// own `plot` after it. The built-ins themselves pass the validator, and the
// store holds them until the loader sets another record.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeMetricTokens } from '../statistics/model';
import { CORRELATION_METRICS } from '../tools/correlation/metrics';
import { WAVEFORM_METRICS } from '../tools/waveform/metrics';
import { BUILTIN_DEFAULTS } from './builtins';
import { resolveSiteDefaults } from './resolve';
import { resetSiteDefaults, setSiteDefaults, siteDefaults } from './store';
import { setSiteConfig } from './testing';
import { validateSiteConfig } from './validate';

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  resetSiteDefaults();
  vi.restoreAllMocks();
});

const resolve = (...raw: unknown[]) =>
  resolveSiteDefaults(raw.map((r) => validateSiteConfig(r, 'test')));

describe('resolveSiteDefaults', () => {
  it('is the built-ins without a source, frozen through', () => {
    const d = resolve();
    expect(d).toEqual(BUILTIN_DEFAULTS);
    expect(Object.isFrozen(d.trace.plot)).toBe(true);
    expect(Object.isFrozen(d.correlation.metrics)).toBe(true);
  });

  it('applies the shared plot section to every tool, over the built-in per-tool values', () => {
    const d = resolve({ plot: { tooltip: 'cursor', wheel: 'x' } });
    for (const tool of ['trace', 'correlation', 'waveform'] as const) {
      expect(d[tool].plot.tooltip).toBe('cursor');
      expect(d[tool].plot.wheel).toBe('x');
      expect(d[tool].plot.yAxisDrag).toBe(BUILTIN_DEFAULTS[tool].plot.yAxisDrag);
    }
  });

  it('lets a tool’s own plot section win over the shared one in the same source', () => {
    const d = resolve({ plot: { wheel: 'x' }, waveform: { plot: { wheel: 'xy' } } });
    expect(d.trace.plot.wheel).toBe('x');
    expect(d.correlation.plot.wheel).toBe('x');
    expect(d.waveform.plot.wheel).toBe('xy');
  });

  it('lets a later source win key by key, even its shared key over an earlier per-tool one', () => {
    const d = resolve(
      { trace: { plot: { wheel: 'x', showCrosshair: true } }, header: { prefix: 'A' } },
      { plot: { wheel: 'xy' }, header: { brand: true } }
    );
    expect(d.trace.plot.wheel).toBe('xy');
    expect(d.trace.plot.showCrosshair).toBe(true);
    expect(d.header).toEqual({ ...BUILTIN_DEFAULTS.header, prefix: 'A', brand: true });
  });

  it('takes a later null archiver as no archiver', () => {
    const d = resolve(
      { trace: { plot: { archiver: 'arch-a' } } },
      { trace: { plot: { archiver: null } } }
    );
    expect(d.trace.plot.archiver).toBeUndefined();
  });

  it('replaces a metric list whole and keeps the other tool’s', () => {
    const d = resolve({ correlation: { metrics: ['mean'] } });
    expect(d.correlation.metrics.map((m) => m.id)).toEqual(['mean']);
    expect(d.waveform.metrics).toEqual(BUILTIN_DEFAULTS.waveform.metrics);
  });
});

describe('the built-ins', () => {
  it('pass the validator as a config file would state them', () => {
    const b = BUILTIN_DEFAULTS;
    const { palette: _palette, archiver: _archiver, ...tracePlot } = b.trace.plot;
    void _palette;
    void _archiver;
    const raw = {
      version: 1,
      header: b.header,
      trace: { plot: tracePlot, trace: b.trace.trace },
      correlation: {
        ...b.correlation,
        metrics: encodeMetricTokens(CORRELATION_METRICS, b.correlation.metrics),
      },
      waveform: {
        ...b.waveform,
        metrics: encodeMetricTokens(WAVEFORM_METRICS, b.waveform.metrics),
      },
    };
    expect(resolve(raw)).toEqual(b);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the store', () => {
  it('holds the built-ins until set, and again after a reset', () => {
    expect(siteDefaults()).toBe(BUILTIN_DEFAULTS);
    const d = setSiteConfig({ header: { prefix: 'Lab' } });
    expect(siteDefaults()).toBe(d);
    expect(siteDefaults().header.prefix).toBe('Lab');
    resetSiteDefaults();
    expect(siteDefaults()).toBe(BUILTIN_DEFAULTS);
    setSiteDefaults(d);
    expect(siteDefaults()).toBe(d);
  });
});
