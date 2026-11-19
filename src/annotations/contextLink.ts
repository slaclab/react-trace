// The `ann=` codec of the context links: Correlation and
// Waveform write their drawings through this one module, each with its own
// catalog, and neither re-implements any of it.
//
//   ann={"r": [...refs], "b": [{"x": xRef, "d"?: 1}, ...], "d": [...tuples]}
//
// `d` holds config.ts's tuples. Slot 2 (axis) and slot 3 (magnet trace) are
// 0-based indices into the reference table `r` (every PV string a drawing
// names); the optional 8th slot is a 0-based index into the deduped binding
// table `b`. The decoder resolves all three itself: an axis or binding index
// out of range drops that drawing (one counted warning per call, never a
// fallback to the first axis), a trace index out of range clears the magnet
// and keeps the drawing.
//
// Shedding, for a link over budget: `trimNoteTexts` cuts every inline text
// (tools with `inlineText`) to 24 code points plus '…', then empties them;
// after that `fitContextDrawings` drops drawings from the end one at a time.
// Its budget leaves room for the page keys the state-out step appends
// (`reserve`), so a link carrying drawings always reloads as fitting. Only
// the link is shed; the drawings passed in are never changed.
//
// Pure. Imports only src/annotations/**.
import type { Catalog, XAxisDescriptor } from './catalog/types';
import { VALUE_X_AXIS } from './catalog/xAxis';
import type { ShedSnapshot } from './host/shedStore';
import { decodeTuple, encodeJsonParam, encodeTuple, MAX_DRAWINGS } from './config';
import type { Annotation } from './model';

/**
 * `raw` (a query string without its "?") without its `ann` keys, every other
 * key's text kept as written: how an over-budget incoming link loses its
 * drawings first and keeps the rest. An undecodable key is not `ann`.
 */
export function withoutContextDrawings(raw: string): string {
  return raw
    .split('&')
    .filter((part) => {
      const key = part.split('=', 1)[0];
      try {
        return decodeURIComponent(key.replace(/\+/g, ' ')) !== 'ann';
      } catch {
        return true;
      }
    })
    .join('&');
}

/** A context tuple: config.ts's `DrawingTuple` with slots 2/3 indexing `r` and an optional binding slot. */
export type ContextTuple = [
  kindCode: number,
  points: number[],
  axisRef: number,
  traceRef: number | null,
  color?: string,
  text?: string,
  flags?: string,
  binding?: number,
];

/** One binding-table entry: the x source a drawing was placed against, and whether against a Δ snapshot. */
export interface ContextBinding {
  x: string;
  d?: 1;
}

/** The `ann=` value. */
export interface ContextLinkValue {
  r: string[];
  b: ContextBinding[];
  d: ContextTuple[];
}

/**
 * How a host names its drawings' axes and magnet traces in the reference
 * table. Every resolver defaults to the identity on the drawing's ids.
 */
export interface ContextRefResolvers {
  /** The reference naming `a`'s axis (Correlation: the Y PV; Waveform: `'y'`). */
  axisRef?(a: Annotation): string;
  /** The reference naming `a`'s magnet trace, or null for none. */
  traceRef?(a: Annotation): string | null;
  /** The axis id a reference names, or null to drop the drawing. */
  axisId?(ref: string): string | null;
  /** The trace id a reference names, or null to leave the drawing unsnapped. */
  traceId?(ref: string): string | null;
}

export interface ContextCodecOptions extends ContextRefResolvers {
  /** The plot's x axis; default value (`t` kept exact). */
  xAxis?: XAxisDescriptor;
  /** Drawings the link never carries (a Waveform Δ-on-snapshot drawing); counted as dropped. */
  omit?(a: Annotation): boolean;
  /** The prefix of the one decode warning. */
  warnPrefix?: string;
}

export interface ContextEncodeResult {
  /** The `ann=` value, or undefined when no drawing is written. */
  value: ContextLinkValue | undefined;
  /** Drawings not written: omitted, of a kind the catalog lacks, or past `MAX_DRAWINGS`. */
  dropped: number;
}

/** The longest inline text the first trim pass keeps, in code points (plus '…'). */
export const NOTE_TRIM_POINTS = 24;

/** The byte budget of a context link query (as Trace's `MAX_QUERY_BYTES`). */
export const CONTEXT_LINK_MAX_BYTES = 4096;

/** The `ann=` value of `list` under `catalog`. */
export function encodeContextDrawings(
  list: readonly Annotation[],
  catalog: Catalog,
  opts: ContextCodecOptions = {}
): ContextEncodeResult {
  const axisRef = opts.axisRef ?? ((a: Annotation) => a.axisId);
  const traceRef = opts.traceRef ?? ((a: Annotation) => a.traceId ?? null);
  const refs: string[] = [];
  const refIndex = new Map<string, number>();
  const ref = (s: string): number => {
    let i = refIndex.get(s);
    if (i === undefined) {
      i = refs.length;
      refs.push(s);
      refIndex.set(s, i);
    }
    return i;
  };
  const bindings: ContextBinding[] = [];
  const bindingIndex = new Map<string, number>();
  const binding = (a: Annotation): number | undefined => {
    if (a.xRef === undefined) return undefined;
    const key = JSON.stringify([a.xRef, a.delta === true]);
    let i = bindingIndex.get(key);
    if (i === undefined) {
      i = bindings.length;
      bindings.push(a.delta === true ? { x: a.xRef, d: 1 } : { x: a.xRef });
      bindingIndex.set(key, i);
    }
    return i;
  };
  const slots = {
    axis: (a: Annotation) => ref(axisRef(a)),
    trace: (a: Annotation) => {
      const r = traceRef(a);
      return r === null ? null : ref(r);
    },
    binding,
  };

  const tuples: ContextTuple[] = [];
  let dropped = 0;
  for (const a of list) {
    if (tuples.length >= MAX_DRAWINGS || opts.omit?.(a) === true) {
      dropped++;
      continue;
    }
    const tuple = encodeTuple(a, tuples.length, catalog, slots);
    if (tuple === null) dropped++;
    else tuples.push(tuple as ContextTuple);
  }
  if (tuples.length === 0) return { value: undefined, dropped };
  return { value: { r: refs, b: bindings, d: tuples }, dropped };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function isBinding(v: unknown): v is ContextBinding {
  return isRecord(v) && typeof v.x === 'string' && (v.d === undefined || v.d === 1);
}

/**
 * The drawings of an `ann=` value (the parsed object, or its JSON text) under
 * `catalog`. Keeps the first `MAX_DRAWINGS`; a bad tuple (a code the catalog
 * lacks, malformed points or slots, an axis or binding index out of range) is
 * dropped and the rest kept, with one warning for the whole call. An
 * unusable value is no drawings.
 */
export function decodeContextDrawings(
  raw: unknown,
  catalog: Catalog,
  opts: ContextCodecOptions = {}
): Annotation[] {
  const prefix = opts.warnPrefix ?? 'Drawings link';
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      console.warn(`${prefix}: unreadable drawings; ignoring them.`);
      return [];
    }
  }
  if (!isRecord(value) || !Array.isArray(value.d)) return [];
  const refs = Array.isArray(value.r) ? value.r : [];
  const bindings = Array.isArray(value.b) ? value.b : [];
  const refAt = (i: number): string | null => {
    const r: unknown = refs[i];
    return typeof r === 'string' ? r : null;
  };
  const toAxisId = opts.axisId ?? ((r: string) => r);
  const toTraceId = opts.traceId ?? ((r: string) => r);
  const slots = {
    axis: (i: number) => {
      const r = refAt(i);
      return r === null ? null : toAxisId(r);
    },
    trace: (i: number) => {
      const r = refAt(i);
      const traceId = r === null ? null : toTraceId(r);
      return traceId === null ? {} : { traceId };
    },
    binding: (i: number | undefined, a: Annotation): Annotation | null => {
      if (i === undefined) return a;
      const b: unknown = bindings[i];
      if (!isBinding(b)) return null;
      const out: Annotation = { ...a, xRef: b.x };
      if (b.d === 1) out.delta = true;
      return out;
    },
  };

  const xAxis = opts.xAxis ?? VALUE_X_AXIS;
  const kept = value.d.slice(0, MAX_DRAWINGS);
  const out: Annotation[] = [];
  kept.forEach((tuple, i) => {
    const a = decodeTuple(tuple, i, catalog, xAxis, slots);
    if (a !== null) out.push(a);
  });
  const notes: string[] = [];
  if (value.d.length > MAX_DRAWINGS) {
    notes.push(`kept the first ${MAX_DRAWINGS} of ${value.d.length}`);
  }
  const bad = kept.length - out.length;
  if (bad > 0) notes.push(`dropped ${bad} invalid`);
  if (notes.length > 0) console.warn(`${prefix}: drawings ${notes.join(', ')}.`);
  return out;
}

/**
 * `list` with the inline text of every tool with `inlineText` shortened for
 * the link: `'cut'` keeps the first {@link NOTE_TRIM_POINTS} code points plus
 * '…' (a text of 25 or fewer is unchanged), `'empty'` clears it. Unchanged
 * drawings keep their reference; `trimmed` counts the changed ones. `list`
 * itself is never modified.
 */
export function trimNoteTexts(
  list: readonly Annotation[],
  catalog: Catalog,
  mode: 'cut' | 'empty'
): { list: Annotation[]; trimmed: number } {
  let trimmed = 0;
  const out = list.map((a) => {
    if (catalog.byKind(a.kind)?.inlineText !== true || a.text === '') return a;
    let text = '';
    if (mode === 'cut') {
      const points = [...a.text];
      if (points.length <= NOTE_TRIM_POINTS + 1) return a;
      text = points.slice(0, NOTE_TRIM_POINTS).join('') + '…';
    }
    trimmed++;
    return { ...a, text };
  });
  return { list: out, trimmed };
}

export interface ContextFitOptions extends ContextCodecOptions {
  /** The whole query with this `ann=` value (already encoded), or without one (undefined). */
  queryWith(ann: string | undefined): string;
  /** Bytes the page keys (`&theme=…&embedded=…`) will add after this step. */
  reserve: number;
  /** The budget; default {@link CONTEXT_LINK_MAX_BYTES}. */
  maxBytes?: number;
}

export interface ContextFitResult {
  /** The encoded `ann=` value, or undefined when no drawing is written. */
  ann: string | undefined;
  /** `queryWith(ann)`. */
  query: string;
  /** What the link could not carry. */
  shed: ShedSnapshot;
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/**
 * The drawing steps of a context link's shedding: encode `list`; while the
 * query plus `reserve` is over budget, trim the inline texts (cut, then
 * empty), then drop drawings from the end one at a time. When no drawing
 * fits the link carries none (`ann` undefined) and the caller's own steps
 * take over.
 */
export function fitContextDrawings(
  list: readonly Annotation[],
  catalog: Catalog,
  opts: ContextFitOptions
): ContextFitResult {
  const budget = (opts.maxBytes ?? CONTEXT_LINK_MAX_BYTES) - opts.reserve;
  const attempt = (drawings: readonly Annotation[]) => {
    const { value, dropped } = encodeContextDrawings(drawings, catalog, opts);
    const ann = value === undefined ? undefined : encodeJsonParam(value);
    const query = opts.queryWith(ann);
    return { ann, query, dropped, fits: byteLength(query) <= budget };
  };
  // Trimmed = written drawings whose link text differs from the state's.
  const trimmedIn = (shed: readonly Annotation[]) =>
    shed.filter((a, i) => a.text !== list[i].text && opts.omit?.(a) !== true).length;

  let current: readonly Annotation[] = list;
  let result = attempt(current);
  for (const mode of ['cut', 'empty'] as const) {
    if (result.fits) break;
    const next = trimNoteTexts(current, catalog, mode);
    if (next.trimmed === 0) continue;
    current = next.list;
    result = attempt(current);
  }
  let kept = current.length;
  while (!result.fits && kept > 0) {
    kept--;
    result = attempt(current.slice(0, kept));
  }
  const keptList = current.slice(0, kept);
  return {
    ann: result.ann,
    query: result.query,
    shed: {
      dropped: result.dropped + (list.length - kept),
      trimmed: trimmedIn(keptList),
    },
  };
}
