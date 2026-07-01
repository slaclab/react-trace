import type { Plot, PVTrace, Axis } from '../types';
import type { ColorMode } from '../state/themeStore';

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
  return {
    ...p,
    // Older saved workspaces predate showLegend; default to shown.
    showLegend: p.showLegend ?? true,
    showCrosshair: p.showCrosshair ?? true,
    traces: (p.traces ?? []).map((t) => ({ ...t, data: t.data ?? [] })),
    axes: p.axes ?? [],
  };
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

function convertLegacyTrc(obj: Record<string, unknown>): DeserializeResult {
  const warnings: string[] = [];

  const legacyPlot = (obj.plot ?? {}) as Record<string, unknown>;
  const legacyAxes = (obj['y-axes'] ?? []) as LegacyAxis[];
  const legacyCurves = (obj.curves ?? []) as LegacyCurve[];
  const legacyTime = (obj.time_axis ?? {}) as { start?: string; end?: string };

  if (Array.isArray(obj.formula) && (obj.formula as unknown[]).length > 0) {
    warnings.push("Legacy 'formula' definitions ignored (Fox not implemented yet)");
  }

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

  const colors = ['#0f62fe', '#ee5396', '#42be65', '#ff832b', '#a56eff', '#08bdba'];
  const traces: PVTrace[] = legacyCurves.map((c, i) => {
    const axisId = (c.yAxisName && axisIdByName.get(c.yAxisName)) ?? axes[0].id;
    return {
      id: `trace-${i + 1}`,
      pvName: c.channel ?? '',
      displayName: c.name && c.name !== c.channel ? c.name : '', // blank --> traceLabel falls back to PV
      color: c.color ?? colors[i % colors.length],
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

  // Time range: legacy stores absolute strings. We map the common case
  // `end == "now"` to a relative range; otherwise fall back to "-1h" with
  // a warning, since the absolute custom-range path needs more work.
  const timeRange = '-1h';
  if (legacyTime.end === 'now' && legacyTime.start) {
    // No clean way to recover the original "-1h" intent from the start
    // timestamp without parsing; default to -1h and warn.
    warnings.push(
      `Legacy time range '${legacyTime.start}' to 'now' approximated as '-1h' — adjust in plot settings.`
    );
  } else if (legacyTime.start || legacyTime.end) {
    warnings.push(`Custom time range from legacy file not yet supported — defaulted to '-1h'.`);
  }

  const plot: Plot = {
    id: 'plot-1',
    title: typeof legacyPlot.title === 'string' ? legacyPlot.title : 'Imported',
    backgroundColor:
      typeof legacyPlot.backgroundColor === 'string' ? legacyPlot.backgroundColor : '#161616',
    showLegend: legacyPlot.legend !== false,
    showGridlines: legacyPlot.xGrid === true && legacyPlot.yGrid === true,
    showCrosshair: legacyPlot.crosshair !== false,
    gridStyle: 'solid',
    xAxis: { timeRange },
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
