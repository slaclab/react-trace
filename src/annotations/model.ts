// The drawing data model: the persisted shape of a drawing, the commit-time
// quantization that makes the `.trc.json` file and the `plot=` tile agree, the
// lenient validator used by `rehydratePlot` and the config decoder, and the
// Layers label. Pure: no React.
//
// A drawing's `kind` is a string checked against a catalog. Every function
// takes the catalog and the x-axis descriptor explicitly. Value and duration
// formatting lives in `catalog/format` and the descriptors.
//
// Colours come from src/annotationTheme.ts -- this tree is literal-guarded.
import { ANNOTATION_INK, defaultAnnotationColor, isColorLiteral } from '../annotationTheme';
import { makeAnnotationId } from './ids';
import type { BuiltinKind } from './catalog';
import type { AxisRef, Catalog, DrawingTool, XAxisDescriptor } from './catalog/types';

/** A built-in tool's kind (Trace-typed code); a drawing's `kind` is any kind of its catalog. */
export type AnnotationKind = BuiltinKind;

/**
 * t = x (integer ms since epoch on a time axis, the axis value on a value
 * axis); v in the units of the annotation's axis.
 */
export interface AnnotationPoint {
  t: number;
  v: number;
}

export type AnnotationWidth = 0.5 | 0.75 | 1 | 1.5 | 2 | 3;

export interface Annotation {
  /** makeAnnotationId(). */
  id: string;
  /** A kind of the plot's catalog. */
  kind: string;
  /** `arityIn(catalog, kind)` points: 1 for hline/vline/note, 2 for trange/trend/box/measure. */
  points: AnnotationPoint[];
  /** Y axis the v values belong to; vline/trange carry the primary axis id. */
  axisId: string;
  /** Curve the first anchor snapped to (magnet); absent when unsnapped. */
  traceId?: string;
  /** A css colour, or `ANNOTATION_INK` for the theme's ink (annotationTheme.ts). */
  color: string;
  width: AnnotationWidth;
  /** Only true is stored. */
  dash?: true;
  /** Label; the note body for 'note'. */
  text: string;
  /** Trend only; absent = none. */
  extend?: 'right' | 'both';
  locked?: true;
  hidden?: true;
  /** The x source the drawing was placed against; absent in Trace. */
  xRef?: string;
  /** Placed against a Δ snapshot; only true is stored; absent in Trace. */
  delta?: true;
}

/** Every stroke width a drawing may carry: the style panel's widths, and 3 as files and links hold it. */
export const ANNOTATION_WIDTHS: readonly AnnotationWidth[] = [0.5, 0.75, 1, 1.5, 2, 3];
/** The widths the style panel and the Inspector offer, thinnest first. */
export const STYLE_WIDTHS: readonly AnnotationWidth[] = [0.5, 0.75, 1, 1.5, 2];
/** The width a new drawing takes, and that of a record or link tuple naming none: a fine line, as in a printed figure. */
export const NEW_DRAWING_WIDTH: AnnotationWidth = 0.75;

/** One style choice of the style panel: a colour, a width, or dashed on / off. */
export type StylePatch = Partial<Pick<Annotation, 'color' | 'width'>> & { dash?: boolean };

/** `a` with one style choice applied; the same reference when nothing changes. */
export function withStyle(a: Annotation, patch: StylePatch): Annotation {
  let out = a;
  if (patch.color !== undefined && patch.color !== a.color) out = { ...out, color: patch.color };
  if (patch.width !== undefined && patch.width !== a.width) out = { ...out, width: patch.width };
  if (patch.dash !== undefined && patch.dash !== (a.dash === true)) {
    out = { ...out };
    if (patch.dash) out.dash = true;
    else delete out.dash;
  }
  return out;
}

/** The longest label a drawing keeps: the `plot=` decoder drops a tuple with a longer text. */
export const MAX_ANNOTATION_TEXT = 200;

/** The tool of `kind` in `catalog`; throws on a kind the catalog does not know. */
function toolOf(catalog: Catalog, kind: string): DrawingTool {
  const tool = catalog.byKind(kind);
  if (!tool) throw new Error(`unknown drawing kind ${JSON.stringify(kind)}`);
  return tool;
}

/** How many points a kind stores. */
export function arityIn(catalog: Catalog, kind: string): 1 | 2 {
  return toolOf(catalog, kind).arity;
}

/** True iff the kind's points carry a value, so its drawing belongs to a Y axis. */
export function hasValueAxisIn(catalog: Catalog, kind: string): boolean {
  return toolOf(catalog, kind).axes !== 'x';
}

/** True when drawings of `kind` ignore the x source: a tool whose `axes` is `'y'` (the H-line). */
export function ignoresXIn(catalog: Catalog, kind: string): boolean {
  return catalog.byKind(kind)?.axes === 'y';
}

/**
 * True when `a` was placed against another x source than `drawnX`: it
 * carries an `xRef` that differs, and its tool does not ignore x. A drawing
 * with no `xRef` never is; an unknown kind counts as reading x.
 */
export function xSourceChangedIn(
  catalog: Catalog,
  a: Pick<Annotation, 'kind' | 'xRef'>,
  drawnX: string
): boolean {
  return a.xRef !== undefined && a.xRef !== drawnX && !ignoresXIn(catalog, a.kind);
}

/**
 * A point as committed: x through the descriptor's `quantize` (`pxStep` is one
 * pixel's worth of x on the grid it was placed in); a free-placed `v` kept to
 * 6 significant digits; a snapped `v` (an exact sample value) kept as is.
 */
export function quantizePointIn(
  xAxis: XAxisDescriptor,
  p: AnnotationPoint,
  snapped: boolean,
  pxStep = 0
): AnnotationPoint {
  return {
    t: xAxis.quantize(p.t, snapped, pxStep),
    v: snapped ? p.v : Number(p.v.toPrecision(6)),
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** A stored point, or null when malformed; `t` is rounded to whole ms only on a time axis. */
export function readPointIn(xAxis: XAxisDescriptor, x: unknown): AnnotationPoint | null {
  if (!isRecord(x)) return null;
  const { t, v } = x;
  if (typeof t !== 'number' || typeof v !== 'number') return null;
  if (!Number.isFinite(t) || !Number.isFinite(v)) return null;
  return { t: xAxis.kind === 'time' ? Math.round(t) : t, v };
}

/**
 * A loaded annotation, or null. Lenient: an item that is not an object, has a
 * kind `catalog` does not know or malformed points is dropped with one
 * console warning, prefixed with `warnPrefix` (the caller's name, e.g.
 * 'Trace'); missing or invalid style falls back to the defaults silently (a
 * colour must be a colour literal or `ink`, see `isColorLiteral`); extra
 * points beyond the kind's arity and unknown keys are discarded.
 * Tool-specific properties go through the tool's `validate`; its null drops
 * the item with one warning too. A missing `axisId` becomes '' so
 * `reassignUnknownAxes` moves it to the first axis.
 */
export function validateAnnotationIn(
  catalog: Catalog,
  raw: unknown,
  xAxis: XAxisDescriptor,
  warnPrefix: string
): Annotation | null {
  if (!isRecord(raw)) {
    console.warn(`${warnPrefix}: dropped a drawing that is not an object`);
    return null;
  }
  const { kind } = raw;
  const tool = typeof kind === 'string' ? catalog.byKind(kind) : undefined;
  if (!tool) {
    console.warn(
      `${warnPrefix}: dropped a drawing of unknown kind ${JSON.stringify(kind ?? null)}`
    );
    return null;
  }
  const n = tool.arity;
  const rawPoints = raw.points;
  const points =
    Array.isArray(rawPoints) && rawPoints.length >= n
      ? rawPoints.slice(0, n).map((p) => readPointIn(xAxis, p))
      : null;
  if (points === null || points.some((p) => p === null)) {
    console.warn(`${warnPrefix}: dropped a ${tool.kind} drawing with malformed points`);
    return null;
  }

  const base: Annotation = {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : makeAnnotationId(),
    kind: tool.kind,
    points: points as AnnotationPoint[],
    axisId: typeof raw.axisId === 'string' ? raw.axisId : '',
    color:
      isColorLiteral(raw.color) || raw.color === ANNOTATION_INK
        ? raw.color
        : defaultAnnotationColor(0),
    width: ANNOTATION_WIDTHS.includes(raw.width as AnnotationWidth)
      ? (raw.width as AnnotationWidth)
      : NEW_DRAWING_WIDTH,
    text: typeof raw.text === 'string' ? raw.text : '',
  };
  if (typeof raw.traceId === 'string' && raw.traceId !== '') base.traceId = raw.traceId;
  if (raw.dash === true) base.dash = true;
  // The tool's own keys go before the common tail, so a saved file keeps its key order.
  const checked = tool.validate ? tool.validate(raw, base) : base;
  if (checked === null) {
    console.warn(`${warnPrefix}: dropped a ${tool.kind} drawing with invalid properties`);
    return null;
  }
  const out: Annotation = { ...checked };
  if (raw.locked === true) out.locked = true;
  if (raw.hidden === true) out.hidden = true;
  if (typeof raw.xRef === 'string' && raw.xRef !== '') out.xRef = raw.xRef;
  if (raw.delta === true) out.delta = true;
  return out;
}

/**
 * The Layers label of a drawing, from its tool's `objName` with the drawing's
 * axis (when `axes` has it) and the plot's x-axis descriptor. A kind the
 * catalog does not know is labelled with the kind itself.
 */
export function objNameIn(
  catalog: Catalog,
  xAxis: XAxisDescriptor,
  a: Annotation,
  axes: readonly AxisRef[],
  binned = false
): string {
  const tool = catalog.byKind(a.kind);
  if (!tool) return a.kind;
  const axis = axes.find((x) => x.id === a.axisId);
  return tool.objName(a, { axis, xAxis, binned });
}
