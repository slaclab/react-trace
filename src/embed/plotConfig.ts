// The display configuration of the first plot, carried in the embed query's
// `plot` key (see query.ts) so a host keeps what an operator set up: the
// y-axes (ranges or auto, log scale, side, units, visibility), each trace's
// axis and look, and the plot's own display options.
//
//   plot={"v":1,"axes":[{"name":"Current","min":0,"max":5}, ...],
//         "traces":[{"axis":1,"color":"#B80058"}, {}, ...],
//         "showLegend":false, ...}
//
// Sparse: a field equal to what Trace opens with is left out, and so is the
// whole key when nothing differs, so an untouched plot still reports the bare
// `pv=...&range=...` form. Trace entries line up with the query's `pv`
// entries; an axis is named by its index in `axes`. A trace with no `color`
// takes the palette color of its index, as on any open. A plot whose palette
// is not the default states it (`palette`) and writes every trace's color
// explicitly, so an older reader, which drops `palette`, still draws the
// right colors. Live-window state (auto-scroll, panning) and formula curves
// are not part of it.
//
// Drawings ride as `drawings`, one tuple each (annotations/
// config.ts); a derived key, never spread onto the Plot.
//
// Parsing is lenient: a field of the wrong type or out of range is dropped
// (one warning), an unreadable or newer config is ignored (one warning), and
// the PVs and range open regardless.

import {
  decodeMetricTokens,
  encodeMetricTokens,
  MAX_METRICS,
  type Metric,
} from '../statistics/model';
import { plotMetrics, storedMetrics, TRACE_METRICS } from '../tools/trace/metrics';
import { BUILTIN_CATALOG } from '../annotations/catalog';
import type { Catalog } from '../annotations/catalog/types';
import { TIME_X_AXIS } from '../annotations/catalog/xAxis';
import { decodeDrawings, encodeDrawings, type DrawingTuple } from '../annotations/config';
import { isColorLiteral } from '../annotationTheme';
import { type Annotation } from '../annotations/model';
import { DRAG_MODES, type DragMode } from '../plot/plotToggles';
import { withAnnotations } from '../tools/trace/drawing/plotDrawings';
import { TRACE_DEFAULT_DRAG } from '../tools/trace/plotView';
import type { Axis, Plot, PVTrace } from '../types';
import { colorForIndex, isPaletteId, paletteOf, storedPaletteId, type Palette } from '../palettes';

export const PLOT_CONFIG_VERSION = 1;

export interface AxisConfig {
  name?: string;
  orientation?: Axis['orientation'];
  min?: number;
  max?: number;
  autoScale?: boolean;
  logScale?: boolean;
  visible?: boolean;
  units?: string;
  /** The Unit override; readers before it drop the key. */
  unitLabel?: string;
}

export interface TraceConfig {
  /** Index into `PlotConfig.axes` (0 when absent). */
  axis?: number;
  color?: string;
  displayName?: string;
  visible?: boolean;
  useLive?: boolean;
  useArchive?: boolean;
  showArchiveBand?: boolean;
  optimizedDataBins?: number;
  archiver?: string;
  lineWidth?: number;
  lineType?: PVTrace['lineType'];
  lineStyle?: PVTrace['lineStyle'];
  showExtensionLine?: boolean;
  /** ✚ Alarm colouring; written only when on. */
  alarmColoring?: boolean;
  showSymbol?: boolean;
  symbolShape?: PVTrace['symbolShape'];
  symbolSize?: number;
}

export interface PlotConfig {
  v: number;
  title?: string;
  showLegend?: boolean;
  /** ✚ Live value in the legend; written only when on. */
  showLegendValue?: boolean;
  /** ✚ Pinned hover readout; written only when on. */
  pinDataWindow?: boolean;
  /** ✚ Status line; on by default, written only when off. */
  showStatusLine?: boolean;
  /** Hover read-out; on by default, written only when off. */
  showTooltip?: boolean;
  /** Left-drag in the plot; zoom by default, written only as "pan" ("zoom" still reads). */
  dragMode?: DragMode;
  showXGridlines?: boolean;
  showYGridlines?: boolean;
  /** Off by default, written only when on (a written `false` still reads). */
  showCrosshair?: boolean;
  gridStyle?: Plot['gridStyle'];
  gridOpacity?: number;
  tickFontSize?: number;
  refreshIntervalS?: number;
  archiver?: string;
  /** The plot's palette id; absent means the default palette. */
  palette?: string;
  /** Show statistics; written only when on. */
  showStats?: boolean;
  /** Show distribution; written only when on. */
  showDist?: boolean;
  /** The statistics metric tokens (src/statistics/model.ts), only off the default list. */
  metrics?: string[];
  /** Every y-axis, in order; absent means the one default axis. */
  axes?: AxisConfig[];
  /** One entry per PV of the query, in order; trailing defaults are trimmed. */
  traces?: TraceConfig[];
  /** The plot's drawings, at most MAX_DRAWINGS; absent means none. */
  drawings?: DrawingTuple[];
}

// What Trace opens a plot with (initialPlots.ts); the sparse baseline.
export const PLOT_DEFAULTS = {
  title: 'Plot 1',
  showLegend: true,
  showXGridlines: true,
  showYGridlines: true,
  showCrosshair: false,
  gridStyle: 'solid',
  gridOpacity: 1,
  tickFontSize: 11,
  refreshIntervalS: 5,
} as const;

export const TRACE_DEFAULTS = {
  displayName: '',
  visible: true,
  useLive: true,
  useArchive: true,
  lineWidth: 2,
  lineType: 'step',
  lineStyle: 'solid',
  showSymbol: false,
  symbolShape: 'circle',
  symbolSize: 10,
} as const;

export function axisDefaults(
  index: number
): Required<Omit<AxisConfig, 'min' | 'max' | 'units' | 'unitLabel'>> {
  return {
    name: `Y-Axis ${index + 1}`,
    orientation: 'left',
    autoScale: true,
    logScale: false,
    visible: true,
  };
}

export function axisId(index: number): string {
  return `y-axis-${index + 1}`;
}

// ── New objects ──────────────────────────────────────────────────────────────
//
// Every creation path (Trace's add actions, the unit axis) spreads the tables
// above, so a field added to a table reaches each new object.

/** The axis at `index` of a plot; axes alternate sides, starting on the left. */
export function newAxis(id: string, index: number): Axis {
  // axisDefaults' orientation is the wire baseline (always left); a new axis
  // takes its side by parity.
  return { id, ...axisDefaults(index), orientation: index % 2 === 0 ? 'left' : 'right' };
}

/** The unit text an axis shows: the Unit override, else its stamped EGU. */
export function axisUnitText(axis: Pick<Axis, 'units' | 'unitLabel'>): string | undefined {
  return axis.unitLabel ?? axis.units;
}

/**
 * The y-axis title. An axis still titled by its stamped EGU (the automatic
 * Label) shows its unit text instead, so a ✚ Unit override reaches the
 * chart; a Label the user set is shown as written.
 */
export function axisTitle(axis: Axis): string {
  if (axis.units && axis.name === axis.units) return axisUnitText(axis) ?? axis.name;
  return axis.name;
}

/** A new axis at `index` for a PV's engineering units, named for them. */
export function unitAxis(id: string, index: number, unit: string): Axis {
  return { ...newAxis(id, index), name: unit, units: unit };
}

/**
 * The plot at `index` of a workspace: no traces, one default axis. The
 * background is left automatic (the theme's default).
 */
export function newPlot(id: string, index: number): Plot {
  return {
    ...PLOT_DEFAULTS,
    id,
    title: `Plot ${index + 1}`,
    xAxis: { timeRange: '-1h' },
    autoScroll: true,
    axes: [newAxis(`${id}-axis-1`, 0)],
    traces: [],
  };
}

/**
 * A PV trace; both sources on (live is the headline, archive backfills). Live
 * retention is left automatic.
 */
export function newTrace(
  id: string,
  pvName: string,
  axisId: string,
  color: string,
  data: PVTrace['data']
): PVTrace {
  return { ...TRACE_DEFAULTS, id, pvName, axisId, color, data };
}

/** An empty formula curve: no PV source, its values come from the Formula Engine. */
export function newFormula(id: string, axisId: string, color: string): PVTrace {
  return {
    ...TRACE_DEFAULTS,
    id,
    kind: 'formula',
    pvName: '',
    displayName: 'New Formula',
    axisId,
    color,
    useLive: false,
    useArchive: false,
    lineType: 'direct',
    expression: '',
    bindings: {},
    data: [],
  };
}

// ── Building a config from a plot ────────────────────────────────────────────

/** The parts of a plot the config reads; anything absent counts as default. */
export interface PlotConfigSource {
  traces: readonly (Partial<PVTrace> & { pvName: string })[];
  axes?: readonly Axis[];
  title?: string;
  showLegend?: boolean;
  showLegendValue?: boolean;
  pinDataWindow?: boolean;
  showStatusLine?: boolean;
  showTooltip?: boolean;
  dragMode?: DragMode;
  showXGridlines?: boolean;
  showYGridlines?: boolean;
  showCrosshair?: boolean;
  gridStyle?: Plot['gridStyle'];
  gridOpacity?: number;
  tickFontSize?: number;
  refreshIntervalS?: number;
  archiver?: string;
  palette?: string;
  showStats?: boolean;
  showDist?: boolean;
  metrics?: Metric[];
  annotations?: readonly Annotation[];
}

const PLOT_FIELDS = Object.keys(PLOT_DEFAULTS) as (keyof typeof PLOT_DEFAULTS)[];
const TRACE_FIELDS = Object.keys(TRACE_DEFAULTS) as (keyof typeof TRACE_DEFAULTS)[];
const AXIS_FIELDS = ['name', 'orientation', 'autoScale', 'logScale', 'visible'] as const;

/** The query's traces: PV curves with a name, in order (query.ts skips the rest). */
export function queryTraces<T extends { kind?: string; pvName: string }>(
  traces: readonly T[]
): T[] {
  return traces.filter((t) => t.kind !== 'formula' && t.pvName.trim() !== '');
}

function isDefaultAxisList(axes: readonly Axis[] | undefined): boolean {
  if (axes === undefined || axes.length === 0) return true;
  if (axes.length !== 1) return false;
  return Object.keys(axisConfig(axes[0], 0)).length === 0;
}

function axisConfig(axis: Axis, index: number): AxisConfig {
  const out: AxisConfig = {};
  const defaults = axisDefaults(index);
  for (const field of AXIS_FIELDS) {
    if (axis[field] !== undefined && axis[field] !== defaults[field]) {
      (out as Record<string, unknown>)[field] = axis[field];
    }
  }
  // A manual range is only meaningful with auto-scale off, but the bounds are
  // kept either way: Trace keeps them when auto-scale is toggled back on.
  if (typeof axis.min === 'number' && Number.isFinite(axis.min)) out.min = axis.min;
  if (typeof axis.max === 'number' && Number.isFinite(axis.max)) out.max = axis.max;
  if (axis.units) out.units = axis.units;
  if (axis.unitLabel) out.unitLabel = axis.unitLabel;
  return out;
}

function traceConfig(
  trace: PlotConfigSource['traces'][number],
  index: number,
  axes: readonly Axis[] | undefined,
  palette: Palette,
  explicitColor: boolean
): TraceConfig {
  const out: TraceConfig = {};
  if (axes && axes.length > 0 && trace.axisId !== undefined) {
    const at = axes.findIndex((a) => a.id === trace.axisId);
    if (at > 0) out.axis = at;
  }
  if (
    trace.color !== undefined &&
    (explicitColor || trace.color !== colorForIndex(palette, index))
  ) {
    out.color = trace.color;
  }
  for (const field of TRACE_FIELDS) {
    const value = trace[field];
    if (value !== undefined && value !== TRACE_DEFAULTS[field]) {
      (out as Record<string, unknown>)[field] = value;
    }
  }
  if (trace.showArchiveBand === false) out.showArchiveBand = false;
  if (trace.showExtensionLine === false) out.showExtensionLine = false;
  if (trace.alarmColoring === true) out.alarmColoring = true;
  if (trace.optimizedDataBins !== undefined) out.optimizedDataBins = trace.optimizedDataBins;
  if (trace.archiver !== undefined) out.archiver = trace.archiver;
  return out;
}

/**
 * The config of `plot`, or undefined when everything is as Trace opens it.
 * Colors are judged against the plot's own palette (`plot.palette`, else the
 * default); `_legacyPalette` is ignored and only kept for older call sites.
 */
export function plotConfigOf(
  plot: PlotConfigSource,
  _legacyPalette?: Palette
): PlotConfig | undefined {
  void _legacyPalette;
  const paletteId = storedPaletteId(plot.palette);
  const palette = paletteOf({ palette: paletteId });
  const config: PlotConfig = { v: PLOT_CONFIG_VERSION };
  for (const field of PLOT_FIELDS) {
    const value = plot[field];
    if (value !== undefined && value !== PLOT_DEFAULTS[field]) {
      (config as unknown as Record<string, unknown>)[field] = value;
    }
  }
  if (plot.showLegendValue === true) config.showLegendValue = true;
  if (plot.pinDataWindow === true) config.pinDataWindow = true;
  if (plot.showStatusLine === false) config.showStatusLine = false;
  if (plot.showTooltip === false) config.showTooltip = false;
  if (plot.dragMode !== undefined && plot.dragMode !== TRACE_DEFAULT_DRAG) {
    config.dragMode = plot.dragMode;
  }
  if (plot.showStats === true) config.showStats = true;
  if (plot.showDist === true) config.showDist = true;
  const metrics = storedMetrics(plotMetrics(plot));
  if (metrics !== undefined) config.metrics = encodeMetricTokens(TRACE_METRICS, metrics);
  if (plot.archiver !== undefined) config.archiver = plot.archiver;
  if (paletteId !== undefined) config.palette = paletteId;
  if (!isDefaultAxisList(plot.axes)) {
    config.axes = (plot.axes ?? []).map((a, i) => axisConfig(a, i));
  }
  const traces = queryTraces(plot.traces).map((t, i) =>
    traceConfig(
      t,
      i,
      isDefaultAxisList(plot.axes) ? undefined : plot.axes,
      palette,
      paletteId !== undefined
    )
  );
  while (traces.length > 0 && Object.keys(traces[traces.length - 1]).length === 0) traces.pop();
  if (traces.length > 0) config.traces = traces;
  const drawings = encodeDrawings(plot, queryTraces(plot.traces), { catalog: BUILTIN_CATALOG });
  if (drawings !== undefined) config.drawings = drawings;
  return Object.keys(config).length === 1 ? undefined : config;
}

/**
 * The same config with only the axes and each trace's axis: what a query
 * keeps when the whole config does not fit beside the PVs.
 */
export function axesOnly(config: PlotConfig): PlotConfig | undefined {
  if (config.axes === undefined) return undefined;
  const out: PlotConfig = { v: config.v, axes: config.axes };
  // The palette is a few bytes and keeps untouched curves in their colors.
  if (config.palette !== undefined) out.palette = config.palette;
  const traces = (config.traces ?? []).map((t) => (t.axis === undefined ? {} : { axis: t.axis }));
  while (traces.length > 0 && Object.keys(traces[traces.length - 1]).length === 0) traces.pop();
  if (traces.length > 0) out.traces = traces;
  return out;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const MAX_TEXT = 200;
// useAutoScrollTimers' MIN_REFRESH_S/MAX_REFRESH_S. Not imported: that module
// installs the host bridge, and this one stays free of side effects.
const MIN_REFRESH_S = 1;
const MAX_REFRESH_S = 60;
const ORIENTATIONS = ['left', 'right'];
const LINE_TYPES = ['direct', 'step'];
const LINE_STYLES = ['none', 'solid', 'dashed', 'dotted', 'dashDot', 'dashDotDot'];
const SYMBOL_SHAPES = [
  'none',
  'circle',
  'square',
  'triangle',
  'star',
  'pentagon',
  'hexagon',
  'x',
  'diamond',
  'plus',
];
const GRID_STYLES = ['solid', 'dashed', 'dotted'];
const MAX_AXES = 16;

type Check = (v: unknown) => boolean;

const text: Check = (v) => typeof v === 'string' && v.length <= MAX_TEXT;
const bool: Check = (v) => typeof v === 'boolean';
const finite: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const oneOf =
  (values: readonly string[]): Check =>
  (v) =>
    typeof v === 'string' && values.includes(v);
const between =
  (lo: number, hi: number): Check =>
  (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const intBetween =
  (lo: number, hi: number): Check =>
  (v) =>
    Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

const PLOT_CHECKS: Record<string, Check> = {
  title: text,
  showLegend: bool,
  showLegendValue: bool,
  pinDataWindow: bool,
  showStatusLine: bool,
  showTooltip: bool,
  dragMode: oneOf(DRAG_MODES),
  showXGridlines: bool,
  showYGridlines: bool,
  showCrosshair: bool,
  gridStyle: oneOf(GRID_STYLES),
  gridOpacity: between(0, 1),
  tickFontSize: between(6, 48),
  refreshIntervalS: between(MIN_REFRESH_S, MAX_REFRESH_S),
  archiver: text,
  palette: isPaletteId,
  showStats: bool,
  showDist: bool,
  metrics: (v) =>
    Array.isArray(v) &&
    v.length <= MAX_METRICS &&
    v.every((t) => typeof t === 'string' && t.length <= MAX_TEXT),
  // Shape only: the tuples and the MAX_DRAWINGS cap are the decoder's.
  drawings: (v) => Array.isArray(v),
};

const AXIS_CHECKS: Record<string, Check> = {
  name: text,
  orientation: oneOf(ORIENTATIONS),
  min: finite,
  max: finite,
  autoScale: bool,
  logScale: bool,
  visible: bool,
  units: text,
  unitLabel: text,
};

const TRACE_CHECKS: Record<string, Check> = {
  axis: intBetween(0, MAX_AXES - 1),
  color: isColorLiteral,
  displayName: text,
  visible: bool,
  useLive: bool,
  useArchive: bool,
  showArchiveBand: bool,
  optimizedDataBins: intBetween(1, 100_000),
  archiver: text,
  lineWidth: between(0.5, 20),
  lineType: oneOf(LINE_TYPES),
  lineStyle: oneOf(LINE_STYLES),
  showExtensionLine: bool,
  alarmColoring: bool,
  showSymbol: bool,
  symbolShape: oneOf(SYMBOL_SHAPES),
  symbolSize: between(1, 50),
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Copy the fields of `raw` that pass their check; name the rest in `dropped`.
function pick<T>(
  raw: Record<string, unknown>,
  checks: Record<string, Check>,
  where: string,
  dropped: string[]
): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const check = checks[key];
    if (check === undefined) continue; // unknown keys: a newer writer's extras
    if (check(value)) out[key] = value;
    else dropped.push(`${where}${key}`);
  }
  return out as T;
}

/**
 * Read a `plot` value (JSON). Null, with one warning, when it is unreadable,
 * not an object or from a newer version; invalid fields are dropped with one
 * warning naming them.
 */
export function parsePlotConfig(raw: string): PlotConfig | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    console.warn('Trace query has an unreadable plot config; ignoring it.');
    return null;
  }
  if (!isRecord(data) || data.v !== PLOT_CONFIG_VERSION) {
    console.warn(
      `Trace query has a plot config Trace does not understand (version ${JSON.stringify(
        isRecord(data) ? data.v : undefined
      )}); ignoring it.`
    );
    return null;
  }

  const dropped: string[] = [];
  const config: PlotConfig = {
    v: PLOT_CONFIG_VERSION,
    ...pick<Omit<PlotConfig, 'v'>>(data, PLOT_CHECKS, '', dropped),
  };
  if (data.axes !== undefined) {
    if (Array.isArray(data.axes) && data.axes.length > 0 && data.axes.length <= MAX_AXES) {
      config.axes = data.axes.map((a, i) =>
        isRecord(a) ? pick<AxisConfig>(a, AXIS_CHECKS, `axes[${i}].`, dropped) : {}
      );
    } else {
      dropped.push('axes');
    }
  }
  if (data.traces !== undefined) {
    if (Array.isArray(data.traces)) {
      const axisCount = config.axes?.length ?? 1;
      config.traces = data.traces.map((t, i) => {
        if (!isRecord(t)) return {};
        const entry = pick<TraceConfig>(t, TRACE_CHECKS, `traces[${i}].`, dropped);
        if (entry.axis !== undefined && entry.axis >= axisCount) {
          dropped.push(`traces[${i}].axis`);
          delete entry.axis;
        }
        return entry;
      });
    } else {
      dropped.push('traces');
    }
  }
  if (dropped.length > 0) {
    console.warn(`Trace query plot config: ignoring invalid ${dropped.join(', ')}.`);
  }
  return config;
}

// ── Applying a config ────────────────────────────────────────────────────────

/**
 * `plot` (as Trace opens it: one default axis, palette colors) with `config`
 * applied. The config's drawing tuples are decoded here, against the rebuilt
 * axes and traces and the catalog in `options` (Trace's built-ins by default).
 */
export function applyPlotConfig(
  plot: Plot,
  config: PlotConfig,
  options: { catalog?: Catalog } = {}
): Plot {
  const {
    v: _v,
    axes: axisConfigs,
    traces: traceConfigs,
    palette,
    metrics: metricTokens,
    drawings,
    ...fields
  } = config;
  void _v;
  const axes: Axis[] =
    axisConfigs === undefined
      ? plot.axes
      : axisConfigs.map((a, i) => {
          const axis: Axis = { id: axisId(i), ...axisDefaults(i), ...a };
          return axis;
        });
  const traces = plot.traces.map((trace, i) => {
    const entry = traceConfigs?.[i];
    if (entry === undefined) return { ...trace, axisId: axes[0].id };
    const { axis, ...look } = entry;
    return { ...trace, ...look, axisId: axes[axis ?? 0]?.id ?? axes[0].id };
  });
  let out: Plot = { ...plot, ...fields, axes, traces };
  // The drag mode is stored only off Trace's default.
  if (out.dragMode === TRACE_DEFAULT_DRAG) delete out.dragMode;
  // Raw tuples never reach the Plot: decoded against the rebuilt axes and traces.
  if (drawings !== undefined) {
    out = withAnnotations(
      out,
      decodeDrawings(drawings, out, queryTraces(out.traces), {
        catalog: options.catalog ?? BUILTIN_CATALOG,
        xAxis: TIME_X_AXIS,
      })
    );
  }
  // A metric list is stored only off the default; a token that
  // cannot be read is dropped.
  if (metricTokens !== undefined) {
    const stored = storedMetrics(decodeMetricTokens(TRACE_METRICS, metricTokens));
    if (stored === undefined) delete out.metrics;
    else out.metrics = stored;
  }
  // The default palette is stored as absent.
  const stored = storedPaletteId(palette ?? plot.palette);
  if (stored === undefined) delete out.palette;
  else out.palette = stored;
  return out;
}
