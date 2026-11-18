import { storedMetrics } from '../tools/trace/metrics';
import type { Plot, PVTrace, Axis } from '../types';
import type { ColorMode } from '@slaclab/canopy-shell/color-mode';
import { getPalette, colorForIndex, DEFAULT_PALETTE_ID } from '../palettes';
import { parseSpanMs, toDatetimeLocal } from '../api/time';
import { chartThemeFor } from '@slaclab/canopy-charts';
import { effectiveBackground, isThemeDefaultBackground } from '../plotBackground';
import { withFilePalette } from './paletteInference';
import { BUILTIN_CATALOG } from '../annotations/catalog';
import type { Catalog } from '../annotations/catalog/types';
import { TIME_X_AXIS } from '../annotations/catalog/xAxis';
import { validateAnnotationIn, type Annotation } from '../annotations/model';
import { reassignUnknownAxes, withAnnotations } from '../tools/trace/drawing/plotDrawings';
import { TRACE_DEFAULT_DRAG } from '../tools/trace/plotView';

// Native save format — a superset of what's currently in app state plus a
// schema version for forward compatibility. Bumping schemaVersion means the
// loader rejects (or migrates) older files. Keep field names mirror app types
// so a round-trip is just JSON.parse/stringify.
//
// The version stays 1 and the shape stays today's, so a pre-workbench
// Trace still opens a new file. Two value rules carry the "automatic" settings
// without a marker:
//   - Background: the writer writes the resolved background (a theme default
//     when automatic); the reader takes a theme-default value as automatic.
//     Old and new readers therefore draw the same thing.
//   - Live retention: a pinned retention is written under `liveRetentionMs`,
//     main's key, so main honours it too. Main stamped its default, 300 s, on
//     every curve, so that value reads as automatic, as does one outside the
//     field's 5–1800 s. A pin of exactly 300 s therefore goes under
//     `LIVE_RETENTION_PIN_KEY` instead, a key main never used: main ignores
//     it (and keeps it on re-save, its rehydrate spreads) and applies its own
//     300 s default, the same value. Reading, an in-range `liveRetentionMs`
//     other than 300 s wins, then the pin key; anything else is automatic.
export const SCHEMA_VERSION = 1;

/** The `.trc.json` curve key a pinned live retention of main's default (300 s) is stored under. */
export const LIVE_RETENTION_PIN_KEY = 'liveRetentionPinMs';

/** A curve as written to `.trc.json`: `liveRetentionMs` and maybe the pin key. */
export type WireTrace = PVTrace & { [LIVE_RETENTION_PIN_KEY]?: number };

// Main's default retention, stamped on every curve it saved: automatic here.
const STAMPED_RETENTION_MS = 300_000;
// The Live retention field's range (5–1800 s); outside it, a saved value is automatic.
const RETENTION_MIN_MS = 5_000;
const RETENTION_MAX_MS = 1_800_000;

/** Whether a saved `liveRetentionMs` is a per-curve pin (not main's stamp, in range). */
function isPinnedLegacyRetention(ms: unknown): ms is number {
  return (
    typeof ms === 'number' &&
    Number.isFinite(ms) &&
    ms !== STAMPED_RETENTION_MS &&
    ms >= RETENTION_MIN_MS &&
    ms <= RETENTION_MAX_MS
  );
}

/** A plot as written to `.trc.json`: background resolved, wire curves. */
export type WirePlot = Omit<Plot, 'traces' | 'backgroundColor'> & {
  backgroundColor: string;
  traces: WireTrace[];
};

export interface TraceWorkspace {
  schemaVersion: number;
  savedAt: string; // ISO 8601
  theme: ColorMode;
  plots: WirePlot[];
}

// Build the workspace object the config store persists as its JSON `data`.
export function serializeConfigData(args: { theme: ColorMode; plots: Plot[] }): TraceWorkspace {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    theme: args.theme,
    plots: args.plots.map((p) => toWirePlot(p, args.theme)),
  };
}

// String form for a .trc.json file/export; the config store uses serializeConfigData.
export function serializeWorkspace(args: { theme: ColorMode; plots: Plot[] }): string {
  return JSON.stringify(serializeConfigData(args), null, 2);
}

// `data` is the per-trace mock array for live previews; it's regenerated at
// runtime, no point persisting it. Strip on save, fill back with [] on load.
// The background is written resolved so an old reader draws it as the
// new one does. Drawings ride on the spread; `withAnnotations`
// keeps an empty list off the wire, so add-then-delete saves byte-equal.
function toWirePlot(plot: Plot, theme: ColorMode): WirePlot {
  return {
    ...withAnnotations(plot, plot.annotations ?? []),
    backgroundColor: effectiveBackground(plot.backgroundColor, chartThemeFor(theme)),
    traces: plot.traces.map(toWireTrace),
  };
}

function toWireTrace(trace: PVTrace): WireTrace {
  const { liveRetentionMs, ...rest } = trace;
  const out: WireTrace = { ...rest, data: [] };
  if (liveRetentionMs === undefined) return out;
  if (isPinnedLegacyRetention(liveRetentionMs)) out.liveRetentionMs = liveRetentionMs;
  else out[LIVE_RETENTION_PIN_KEY] = liveRetentionMs;
  return out;
}

export interface DeserializeResult {
  source: 'native' | 'legacy-trc';
  theme?: ColorMode;
  plots: Plot[];
  warnings: string[];
}

/** What the reader validates a file's drawings against. */
export interface DeserializeOptions {
  /** The app's drawing tools; a drawing of another kind is dropped. Default: Trace's built-ins. */
  catalog?: Catalog;
}

// Parse the string form (a .trc.json file or export). The config store, which
// holds an already-parsed JSON object, uses deserializeConfigData instead.
export function deserializeWorkspace(
  text: string,
  options: DeserializeOptions = {}
): DeserializeResult {
  return deserializeConfigData(JSON.parse(text), options);
}

// Build a workspace from a parsed JSON value — the native (object) entry used by
// the magpie config store, where `data` is JSON, not a string. deserializeWorkspace
// is the thin string wrapper over this. Validates untrusted input (?config= links,
// hand-edited files) before the cast so malformed shapes hit the caller's error
// path rather than crashing the render body.
export function deserializeConfigData(
  data: unknown,
  options: DeserializeOptions = {}
): DeserializeResult {
  const catalog = options.catalog ?? BUILTIN_CATALOG;
  if (!data || typeof data !== 'object') throw new Error('Invalid workspace: not an object');
  const obj = data as Record<string, unknown>;

  // Native format identification by schemaVersion.
  if (typeof obj.schemaVersion === 'number') {
    if (obj.schemaVersion > SCHEMA_VERSION) {
      throw new Error(
        `File schema version ${obj.schemaVersion} is newer than the app understands (${SCHEMA_VERSION}). Update the app.`
      );
    }
    const rawPlots = Array.isArray(obj.plots) ? obj.plots : [];
    const plotIds = new Set<string>();
    rawPlots.forEach((rawPlot, i) => {
      assertPlotShape(rawPlot, i);
      if (plotIds.has(rawPlot.id)) {
        throw new Error(`Invalid workspace: duplicate plot id '${rawPlot.id}'`);
      }
      plotIds.add(rawPlot.id);
    });
    let plots = (rawPlots as Plot[]).map((p) => rehydratePlot(p, catalog));
    // Migrate the old workspace-level default archiver onto each plot that
    // doesn't already carry one (the default is now per-plot).
    if (typeof obj.globalArchiver === 'string') {
      const legacyDefault = obj.globalArchiver;
      plots = plots.map((p) => (p.archiver === undefined ? { ...p, archiver: legacyDefault } : p));
    }
    // Saves from before the month preset rename used "-1m" for one month.
    if (isMonthEraSave(obj.savedAt)) plots = plots.map(migrateMonthPreset);
    // A plot that states no palette opens in the one its curve colours imply
    //, so an untouched old file shows no Palette dot.
    plots = plots.map(withFilePalette);
    return {
      source: 'native',
      // Narrow to the supported literals; an untrusted theme (e.g. "sepia" from a
      // share link) is dropped rather than cast and handed to setColorMode.
      theme: obj.theme === 'light' || obj.theme === 'dark' ? obj.theme : undefined,
      plots,
      warnings: [],
    };
  }

  // Legacy PyDM Trace 1.0 .trc files: a single-plot workspace with `curves`,
  // `y-axes`, `time_axis`, `plot`, `archiver_url`. Best-effort mapping; some
  // fields don't have analogues in our model.
  if ('curves' in obj && 'y-axes' in obj) {
    return convertLegacyTrc(obj);
  }

  throw new Error('Unrecognized file format');
}

// Structural check for the fields the render path dereferences without guards.
// rehydratePlot defaults the optional display fields, so only id, xAxis.timeRange,
// and array traces/axes are required.
function assertPlotShape(p: unknown, i: number): asserts p is Plot {
  const where = `plots[${i}]`;
  if (!p || typeof p !== 'object') throw new Error(`Invalid workspace: ${where} is not an object`);
  const plot = p as Record<string, unknown>;
  if (typeof plot.id !== 'string' || plot.id === '')
    throw new Error(`Invalid workspace: ${where} is missing an id`);
  const xAxis = plot.xAxis as Record<string, unknown> | undefined;
  if (!xAxis || typeof xAxis.timeRange !== 'string')
    throw new Error(`Invalid workspace: ${where} is missing xAxis.timeRange`);
  if (!Array.isArray(plot.traces))
    throw new Error(`Invalid workspace: ${where}.traces is not an array`);
  if (!Array.isArray(plot.axes))
    throw new Error(`Invalid workspace: ${where}.axes is not an array`);
  // Validate elements too: the render path maps trace.data and reads axis.visible,
  // so a malformed entry from a ?config= link crashes past the array check.
  plot.traces.forEach((t, j) => {
    if (!t || typeof t !== 'object')
      throw new Error(`Invalid workspace: ${where}.traces[${j}] is not an object`);
    const trace = t as Record<string, unknown>;
    if (typeof trace.id !== 'string' || trace.id === '')
      throw new Error(`Invalid workspace: ${where}.traces[${j}] is missing an id`);
    if (
      trace.kind === 'formula' &&
      trace.expression !== undefined &&
      typeof trace.expression !== 'string'
    ) {
      throw new Error(`Invalid workspace: ${where}.traces[${j}].expression must be a string`);
    }
    if (trace.data !== undefined) {
      if (!Array.isArray(trace.data))
        throw new Error(`Invalid workspace: ${where}.traces[${j}].data is not an array`);
      // The render path reads p.time / p.value off each point (PlotArea).
      trace.data.forEach((p, k) => {
        if (!p || typeof p !== 'object')
          throw new Error(`Invalid workspace: ${where}.traces[${j}].data[${k}] is not an object`);
        const point = p as Record<string, unknown>;
        if (typeof point.time !== 'number' || !Number.isFinite(point.time))
          throw new Error(
            `Invalid workspace: ${where}.traces[${j}].data[${k}].time must be a finite number`
          );
        if (typeof point.value !== 'number' || !Number.isFinite(point.value))
          throw new Error(
            `Invalid workspace: ${where}.traces[${j}].data[${k}].value must be a finite number`
          );
      });
    }
  });
  plot.axes.forEach((a, j) => {
    if (!a || typeof a !== 'object')
      throw new Error(`Invalid workspace: ${where}.axes[${j}] is not an object`);
    if (typeof (a as Record<string, unknown>).id !== 'string')
      throw new Error(`Invalid workspace: ${where}.axes[${j}] is missing an id`);
  });
}

function rehydratePlot(p: Plot, catalog: Catalog): Plot {
  // Older saved workspaces used a single `showGridlines` flag and lacked grid
  // opacity / tick font size. Migrate the old flag to both X and Y toggles and
  // default the rest so loaded plots render the same as before.
  const legacy = p as Plot & { showGridlines?: boolean };
  const plot: Plot = {
    ...p,
    // Older saved workspaces predate showLegend; default to shown.
    showLegend: p.showLegend ?? true,
    // Older saved workspaces predate the crosshair flag; default to Trace's (off).
    showCrosshair: p.showCrosshair ?? false,
    showXGridlines: p.showXGridlines ?? legacy.showGridlines ?? true,
    showYGridlines: p.showYGridlines ?? legacy.showGridlines ?? true,
    gridOpacity: p.gridOpacity ?? 1,
    tickFontSize: p.tickFontSize ?? 11,
    backgroundColor: automaticBackground(p.backgroundColor),
    showStats: p.showStats === true ? true : undefined,
    showDist: p.showDist === true ? true : undefined,
    // A saved list is kept only off the default (DESIGN S8).
    metrics: Array.isArray(p.metrics) ? storedMetrics(p.metrics) : undefined,
    traces: (p.traces ?? []).map(rehydrateTrace),
  };
  // The drag mode is stored only off Trace's default.
  if (plot.dragMode === TRACE_DEFAULT_DRAG) delete plot.dragMode;
  return withAnnotations(plot, rehydrateAnnotations(p.annotations, plot.axes ?? [], catalog));
}

// Each saved drawing is validated (a bad one is dropped with its
// own warning); drawings on an axis the plot no longer has move to its first
// axis with one warning for the plot. A missing or empty list is none.
function rehydrateAnnotations(raw: unknown, axes: readonly Axis[], catalog: Catalog): Annotation[] {
  if (!Array.isArray(raw)) return [];
  const valid = raw
    .map((item) => validateAnnotationIn(catalog, item, TIME_X_AXIS, 'Trace'))
    .filter((a): a is Annotation => a !== null);
  const moved = reassignUnknownAxes(valid, axes);
  if (moved !== valid) console.warn('Trace: moved drawings on an unknown axis to the first axis');
  return moved;
}

// A theme-default (or absent / non-string) background is automatic.
function automaticBackground(bg: unknown): string | undefined {
  if (typeof bg !== 'string' || isThemeDefaultBackground(bg)) return undefined;
  return bg;
}

// Live retention: an in-range `liveRetentionMs` other than main's stamped
// 300 s pins, as on main; else the pin key, with a positive finite number;
// else automatic.
function rehydrateTrace(t: PVTrace): PVTrace {
  const wire = t as PVTrace & { [LIVE_RETENTION_PIN_KEY]?: unknown };
  const { [LIVE_RETENTION_PIN_KEY]: pin, liveRetentionMs: legacy, ...rest } = wire;
  // `data` is regenerated at runtime, never read from a file: a sample there
  // would reach the chart and its read-out unchecked.
  const out: PVTrace = { ...rest, data: [] };
  if (isPinnedLegacyRetention(legacy)) out.liveRetentionMs = legacy;
  else if (typeof pin === 'number' && Number.isFinite(pin) && pin > 0) out.liveRetentionMs = pin;
  return out;
}

// #66 (b92fbf1) renamed the month preset from "-1m" to "-1M" and made lowercase
// m mean minutes; the cutoff is #66's GitHub mergedAt. Before it, "-1m" in a
// native file could only be the month preset; after it, "-1m" is a typed
// one-minute span.
// Every native save stamps savedAt (since 98e35fe), which tells the two apart.
// Merge time, not deploy time: builds from this instant on already saved typed
// minutes as "-1m", so a later cutoff would turn those into months.
const MONTH_PRESET_RENAMED_AT_MS = Date.parse('2026-07-17T16:15:54Z');

// A missing or unparseable savedAt (e.g. a hand-written file) gets today's
// meaning: minutes.
function isMonthEraSave(savedAt: unknown): boolean {
  if (typeof savedAt !== 'string') return false;
  const ms = Date.parse(savedAt);
  return Number.isFinite(ms) && ms < MONTH_PRESET_RENAMED_AT_MS;
}

function migrateMonthPreset(p: Plot): Plot {
  return p.xAxis?.timeRange === '-1m' ? { ...p, xAxis: { ...p.xAxis, timeRange: '-1M' } } : p;
}

interface LegacyAxis {
  name: string;
  orientation?: string;
  minRange?: number;
  maxRange?: number;
  autoRange?: boolean;
  logMode?: boolean;
}

interface LegacyCurve {
  channel?: string;
  name?: string;
  color?: string;
  lineWidth?: number;
  lineStyle?: number;
  yAxisName?: string;
  useArchiveData?: boolean;
  liveData?: boolean;
}

interface LegacyFormula {
  // f://-prefixed expression with {var} placeholders, e.g. "f://{x1}+{x2}".
  formula?: string;
  // Variable name -> PV channel name of a base curve on the same plot.
  curveDict?: Record<string, string>;
  name?: string;
  color?: string;
  lineWidth?: number;
  lineStyle?: number;
  yAxisName?: string;
}

type LegacyTime = { start?: string; end?: string };

// Map a legacy `time_axis` to our xAxis. A relative `start` ("-1d") with an
// open end becomes a relative range; absolute bounds become a custom From/To
// range (open end resolves to "now" at fetch time). Otherwise fall back to -1h.
function mapLegacyTimeRange(time: LegacyTime, warnings: string[]): Plot['xAxis'] {
  const { start, end } = time;
  const endIsNow = !end || end === 'now';

  if (start && start.startsWith('-') && parseSpanMs(start.slice(1)) !== null && endIsNow) {
    // Normalize a bare minute span ("-1m") onto the new month/minute scheme is
    // unnecessary here: legacy minutes already meant minutes, so keep as-is.
    return { timeRange: start };
  }

  const startMs = start ? new Date(start).getTime() : NaN;
  if (Number.isFinite(startMs)) {
    const xAxis: Plot['xAxis'] = { timeRange: 'custom', timeFrom: toDatetimeLocal(startMs) };
    if (!endIsNow) {
      const endMs = new Date(end as string).getTime();
      if (Number.isFinite(endMs)) {
        xAxis.timeTo = toDatetimeLocal(endMs);
      } else {
        warnings.push(`Legacy end time '${end}' not understood; treated as 'now'.`);
      }
    }
    return xAxis;
  }

  if (start || end) {
    warnings.push(`Legacy time range not understood; defaulted to '-1h'.`);
  }
  return { timeRange: '-1h' };
}

function convertLegacyTrc(obj: Record<string, unknown>): DeserializeResult {
  const warnings: string[] = [];

  const legacyPlot = (obj.plot ?? {}) as Record<string, unknown>;
  const legacyAxes = (obj['y-axes'] ?? []) as LegacyAxis[];
  const legacyCurves = (obj.curves ?? []) as LegacyCurve[];
  const legacyFormulas = (obj.formula ?? []) as LegacyFormula[];
  const legacyTime = (obj.time_axis ?? {}) as { start?: string; end?: string };

  // Map y-axes; remember the axis name → id mapping so curves can resolve.
  const axes: Axis[] = legacyAxes.map((a, i) => ({
    id: `axis-${i + 1}`,
    name: a.name ?? `Axis ${i + 1}`,
    orientation: a.orientation === 'right' ? 'right' : 'left',
    min: a.minRange,
    max: a.maxRange,
    autoScale: a.autoRange ?? true,
    logScale: a.logMode ?? false,
    visible: true,
  }));
  const axisIdByName = new Map<string, string>();
  for (let i = 0; i < legacyAxes.length; i++) {
    axisIdByName.set(legacyAxes[i].name, axes[i].id);
  }
  if (axes.length === 0) {
    axes.push({
      id: 'axis-1',
      name: 'Y',
      orientation: 'left',
      autoScale: true,
      logScale: false,
      visible: true,
    });
  }

  // Use the fixed default palette (not the user's persisted choice) so the same
  // .trc file imports to the same fallback colors for everyone.
  const palette = getPalette(DEFAULT_PALETTE_ID);
  const traces: PVTrace[] = legacyCurves.map((c, i) => {
    const axisId = (c.yAxisName && axisIdByName.get(c.yAxisName)) ?? axes[0].id;
    return {
      id: `trace-${i + 1}`,
      pvName: c.channel ?? '',
      displayName: c.name && c.name !== c.channel ? c.name : '', // blank --> traceLabel falls back to PV
      color: c.color ?? colorForIndex(palette, i),
      visible: true,
      axisId,
      useLive: c.liveData ?? false,
      useArchive: c.useArchiveData ?? true,
      lineWidth: c.lineWidth ?? 2,
      lineType: 'step',
      lineStyle: 'solid',
      showSymbol: false,
      symbolShape: 'circle',
      symbolSize: 10,
      data: [],
    };
  });

  // Formula curves: strip the f:// prefix to get the Formula Engine expression, and resolve
  // each {var} via the legacy curveDict (variable -> PV channel name) against the
  // base curves above, so a binding points at a curve on the plot.
  const traceIdByPv = new Map<string, string>();
  for (const t of traces) {
    if (t.pvName) traceIdByPv.set(t.pvName, t.id);
  }
  legacyFormulas.forEach((f, i) => {
    const expression = (f.formula ?? '').replace(/^f:\/\//, '').trim();
    if (!expression) return;
    const axisId = (f.yAxisName && axisIdByName.get(f.yAxisName)) ?? axes[0].id;
    const bindings: Record<string, string> = {};
    const unresolved: string[] = [];
    for (const [variable, pv] of Object.entries(f.curveDict ?? {})) {
      const targetId = traceIdByPv.get(pv);
      if (targetId) bindings[variable] = targetId;
      else unresolved.push(`${variable} → ${pv}`);
    }
    if (unresolved.length > 0) {
      warnings.push(
        `Formula '${f.name ?? expression}': could not bind ${unresolved.join(', ')} (not a curve on the plot) — rebind in the editor.`
      );
    }
    const name = f.name ?? expression;
    traces.push({
      id: `formula-${i + 1}`,
      kind: 'formula',
      pvName: '',
      displayName: name.startsWith('f://') ? name.slice(4) : name,
      color: f.color ?? colorForIndex(palette, legacyCurves.length + i),
      visible: true,
      axisId,
      useLive: false,
      useArchive: false,
      expression,
      bindings,
      lineWidth: f.lineWidth ?? 2,
      lineType: 'direct',
      lineStyle: 'solid',
      showSymbol: false,
      symbolShape: 'circle',
      symbolSize: 10,
      data: [],
    });
  });

  // Time range: legacy stores either a relative span ("-1d") or absolute ISO
  // timestamps in `start`/`end` (with `end` possibly "now"). Map relative spans
  // straight through, and absolute bounds to a custom From/To range.
  const xAxis = mapLegacyTimeRange(legacyTime, warnings);

  // Legacy stored X and Y gridline flags separately; map each to the plot's
  // X / Y gridline toggles.
  const plot: Plot = {
    id: 'plot-1',
    title: typeof legacyPlot.title === 'string' ? legacyPlot.title : 'Imported',
    // A theme-default or missing background is automatic.
    backgroundColor: automaticBackground(legacyPlot.backgroundColor),
    showLegend: legacyPlot.legend !== false,
    showXGridlines: legacyPlot.xGrid === true,
    showYGridlines: legacyPlot.yGrid === true,
    showCrosshair: legacyPlot.crosshair !== false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis,
    axes,
    traces,
  };

  if (typeof obj.archiver_url === 'string') {
    warnings.push(
      `Legacy archiver_url '${obj.archiver_url}' not applied — pick the matching archiver from the header.`
    );
  }

  return { source: 'legacy-trc', plots: [plot], warnings };
}
