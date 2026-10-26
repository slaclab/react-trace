import type { Plot, PVTrace, Axis } from '../types';
import type { ColorMode } from '../state/themeStore';
import { getPalette, colorForIndex, DEFAULT_PALETTE_ID } from '../palettes';
import { parseSpanMs, toDatetimeLocal } from '../api/time';

// Native save format — a superset of what's currently in app state plus a
// schema version for forward compatibility. Bumping schemaVersion means the
// loader rejects (or migrates) older files. Keep field names mirror app types
// so a round-trip is just JSON.parse/stringify.
export const SCHEMA_VERSION = 1;

export interface TraceWorkspace {
  schemaVersion: number;
  savedAt: string; // ISO 8601
  theme: ColorMode;
  plots: Plot[];
}

export function serializeWorkspace(args: { theme: ColorMode; plots: Plot[] }): string {
  const ws: TraceWorkspace = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    theme: args.theme,
    plots: args.plots.map(stripTraceData),
  };
  return JSON.stringify(ws, null, 2);
}

// `data` is the per-trace mock array for live previews; it's regenerated at
// runtime, no point persisting it. Strip on save, fill back with [] on load.
function stripTraceData(plot: Plot): Plot {
  return {
    ...plot,
    traces: plot.traces.map((t) => ({ ...t, data: [] })),
  };
}

export interface DeserializeResult {
  source: 'native' | 'legacy-trc';
  theme?: ColorMode;
  plots: Plot[];
  warnings: string[];
}

export function deserializeWorkspace(text: string): DeserializeResult {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object') throw new Error('Invalid file: not an object');
  const obj = data as Record<string, unknown>;

  // Native format identification by schemaVersion.
  if (typeof obj.schemaVersion === 'number') {
    if (obj.schemaVersion > SCHEMA_VERSION) {
      throw new Error(
        `File schema version ${obj.schemaVersion} is newer than the app understands (${SCHEMA_VERSION}). Update the app.`
      );
    }
    let plots = Array.isArray(obj.plots) ? (obj.plots as Plot[]).map(rehydratePlot) : [];
    // Migrate the old workspace-level default archiver onto each plot that
    // doesn't already carry one (the default is now per-plot).
    if (typeof obj.globalArchiver === 'string') {
      const legacyDefault = obj.globalArchiver;
      plots = plots.map((p) => (p.archiver === undefined ? { ...p, archiver: legacyDefault } : p));
    }
    // Saves from before the month preset rename used "-1m" for one month.
    if (isMonthEraSave(obj.savedAt)) plots = plots.map(migrateMonthPreset);
    return {
      source: 'native',
      theme: typeof obj.theme === 'string' ? (obj.theme as ColorMode) : undefined,
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

function rehydratePlot(p: Plot): Plot {
  // Older saved workspaces used a single `showGridlines` flag and lacked grid
  // opacity / tick font size. Migrate the old flag to both X and Y toggles and
  // default the rest so loaded plots render the same as before.
  const legacy = p as Plot & { showGridlines?: boolean };
  return {
    ...p,
    // Older saved workspaces predate showLegend; default to shown.
    showLegend: p.showLegend ?? true,
    showCrosshair: p.showCrosshair ?? true,
    showXGridlines: p.showXGridlines ?? legacy.showGridlines ?? true,
    showYGridlines: p.showYGridlines ?? legacy.showGridlines ?? true,
    gridOpacity: p.gridOpacity ?? 1,
    tickFontSize: p.tickFontSize ?? 11,
    traces: (p.traces ?? []).map((t) => ({ ...t, data: t.data ?? [] })),
  };
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
      updateRate: 'monitor',
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

  // Formula curves: strip the f:// prefix to get the Fox expression, and resolve
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
      updateRate: 'monitor',
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
    backgroundColor:
      typeof legacyPlot.backgroundColor === 'string' ? legacyPlot.backgroundColor : '#161616',
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
