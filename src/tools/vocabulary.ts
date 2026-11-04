// The properties panel's words, one name per concept in every tool (Trace,
// Correlation, Waveform). A tool names its groups, plot-wide sections, card
// blocks and the fields every tool shares from here, so the same thing reads
// the same everywhere. Field ids and saved keys are the tools' own and never
// change with a label.

/** The top block's group headings, in the order they appear. */
export const GROUPS = Object.freeze({
  signals: 'Signals',
  reference: 'Reference',
  xPv: 'X axis PV',
  trigger: 'Trigger',
  drawings: 'Drawings',
} as const);

/** The plot-wide sections (tool-level field groups), in order; `code` is the chart source. */
export const PLOT_SECTIONS = Object.freeze({
  acquisition: { id: 'acquisition', label: 'Acquisition' },
  axes: { id: 'axes', label: 'Axes' },
  display: { id: 'display', label: 'Display' },
  statistics: { id: 'statistics', label: 'Statistics' },
  code: { id: 'code', label: 'Chart source' },
} as const);

/** The titled blocks of an open card. */
export const CARD_BLOCKS = Object.freeze({
  signal: { id: 'signal', label: 'Signal' },
  style: { id: 'style', label: 'Style' },
  data: { id: 'data', label: 'Data' },
} as const);

/** The sub-headings inside Axes. */
export const AXES = Object.freeze({ y: 'Y axis', x: 'X axis' } as const);

/** The labels of the fields every tool shares. */
export const LABELS = Object.freeze({
  label: 'Label',
  plotOn: 'Plot on',
  visible: 'Visible',
  colour: 'Colour',
  line: 'Line',
  width: 'Width',
  dash: 'Dash',
  markers: 'Markers',
  marker: 'Marker',
  markerSize: 'Marker size',
  unit: 'Unit',
  autoScale: 'Auto-scale',
  min: 'Min',
  max: 'Max',
  logScale: 'Log scale',
  legend: 'Legend',
  grid: 'Grid',
  crosshair: 'Crosshair',
  tooltip: 'Data tooltip',
  drag: 'Mouse drag',
} as const);

/** Dash patterns by wire value, worded the same in every tool. */
export const DASH_LABELS: Readonly<Record<string, string>> = Object.freeze({
  none: 'None',
  solid: 'Solid',
  dashed: 'Dashed',
  dotted: 'Dotted',
  dashDot: 'Dash-dot',
  dashDotDot: 'Dash-dot-dot',
});

/** How a curve joins its points, by wire value (Trace `direct` is a plain line). */
export const LINE_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  direct: 'Line',
  line: 'Line',
  step: 'Step',
  bars: 'Bars',
  points: 'Points',
});

/** The non-empty parts joined as one summary line: `persistence 4 · average 2`. */
export function summary(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');
}

/** The names of the flags that are on, as a summary; `none` when none is. */
export function onFlags(flags: readonly (readonly [string, boolean])[]): string {
  const on = flags.filter(([, value]) => value).map(([name]) => name);
  return on.length > 0 ? on.join(' · ') : 'none';
}
