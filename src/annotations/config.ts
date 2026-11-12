// The `plot=` form of a plot's drawings: one short positional tuple per
// drawing in `PlotConfig.drawings`,
//
//   [kindCode, points, axisIndex, traceIndex | null, color?, text?, flags?]
//
// `points` is laid out per kind by its tool's codec layout (a note is `tv`);
// `axisIndex` names the y-axis by its index in the plot's axes;
// `traceIndex` names the snapped curve by its index in the query's pv list
// (null when unsnapped or snapped to a formula). `color` is left out when it
// is the palette default for the drawing's index (`ink` names the theme's
// ink), `text` when empty, and `flags` is a short string of `l` locked, `h`
// hidden, `d` dash, `r`/`b` extend right/both and `w.5`/`w1`/`w1.5`/`w2`/`w3`
// width 0.5/1/1.5/2/3 (absent = 0.75, the width a new drawing takes; `w.75` is
// still read). A slot left out before
// a present one is written as ''.
//
// The count cap `MAX_DRAWINGS` is applied here, by the encoder and the
// decoder, never by `PLOT_CHECKS`. The decoder is lenient per
// tuple: a bad tuple is dropped and the rest kept, with one warning per call.
//
// Pure, and free of plotConfig.ts (which imports this module): the query's
// traces are passed in. Colours only through src/annotationTheme.ts -- this tree
// is literal-guarded.
//
// The codec is catalog-driven: a tuple's kind, its points layout and the
// tool's own flag letters come from the `DrawingTool` the caller's catalog
// finds for the code, and `t` is rounded only on a time x axis. The axis,
// magnet-trace and binding slots go through injected resolvers
// (`TupleEncodeSlots`/`TupleDecodeSlots`): Trace's are index rules over the
// plot, the context links' (contextLink.ts) index a reference table.
// `encodeJsonParam` is the readable-JSON query encoding both share.
import { ANNOTATION_INK, defaultAnnotationColor, isColorLiteral } from '../annotationTheme';
import { makeAnnotationId } from './ids';
import type { AxisRef, Catalog, CodecLayout, DrawingTool, XAxisDescriptor } from './catalog/types';
import {
  type Annotation,
  type AnnotationPoint,
  type AnnotationWidth,
  MAX_ANNOTATION_TEXT,
  NEW_DRAWING_WIDTH,
} from './model';

export type DrawingTuple = [
  kindCode: number,
  points: number[],
  axisIndex: number,
  traceIndex: number | null,
  color?: string,
  text?: string,
  flags?: string,
];

/** The most drawings a `plot=` value carries; encoder and decoder keep the first ones. */
export const MAX_DRAWINGS = 64;

const WIDTH_FLAG: Partial<Record<AnnotationWidth, string>> = {
  0.5: 'w.5',
  1: 'w1',
  1.5: 'w1.5',
  2: 'w2',
  3: 'w3',
};
const FLAG_WIDTH: Record<string, AnnotationWidth> = {
  'w.5': 0.5,
  'w.75': 0.75,
  w1: 1,
  'w1.5': 1.5,
  w2: 2,
  w3: 3,
};

/**
 * The JSON of `value` as a query parameter: percent-encoded, but with its
 * structure characters (`:` `,` `[` `]` `{` `}`) left readable -- all of them
 * are legal in a query.
 */
export function encodeJsonParam(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value)).replace(/%(3A|2C|5B|5D|7B|7D)/gi, (m) =>
    decodeURIComponent(m)
  );
}

/** Which tools and which x axis a tuple is read against. */
export interface DrawingCodecOptions {
  /** The plot's tools; a code it lacks is dropped. */
  catalog: Catalog;
  /** The plot's x axis; `t` is rounded only on a time axis. */
  xAxis: XAxisDescriptor;
}

/** How the encoder fills a tuple's reference slots. */
export interface TupleEncodeSlots {
  /** Slot 2: the drawing's axis. */
  axis(a: Annotation): number;
  /** Slot 3: the drawing's magnet trace, or null for none. */
  trace(a: Annotation): number | null;
  /** The optional 8th slot (context links only); undefined writes none. */
  binding?(a: Annotation): number | undefined;
}

/** How the decoder resolves a tuple's reference slots. */
export interface TupleDecodeSlots {
  /** The axis id slot 2 names, or null to drop the tuple. */
  axis(index: number): string | null;
  /**
   * The magnet trace slot 3 names: `{traceId}` to set it, `{}` to leave the
   * drawing unsnapped, or null to drop the tuple.
   */
  trace(index: number): { traceId?: string } | null;
  /**
   * The drawing with the 8th slot applied (`index` undefined when the slot is
   * absent), or null to drop it. Without this resolver the slot is ignored.
   */
  binding?(index: number | undefined, a: Annotation): Annotation | null;
}

function encodePoints(layout: CodecLayout, points: readonly AnnotationPoint[]): number[] {
  const [p0, p1] = points;
  switch (layout) {
    case 'v':
      return [p0.v];
    case 't':
      return [p0.t];
    case 'tt':
      return [p0.t, p1.t];
    case 'tv':
      return [p0.t, p0.v];
    case 'tvtv':
      return [p0.t, p0.v, p1.t, p1.v];
  }
}

// Common letters first (l h d), then the tool's own, then the width.
function flagsOf(tool: DrawingTool, a: Annotation): string {
  let out = '';
  if (a.locked) out += 'l';
  if (a.hidden) out += 'h';
  if (a.dash) out += 'd';
  out += tool.codec.flags?.encode(a) ?? '';
  out += WIDTH_FLAG[a.width] ?? '';
  return out;
}

/**
 * One drawing as a tuple, or null when `catalog` has no tool of its kind.
 * `index` is the tuple's position in the encoded list, the index its default
 * colour is judged against. Empty trailing string slots are left out; with a
 * binding all three are written before it.
 */
export function encodeTuple(
  a: Annotation,
  index: number,
  catalog: Catalog,
  slots: TupleEncodeSlots
): unknown[] | null {
  const tool = catalog.byKind(a.kind);
  if (tool === undefined) return null;
  const strings: string[] = [
    a.color === defaultAnnotationColor(index) ? '' : a.color,
    a.text,
    flagsOf(tool, a),
  ];
  const binding = slots.binding?.(a);
  if (binding === undefined) {
    while (strings.length > 0 && strings[strings.length - 1] === '') strings.pop();
  }
  const tuple: unknown[] = [
    tool.code,
    encodePoints(tool.codec.layout, a.points),
    slots.axis(a),
    slots.trace(a),
    ...strings,
  ];
  if (binding !== undefined) tuple.push(binding);
  return tuple;
}

// ── Decoding ────────────────────────────────────────────────────────────────

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const absent = (v: unknown): boolean => v === undefined || v === null || v === '';

/**
 * The points a tuple's `raw` holds in `layout`, or null when malformed. `t`
 * is rounded to whole milliseconds on a time axis only, so a value-axis x
 * keeps every digit the encoder wrote.
 */
export function decodePoints(
  layout: CodecLayout,
  raw: unknown,
  xAxis: XAxisDescriptor
): AnnotationPoint[] | null {
  if (!Array.isArray(raw) || raw.length < layout.length) return null;
  const n = raw.slice(0, layout.length);
  if (!n.every(isFiniteNumber)) return null;
  const t = xAxis.kind === 'time' ? (x: number) => Math.round(x) : (x: number) => x;
  switch (layout) {
    case 'v':
      return [{ t: 0, v: n[0] }];
    case 't':
      return [{ t: t(n[0]), v: 0 }];
    case 'tt':
      return [
        { t: t(n[0]), v: 0 },
        { t: t(n[1]), v: 0 },
      ];
    case 'tv':
      return [{ t: t(n[0]), v: n[1] }];
    case 'tvtv':
      return [
        { t: t(n[0]), v: n[1] },
        { t: t(n[2]), v: n[3] },
      ];
  }
}

/**
 * One tuple, or null when it is bad: a code `catalog` lacks, malformed
 * points, a bad slot, or a slot a resolver refuses. `index` is its position
 * in the raw list, the index its default colour was judged against.
 */
export function decodeTuple(
  tuple: unknown,
  index: number,
  catalog: Catalog,
  xAxis: XAxisDescriptor,
  slots: TupleDecodeSlots
): Annotation | null {
  if (!Array.isArray(tuple)) return null;
  const [code, rawPoints, axisIndex, traceIndex, color, text, flags, binding] = tuple as unknown[];
  const tool = typeof code === 'number' ? catalog.byCode(code) : undefined;
  if (tool === undefined) return null;
  const points = decodePoints(tool.codec.layout, rawPoints, xAxis);
  if (points === null) return null;
  if (!isIndex(axisIndex)) return null;
  if (!(traceIndex === null || traceIndex === undefined || isIndex(traceIndex))) return null;
  if (!(absent(color) || isColorLiteral(color) || color === ANNOTATION_INK)) return null;
  if (!(absent(text) || (typeof text === 'string' && text.length <= MAX_ANNOTATION_TEXT)))
    return null;
  if (!(absent(flags) || typeof flags === 'string')) return null;

  const axisId = slots.axis(axisIndex);
  if (axisId === null) return null;
  let traceId: string | undefined;
  if (typeof traceIndex === 'number') {
    const trace = slots.trace(traceIndex);
    if (trace === null) return null;
    traceId = trace.traceId;
  }

  let out: Annotation = {
    id: makeAnnotationId(),
    kind: tool.kind,
    points,
    axisId,
    color: typeof color === 'string' && color !== '' ? color : defaultAnnotationColor(index),
    // No width flag: the width a new drawing takes.
    width: NEW_DRAWING_WIDTH,
    text: typeof text === 'string' ? text : '',
  };
  if (traceId !== undefined) out.traceId = traceId;
  // Unknown flag letters are a newer writer's extras: ignored.
  const letters = typeof flags === 'string' ? flags : '';
  for (const flag of letters.match(/w\.75|w\.5|w1\.5|w[123]|[lhd]/g) ?? []) {
    if (flag === 'l') out.locked = true;
    else if (flag === 'h') out.hidden = true;
    else if (flag === 'd') out.dash = true;
    else if (flag in FLAG_WIDTH) out.width = FLAG_WIDTH[flag];
  }
  if (tool.codec.flags) out = tool.codec.flags.decode(letters, out);

  if (slots.binding) {
    if (!(binding === undefined || binding === null || isIndex(binding))) return null;
    return slots.binding(binding ?? undefined, out);
  }
  return out;
}

// ── Trace's `plot=` drawings ────────────────────────────────────────────────

/** What the encoder reads of a plot. */
export interface DrawingSource {
  annotations?: readonly Annotation[];
  axes?: readonly Pick<AxisRef, 'id'>[];
}

/** What the decoder resolves against: the plot's axes after the config is applied. */
export interface DrawingTarget {
  axes: readonly Pick<AxisRef, 'id'>[];
}

type QueryTrace = { id?: string };

/** Trace's encode slots: the axis by its index in the plot (else 0), the trace by its query index. */
function traceEncodeSlots(
  axes: readonly Pick<AxisRef, 'id'>[],
  queryTraces: readonly QueryTrace[]
): TupleEncodeSlots {
  return {
    axis: (a) =>
      Math.max(
        0,
        axes.findIndex((x) => x.id === a.axisId)
      ),
    trace: (a) => {
      const at = a.traceId === undefined ? -1 : queryTraces.findIndex((t) => t.id === a.traceId);
      return at < 0 ? null : at;
    },
  };
}

/**
 * Trace's decode slots: an axis index past the list falls to the first axis,
 * as reassignUnknownAxes does; a trace index past the pv list drops the tuple.
 */
function traceDecodeSlots(
  axes: readonly Pick<AxisRef, 'id'>[],
  queryTraces: readonly QueryTrace[]
): TupleDecodeSlots {
  return {
    axis: (i) => axes[i]?.id ?? axes[0]?.id ?? '',
    trace: (i) => {
      const traceId = queryTraces[i]?.id;
      return traceId === undefined ? null : { traceId };
    },
  };
}

/**
 * The tuples of `plot`'s drawings, or undefined when it has none. Keeps the
 * first `MAX_DRAWINGS` with one "kept k of n" warning; a drawing whose kind
 * the catalog lacks is left out.
 */
export function encodeDrawings(
  plot: DrawingSource,
  queryTraces: readonly QueryTrace[],
  options: Pick<DrawingCodecOptions, 'catalog'>
): DrawingTuple[] | undefined {
  const list = plot.annotations ?? [];
  if (list.length === 0) return undefined;
  if (list.length > MAX_DRAWINGS) {
    console.warn(`Trace query plot config: kept ${MAX_DRAWINGS} of ${list.length} drawings.`);
  }
  const { catalog } = options;
  const slots = traceEncodeSlots(plot.axes ?? [], queryTraces);
  const out: DrawingTuple[] = [];
  for (const a of list.slice(0, MAX_DRAWINGS)) {
    const tuple = encodeTuple(a, out.length, catalog, slots);
    if (tuple !== null) out.push(tuple as DrawingTuple);
  }
  return out;
}

/**
 * The drawings of a `drawings` value, resolved against `plot`'s axes and the
 * query's traces (as applyPlotConfig rebuilt them). Keeps the first
 * `MAX_DRAWINGS`; a bad tuple (unknown kind or one the catalog lacks,
 * malformed points, a bad index or slot, a trace index past the pv list) is
 * dropped and the rest kept, with one warning for the whole call.
 */
export function decodeDrawings(
  raw: unknown,
  plot: DrawingTarget,
  queryTraces: readonly QueryTrace[],
  options: DrawingCodecOptions
): Annotation[] {
  if (!Array.isArray(raw)) return [];
  const { catalog, xAxis } = options;
  const slots = traceDecodeSlots(plot.axes, queryTraces);
  const kept = raw.slice(0, MAX_DRAWINGS);
  const out: Annotation[] = [];
  kept.forEach((tuple, i) => {
    const a = decodeTuple(tuple, i, catalog, xAxis, slots);
    if (a !== null) out.push(a);
  });
  const notes: string[] = [];
  if (raw.length > MAX_DRAWINGS) notes.push(`kept the first ${MAX_DRAWINGS} of ${raw.length}`);
  const bad = kept.length - out.length;
  if (bad > 0) notes.push(`dropped ${bad} invalid`);
  if (notes.length > 0) console.warn(`Trace query plot config: drawings ${notes.join(', ')}.`);
  return out;
}
