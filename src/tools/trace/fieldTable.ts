// Trace's field table: the one place to add a setting. Every field id of every
// Trace schema (plot, axis, PV curve, formula curve) names the class of what it
// rides in:
//
//   plot     the query's `plot=` config, under one *_CHECKS key of
//            embed/plotConfig.ts (scope `plot`, `axis` or `trace`)
//   query    a query key of its own (`pv=`, `range=`)
//   drawing  one slot of a drawing's `plot=` tuple (annotations/config.ts
//            DrawingTuple): the drawing item's style fields
//   session  neither: session state (Autoscroll), file-only in
//            `.trc.json` (background, pinned retention, formulas), the
//            per-user store, or no setting at all (code, status, actions)
//
// `session` has no fixed enumeration: anything not in the query is session or
// file-only, and `why` says which. schema.completeness.test.ts pins the table
// against the schemas, plotConfig's CHECKS tables and parseTraceQuery's keys,
// so a field added without an entry, or a CHECKS key with no field, fails by
// name. A task that adds a field extends this table in the same commit.

/** A `*_CHECKS` table of embed/plotConfig.ts. */
export type PlotConfigScope = 'plot' | 'axis' | 'trace';

/** A query key that carries one field by itself (`plot` carries the plot class). */
export type TraceQueryKey = 'pv' | 'range';

/** A slot of annotations/config.ts's `DrawingTuple`, by its label. */
export type DrawingSlot =
  | 'kindCode'
  | 'points'
  | 'axisIndex'
  | 'traceIndex'
  | 'color'
  | 'text'
  | 'flags';

export type FieldClass =
  | { class: 'plot'; scope: PlotConfigScope; key: string }
  | { class: 'query'; key: TraceQueryKey }
  | { class: 'drawing'; slot: DrawingSlot }
  | { class: 'session'; why: string };

const plot = (scope: PlotConfigScope, key: string): FieldClass => ({ class: 'plot', scope, key });
const session = (why: string): FieldClass => ({ class: 'session', why });
const drawing = (slot: DrawingSlot): FieldClass => ({ class: 'drawing', slot });

const SESSION_STATE = 'session state: not serialized, every opening tracks now';
const FILE_ONLY = 'file-only in .trc.json';
const NO_SETTING = 'holds no setting';

/** Every Trace schema field id → what it rides in. Keyed by id: shared fields appear once. */
export const TRACE_FIELD_TABLE: Readonly<Record<string, FieldClass>> = {
  // Tool level: the plot (schema/plot.ts).
  'plot-title': plot('plot', 'title'),
  'time-range': { class: 'query', key: 'range' },
  autoscroll: session(SESSION_STATE),
  'default-archiver': plot('plot', 'archiver'),
  'refresh-interval': plot('plot', 'refreshIntervalS'),
  'refresh-cap': session(NO_SETTING),
  'tick-font-size': plot('plot', 'tickFontSize'),
  'show-legend': plot('plot', 'showLegend'),
  'show-legend-value': plot('plot', 'showLegendValue'),
  'pin-data-window': plot('plot', 'pinDataWindow'),
  'show-status-line': plot('plot', 'showStatusLine'),
  'show-tooltip': plot('plot', 'showTooltip'),
  'drag-mode': plot('plot', 'dragMode'),
  'show-x-gridlines': plot('plot', 'showXGridlines'),
  'show-y-gridlines': plot('plot', 'showYGridlines'),
  'grid-style': plot('plot', 'gridStyle'),
  'grid-opacity': plot('plot', 'gridOpacity'),
  'show-crosshair': plot('plot', 'showCrosshair'),
  'plot-background': session(FILE_ONLY),
  'plot-palette': plot('plot', 'palette'),
  // The shared Statistics tab (src/statistics/fields.ts): both values ride
  // in `plot=`, the reset is an action.
  'stats-show': plot('plot', 'showStats'),
  'stats-dist': plot('plot', 'showDist'),
  metrics: plot('plot', 'metrics'),
  'metrics-reset': session(NO_SETTING),
  'plot-code': session(NO_SETTING),

  // Section level: an axis (schema/axis.ts).
  'axis-label': plot('axis', 'name'),
  'axis-unit': plot('axis', 'unitLabel'),
  'axis-orientation': plot('axis', 'orientation'),
  'axis-visible': plot('axis', 'visible'),
  'axis-autoscale': plot('axis', 'autoScale'),
  'axis-min': plot('axis', 'min'),
  'axis-max': plot('axis', 'max'),
  'axis-logscale': plot('axis', 'logScale'),
  'axis-remove': session(NO_SETTING),

  // Item level: a PV curve (schema/curve.ts); the shared fields are the formula's too.
  'pv-name': { class: 'query', key: 'pv' },
  'display-name': plot('trace', 'displayName'),
  'y-axis': plot('trace', 'axis'),
  'trace-visible': plot('trace', 'visible'),
  'trace-color': plot('trace', 'color'),
  'use-live': plot('trace', 'useLive'),
  'use-archive': plot('trace', 'useArchive'),
  'live-status': session(NO_SETTING),
  'archive-status': session(NO_SETTING),
  'inspect-data': session(NO_SETTING),
  'create-formula': session(NO_SETTING),
  'live-retention': session(FILE_ONLY),
  'curve-archiver': plot('trace', 'archiver'),
  'show-archive-band': plot('trace', 'showArchiveBand'),
  'optimized-bins': plot('trace', 'optimizedDataBins'),
  'line-type': plot('trace', 'lineType'),
  'line-width': plot('trace', 'lineWidth'),
  'line-style': plot('trace', 'lineStyle'),
  'extend-to-now': plot('trace', 'showExtensionLine'),
  'alarm-coloring': plot('trace', 'alarmColoring'),
  'show-symbols': plot('trace', 'showSymbol'),
  'symbol-shape': plot('trace', 'symbolShape'),
  'symbol-size': plot('trace', 'symbolSize'),

  // Item level: a formula curve (schema/formula.ts); formulas never ride the query.
  'formula-expression': session(FILE_ONLY),

  // Item level: a drawing (schema/annotation.ts); its fields ride in the
  // drawing's `plot=` tuple. Kind is fixed at creation and Delete holds no
  // setting, so both are session.
  'annotation-kind': session(NO_SETTING),
  'annotation-label': drawing('text'),
  'annotation-color': drawing('color'),
  'annotation-width': drawing('flags'),
  'annotation-style': drawing('flags'),
  'annotation-axis': drawing('axisIndex'),
  'annotation-value': drawing('points'),
  'annotation-extend': drawing('flags'),
  'annotation-locked': drawing('flags'),
  'annotation-visible': drawing('flags'),
  'annotation-delete': session(NO_SETTING),
};

/**
 * `*_CHECKS` keys that no field sets: written by Trace itself, not by a
 * properties field. `axis.units` is the EGU stamped by unit re-assignment; it
 * stays derived: the user-facing override is the axis's own `unitLabel` field.
 * `plot.drawings` is the plot's annotations as tuples (annotations/config.ts),
 * edited on the canvas and in the Drawing tab, not as one field.
 */
export const DERIVED_PLOT_CONFIG_KEYS: Readonly<Record<PlotConfigScope, readonly string[]>> = {
  plot: ['drawings'],
  axis: ['units'],
  trace: [],
};

/**
 * `DrawingTuple` slots that no drawing-class field sets: `kindCode` is the
 * read-only Kind (fixed when the drawing is placed), `traceIndex` the curve
 * the magnet snapped to, written by the canvas tools, never by a field.
 */
export const DERIVED_DRAWING_SLOTS: readonly DrawingSlot[] = ['kindCode', 'traceIndex'];
