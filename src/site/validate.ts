// One source's site settings, checked key by key (docs/site-defaults.md).
//
// A value passes only when it is one a user could set in the tool's own
// fields: the same kinds, ranges and options. The keys a site shares with
// Trace's `plot=` link use the link's checks (`isPlotFieldValue`,
// `isTraceFieldValue`), which the schema coupling test holds to the
// Inspector's fields. A bad value, an unknown key or a section that is not an
// object is dropped; one `console.warn` per source names every key dropped.
// Keys starting with `$` (`$comment`, `$schema`) are notes and are skipped.
// A `version` other than 1 drops the whole source with one warning.
import { relativeRangeMs, parseSpanMs } from '../api/time';
import { isPlotFieldValue, isTraceFieldValue } from '../embed/plotConfig';
import { DOUBLE_CLICKS, WHEEL_ZOOMS, Y_AXIS_DRAGS } from '../plot/gesturePrefs';
import { decodeMetricTokens, MAX_METRICS, type MetricCatalog } from '../statistics/model';
import { CORRELATION_METRICS } from '../tools/correlation/metrics';
import { MAX_LOOKBACK_MS, MIN_DT_S, MIN_LOOKBACK_MS } from '../tools/correlation/query';
import { WAVEFORM_METRICS } from '../tools/waveform/metrics';
import { MAX_ROLL_S, MIN_ROLL_S } from '../tools/waveform/query/state';
import { TOOLTIP_MODES, type SiteConfig } from './types';

/** The settings format this app reads. */
export const SITE_CONFIG_VERSION = 1;

/** The longest header prefix. */
export const MAX_PREFIX_LENGTH = 40;
/** The longest link URL. */
const MAX_URL_LENGTH = 2048;
/** The longest metric token. */
const MAX_TOKEN_LENGTH = 200;

/** A checked value, or null when the value is refused. */
type Rule = (v: unknown) => { value: unknown } | null;

interface Section {
  [key: string]: Section | Rule;
}

const pass = (value: unknown) => ({ value });

const bool: Rule = (v) => (typeof v === 'boolean' ? pass(v) : null);

const oneOf =
  (values: readonly string[]): Rule =>
  (v) =>
    typeof v === 'string' && values.includes(v) ? pass(v) : null;

const plotField =
  (key: Parameters<typeof isPlotFieldValue>[0]): Rule =>
  (v) =>
    isPlotFieldValue(key, v) ? pass(v) : null;

const traceField =
  (key: Parameters<typeof isTraceFieldValue>[0]): Rule =>
  (v) =>
    isTraceFieldValue(key, v) ? pass(v) : null;

// A relative range as the range controls write it: "-1h", "-30m", "-1.5h".
const timeRange: Rule = (v) =>
  typeof v === 'string' && !/\s/.test(v) && relativeRangeMs(v) !== null ? pass(v) : null;

// An archiver name, or null for Canopy's default archiver. Only its shape can
// be checked here: an unknown name shows as "No archiver" on each new plot.
const archiver: Rule = (v) => {
  if (v === null) return pass(undefined);
  if (typeof v !== 'string' || v.trim() === '') return null;
  return isPlotFieldValue('archiver', v.trim()) ? pass(v.trim()) : null;
};

// A span within Correlation's lookback range; whitespace removed, never clamped.
const lookback: Rule = (v) => {
  if (typeof v !== 'string') return null;
  const span = v.replace(/\s+/g, '');
  const ms = parseSpanMs(span);
  return ms !== null && ms >= MIN_LOOKBACK_MS && ms <= MAX_LOOKBACK_MS ? pass(span) : null;
};

const dt: Rule = (v) =>
  typeof v === 'number' && Number.isFinite(v) && v >= MIN_DT_S ? pass(v) : null;

const rollS: Rule = (v) =>
  Number.isInteger(v) && (v as number) >= MIN_ROLL_S && (v as number) <= MAX_ROLL_S
    ? pass(v)
    : null;

// The metric tokens of the tool's `m=` link key, in column order; refused
// whole when any token does not read.
const metrics =
  (catalog: MetricCatalog): Rule =>
  (v) => {
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_METRICS) return null;
    if (!v.every((t) => typeof t === 'string' && t.length <= MAX_TOKEN_LENGTH)) return null;
    let bad = false;
    const decoded = decodeMetricTokens(catalog, v as string[], () => (bad = true));
    return bad || decoded.length !== v.length ? null : pass(decoded);
  };

const prefix: Rule = (v) =>
  typeof v === 'string' && v.length <= MAX_PREFIX_LENGTH ? pass(v) : null;

// An absolute http(s) URL: the links open in a new tab, so nothing else
// (`javascript:`, a relative path) is taken.
const url: Rule = (v) => {
  if (typeof v !== 'string' || v.length > MAX_URL_LENGTH) return null;
  try {
    const parsed = new URL(v);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? pass(v) : null;
  } catch {
    return null;
  }
};

/** The plot behaviour every tool has: the shared `plot` section and each `<tool>.plot`. */
const PLOT_BEHAVIOUR: Section = {
  wheel: oneOf(WHEEL_ZOOMS),
  yAxisDrag: oneOf(Y_AXIS_DRAGS),
  doubleClick: oneOf(DOUBLE_CLICKS),
  tooltip: oneOf(TOOLTIP_MODES),
};

const SCHEMA: Section = {
  header: {
    prefix,
    brand: bool,
    bugReportUrl: url,
    docsUrl: url,
  },
  plot: PLOT_BEHAVIOUR,
  trace: {
    plot: {
      ...PLOT_BEHAVIOUR,
      showCrosshair: plotField('showCrosshair'),
      dragMode: plotField('dragMode'),
      showLegend: plotField('showLegend'),
      showXGridlines: plotField('showXGridlines'),
      showYGridlines: plotField('showYGridlines'),
      gridStyle: plotField('gridStyle'),
      gridOpacity: plotField('gridOpacity'),
      tickFontSize: plotField('tickFontSize'),
      refreshIntervalS: plotField('refreshIntervalS'),
      palette: plotField('palette'),
      timeRange,
      archiver,
      showDrawingTools: plotField('showDrawingTools'),
    },
    trace: {
      lineWidth: traceField('lineWidth'),
      lineType: traceField('lineType'),
      showSymbol: traceField('showSymbol'),
    },
  },
  correlation: {
    plot: PLOT_BEHAVIOUR,
    lookback,
    dt,
    metrics: metrics(CORRELATION_METRICS),
    drawingTools: bool,
  },
  waveform: {
    plot: PLOT_BEHAVIOUR,
    rollS,
    metrics: metrics(WAVEFORM_METRICS),
    drawingTools: bool,
  },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function keyPaths(section: Section, prefix: string): string[] {
  return Object.entries(section).flatMap(([key, node]) =>
    typeof node === 'function' ? [`${prefix}${key}`] : keyPaths(node, `${prefix}${key}.`)
  );
}

/** Every settable key as a dotted path (`trace.plot.showCrosshair`), in schema order. */
export const SITE_KEYS: readonly string[] = Object.freeze(keyPaths(SCHEMA, ''));

function walk(
  raw: Record<string, unknown>,
  section: Section,
  path: string,
  unknown: string[],
  invalid: string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('$')) continue;
    if (path === '' && key === 'version') continue;
    const node = Object.hasOwn(section, key) ? section[key] : undefined;
    const where = `${path}${key}`;
    if (node === undefined) {
      unknown.push(where);
    } else if (typeof node === 'function') {
      const checked = node(value);
      if (checked === null) invalid.push(where);
      else out[key] = checked.value;
    } else if (isRecord(value)) {
      out[key] = walk(value, node, `${where}.`, unknown, invalid);
    } else {
      invalid.push(where);
    }
  }
  return out;
}

/**
 * The settings `raw` holds that pass their checks. `source` names where it
 * came from in the one warning ("config.json", "Canopy site settings").
 */
export function validateSiteConfig(raw: unknown, source: string): SiteConfig {
  if (!isRecord(raw)) {
    console.warn(`Site defaults from ${source}: not a JSON object; ignoring it.`);
    return {};
  }
  if (Object.hasOwn(raw, 'version') && raw.version !== SITE_CONFIG_VERSION) {
    console.warn(
      `Site defaults from ${source}: version ${JSON.stringify(raw.version)} is not one this app reads (${SITE_CONFIG_VERSION}); ignoring it.`
    );
    return {};
  }
  const unknown: string[] = [];
  const invalid: string[] = [];
  const config = walk(raw, SCHEMA, '', unknown, invalid) as SiteConfig;
  if (unknown.length > 0 || invalid.length > 0) {
    const parts = [
      unknown.length > 0 ? `unknown ${unknown.join(', ')}` : '',
      invalid.length > 0 ? `invalid ${invalid.join(', ')}` : '',
    ].filter((p) => p !== '');
    console.warn(`Site defaults from ${source}: ignoring ${parts.join('; ')}.`);
  }
  return config;
}
