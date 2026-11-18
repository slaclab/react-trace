// One source's site settings, key by key: a good value passes as written (a
// metric list decoded, a lookback without whitespace), a bad one, an unknown
// key or a section that is not an object is dropped, and every source warns
// once, naming each key dropped. `$` keys are notes; a version other than 1
// drops the whole source.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultMetrics } from '../statistics/model';
import { CORRELATION_METRICS } from '../tools/correlation/metrics';
import { SITE_KEYS, validateSiteConfig } from './validate';

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validateSiteConfig', () => {
  it('passes every good value as written and warns nothing', () => {
    const raw = {
      version: 1,
      $comment: 'a note',
      header: {
        prefix: 'Lab',
        brand: true,
        bugReportUrl: 'https://example.org/issues',
        docsUrl: 'http://example.org/docs/',
      },
      plot: { wheel: 'x', yAxisDrag: 'pan', doubleClick: 'none', tooltip: 'cursor' },
      trace: {
        plot: {
          wheel: 'xy',
          showCrosshair: true,
          dragMode: 'pan',
          showLegend: false,
          showXGridlines: false,
          showYGridlines: true,
          gridStyle: 'dashed',
          gridOpacity: 0.5,
          tickFontSize: 14,
          refreshIntervalS: 10,
          palette: 'viridis',
          timeRange: '-30m',
          archiver: 'arch-b',
          showDrawingTools: false,
        },
        trace: { lineWidth: 3, lineType: 'direct', showSymbol: true },
      },
      correlation: {
        plot: { tooltip: 'docked' },
        lookback: '30m',
        dt: 0.5,
        metrics: ['n', 'mean'],
        drawingTools: false,
      },
      waveform: { rollS: 120, metrics: ['n'], drawingTools: false },
    };
    const config = validateSiteConfig(raw, 'config.json');
    expect(warn).not.toHaveBeenCalled();
    expect(config.header).toEqual(raw.header);
    expect(config.plot).toEqual(raw.plot);
    expect(config.trace).toEqual(raw.trace);
    expect(config.correlation?.lookback).toBe('30m');
    expect(config.correlation?.dt).toBe(0.5);
    expect(config.correlation?.metrics?.map((m) => m.id)).toEqual(['n', 'mean']);
    expect(config.waveform?.rollS).toBe(120);
    expect('$comment' in config).toBe(false);
    expect('version' in config).toBe(false);
  });

  it('drops each bad value and unknown key, naming them all in one warning', () => {
    const config = validateSiteConfig(
      {
        header: { prefix: 'x'.repeat(41), docsUrl: 'javascript:alert(1)', colour: '#123456' },
        plot: { wheel: 'time', tooltip: 'docked' },
        trace: {
          plot: {
            tickFontSize: 5,
            refreshIntervalS: 61,
            gridOpacity: 1.5,
            dragMode: 'drag',
            timeRange: '1h',
            archiver: '',
            palette: 'no-such-palette',
            showCrosshair: 'yes',
          },
          trace: { lineWidth: 21, liveRetentionS: 600 },
        },
        correlation: { lookback: '30s', dt: 0.05, metrics: ['n', 'nope'] },
        waveform: { rollS: 0.5 },
        theme: 'dark',
      },
      'config.json'
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('config.json');
    for (const key of [
      'header.colour',
      'trace.trace.liveRetentionS',
      'theme',
      'header.prefix',
      'header.docsUrl',
      'plot.wheel',
      'trace.plot.tickFontSize',
      'trace.plot.refreshIntervalS',
      'trace.plot.gridOpacity',
      'trace.plot.dragMode',
      'trace.plot.timeRange',
      'trace.plot.archiver',
      'trace.plot.palette',
      'trace.plot.showCrosshair',
      'trace.trace.lineWidth',
      'correlation.lookback',
      'correlation.dt',
      'correlation.metrics',
      'waveform.rollS',
    ]) {
      expect(message).toContain(key);
    }
    expect(config).toEqual({
      header: {},
      plot: { tooltip: 'docked' },
      trace: { plot: {}, trace: {} },
      correlation: {},
      waveform: {},
    });
  });

  it('stores the default palette as none, as a plot does', () => {
    const config = validateSiteConfig({ trace: { plot: { palette: 'default' } } }, 'config.json');
    expect(warn).not.toHaveBeenCalled();
    expect(config.trace?.plot).toHaveProperty('palette', undefined);
  });

  it('takes null as the archiver for Canopy’s default', () => {
    const config = validateSiteConfig({ trace: { plot: { archiver: null } } }, 'config.json');
    expect(warn).not.toHaveBeenCalled();
    expect(config.trace?.plot).toHaveProperty('archiver', undefined);
  });

  it('removes whitespace from a lookback and keeps a metric list decoded', () => {
    const config = validateSiteConfig(
      { correlation: { lookback: ' 2 h ', metrics: ['n', '-mean'] } },
      'config.json'
    );
    expect(config.correlation?.lookback).toBe('2h');
    const n = defaultMetrics(CORRELATION_METRICS).find((m) => m.id === 'n');
    expect(config.correlation?.metrics?.[0]).toEqual(n);
    expect(config.correlation?.metrics?.[1].on).toBe(false);
  });

  it('refuses an empty metric list (a link cannot carry one)', () => {
    const config = validateSiteConfig({ waveform: { metrics: [] } }, 'config.json');
    expect(config.waveform).toEqual({});
    expect(String(warn.mock.calls[0][0])).toContain('waveform.metrics');
  });

  it('drops a section that is not an object', () => {
    const config = validateSiteConfig({ trace: [], header: 'x' }, 'Canopy site settings');
    expect(config).toEqual({});
    expect(String(warn.mock.calls[0][0])).toContain('Canopy site settings');
  });

  it('ignores a source that is not an object, or of another version, with one warning', () => {
    expect(validateSiteConfig([], 'config.json')).toEqual({});
    expect(validateSiteConfig('x', 'config.json')).toEqual({});
    expect(validateSiteConfig({ version: 2, plot: { wheel: 'x' } }, 'config.json')).toEqual({});
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('never reads a key off the prototype', () => {
    const config = validateSiteConfig(
      JSON.parse('{"__proto__":{"x":1},"constructor":1,"header":{"toString":1}}'),
      'config.json'
    );
    expect(config).toEqual({ header: {} });
    expect(String(warn.mock.calls[0][0])).toContain('constructor');
  });
});

describe('SITE_KEYS', () => {
  it('lists every settable key as a dotted path', () => {
    expect(SITE_KEYS).toContain('header.prefix');
    expect(SITE_KEYS).toContain('plot.wheel');
    expect(SITE_KEYS).toContain('trace.plot.showCrosshair');
    expect(SITE_KEYS).toContain('trace.trace.lineWidth');
    expect(SITE_KEYS).toContain('correlation.plot.tooltip');
    expect(SITE_KEYS).toContain('waveform.rollS');
    expect(SITE_KEYS).not.toContain('trace.trace.liveRetentionS');
  });
});
