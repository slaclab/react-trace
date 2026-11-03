// The drawing-tool state machine: prefs live in the host keyed by plot id, the
// gesture is overlay-local. `reduceToolsIn(ctx, prefs, gesture, event)` is pure
// apart from minting the new drawing's id at commit time: the overlay runs it
// in its event handlers (never inside a React state updater) and forwards `commit`, `select` and `prefs` to TraceApp itself.
//
// Rules pinned here:
// - 1-point tools commit on pointerUp without movement; 2-point tools on
//   pointerUp after a > 3 px drag, or on the second click.
// - A create/move/handle gesture keeps a `draft` and yields exactly one
//   `commit`, on pointerUp; none on cancel or zero movement.
// - After a create commit the tool returns to cursor unless `stay`.
// - The modifier gesture (shift-drag, the catalog tool whose
//   `modifierGesture` is 'shift' -- the measure) is one-shot: a draft only,
//   never a commit.
// - Locked drawings refuse move/handle (a click still selects); hidden ones
//   are never hit.
// - Esc (`cancel`): cancel a live gesture, else disarm the tool; `consumed`
//   only for those two. The reducer never deselects -- with nothing to cancel
//   or disarm the key is left to the workbench Escape reset.
//
// Kind-agnostic: `reduceToolsIn(ctx, ...)` reads shapes,
// arity, inline text, commit labels and the modifier gesture from the tool
// definitions in `ctx.catalog` and quantizes x through `ctx.xAxis`.
//
// Point convention: a `ToolPoint` carries pixel x/y (for the drag threshold)
// and data t/v on `axisId`. For a move/handle drag the overlay projects the
// pointer onto the dragged drawing's axis, so v deltas stay in its units.
import { DRAG_THRESHOLD_PX, type SnapHit } from '../plot/geometry';
import { ANNOTATION_INK } from '../annotationTheme';
import { makeAnnotationId } from './ids';
import type { Catalog, DrawingTool, XAxisDescriptor } from './catalog/types';
import { type Annotation, type AnnotationPoint, NEW_DRAWING_WIDTH, quantizePointIn } from './model';

/** The armed tool: the cursor, or a catalog tool's `kind`. */
export type Tool = 'cursor' | string;

/** What the reducer reads its tools from: the plot's catalog and its x axis. */
export interface ToolsContext {
  catalog: Catalog;
  xAxis: XAxisDescriptor;
}

export interface AnnotationToolPrefs {
  tool: Tool;
  /** Keep the tool armed after a commit. */
  stay: boolean;
  /** Snap anchors to the nearest sample (the point's `snap` candidate). */
  magnet: boolean;
}

export const DEFAULT_TOOL_PREFS: AnnotationToolPrefs = {
  tool: 'cursor',
  stay: false,
  magnet: false,
};

/** The id a draft carries until it is committed under a fresh `makeAnnotationId`. */
export const DRAFT_ID = 'annotation-draft';

export interface ToolPoint {
  x: number;
  y: number;
  t: number;
  v: number;
  /** The Y axis `v` belongs to (the primary axis for time-only kinds). */
  axisId: string;
  /** Nearest-sample candidate; used only when `magnet` is on. */
  snap?: SnapHit | null;
  /** One pixel's worth of x on the grid the point lies in (the x quantum); 0 when unknown. */
  pxStep?: number;
}

/** What lies under the pointer at pointerDown. */
export type ToolHit =
  | { kind: 'none' }
  | { kind: 'body'; annotation: Annotation }
  | { kind: 'handle'; annotation: Annotation; index: number };

export const NO_HIT: ToolHit = { kind: 'none' };

export interface PendingDraw {
  /** The armed tool's kind. */
  tool: string;
  /** Pixel position of the press that started the current phase. */
  start: { x: number; y: number };
  /** press: first button down; await: first click done; second: second button down. */
  phase: 'press' | 'await' | 'second';
}

export interface DragGesture {
  /** `modifier`: the catalog's modifier gesture (shift-drag measure), never committed. */
  mode: 'move' | 'handle' | 'modifier';
  /** The pointer at pointerDown. */
  start: ToolPoint;
  /** True once the pointer left the threshold. */
  moved: boolean;
  /** The drawing as it was at pointerDown (the seed for `modifier`). */
  original: Annotation;
  /** Handle index for `handle`. */
  index?: number;
}

export interface GestureState {
  pending?: PendingDraw;
  drag?: DragGesture;
  draft?: Annotation;
}

export type ToolEvent =
  | { type: 'arm'; tool: Tool }
  | { type: 'pointerDown'; pt: ToolPoint; hit: ToolHit; shift?: boolean }
  | { type: 'pointerMove'; pt: ToolPoint }
  | { type: 'pointerUp'; pt: ToolPoint }
  | { type: 'cancel' }
  | { type: 'setStay'; on: boolean }
  | { type: 'setMagnet'; on: boolean }
  /** `target` = the selected drawing, or null. */
  | { type: 'keyDelete'; target: Annotation | null };

export interface ToolsResult {
  gesture: GestureState;
  prefs?: Partial<AnnotationToolPrefs>;
  commit?: { fn: (list: Annotation[]) => Annotation[]; label: string };
  select?: string | null;
  consumed?: boolean;
  /** Open the inline text editor on this drawing (a note just placed). */
  edit?: string;
}

/** The tool of `kind` in `catalog`; throws for a kind the catalog lacks. */
function toolOf(catalog: Catalog, kind: string): DrawingTool {
  const tool = catalog.byKind(kind);
  if (!tool) throw new Error(`unknown drawing kind ${JSON.stringify(kind)}`);
  return tool;
}

/** The short commit label of `kind` (the kind itself when the catalog lacks it). */
function shortLabel(catalog: Catalog, kind: string): string {
  return catalog.byKind(kind)?.label.short ?? kind;
}

/** Zero the coordinate a kind does not use, so file and tile agree. */
function shapeIn(catalog: Catalog, kind: string, p: AnnotationPoint): AnnotationPoint {
  const tool = catalog.byKind(kind);
  return tool ? tool.shapePoint(p) : p;
}

/** No gesture in progress. */
export const EMPTY_GESTURE: GestureState = {};

/** True while a press, a 2-point draw or a drag is in progress. */
export function isLive(g: GestureState): boolean {
  return g.pending !== undefined || g.drag !== undefined;
}

/** True when there is anything for a cancel to drop: a live gesture or a shown draft. */
export function hasGesture(g: GestureState): boolean {
  return isLive(g) || g.draft !== undefined;
}

function beyondThreshold(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.hypot(b.x - a.x, b.y - a.y) > DRAG_THRESHOLD_PX;
}

/** Where a new drawing's first point lands: the point, whether it is a snapped sample, its axis and curve. */
export interface Anchor {
  point: AnnotationPoint;
  snapped: boolean;
  axisId: string;
  traceId?: string;
}

function anchorOf(pt: ToolPoint, magnet: boolean): Anchor {
  if (magnet && pt.snap) {
    const { t, v, axisId, traceId } = pt.snap;
    return { point: { t, v }, snapped: true, axisId, traceId };
  }
  return { point: { t: pt.t, v: pt.v }, snapped: false, axisId: pt.axisId };
}

/** True for kinds whose text is typed on the plot, in place (the tool's `inlineText`). */
export function hasInlineTextIn(catalog: Catalog, kind: string): boolean {
  return catalog.byKind(kind)?.inlineText === true;
}

/** A new drawing of `kind` with every point at `first` (the draft id, in ink at the new-drawing width). */
export function seedDrawingIn(catalog: Catalog, kind: string, first: Anchor): Annotation {
  const tool = toolOf(catalog, kind);
  const p = tool.shapePoint(first.point);
  const out: Annotation = {
    id: DRAFT_ID,
    kind,
    points: tool.arity === 1 ? [p] : [p, p],
    axisId: first.axisId,
    color: ANNOTATION_INK,
    width: NEW_DRAWING_WIDTH,
    text: '',
  };
  if (first.traceId !== undefined) out.traceId = first.traceId;
  return out;
}

/** The draft of a create gesture with the moving end at `pt`. */
function stretchDraft(
  ctx: ToolsContext,
  draft: Annotation,
  pt: ToolPoint,
  magnet: boolean
): Annotation {
  const a = anchorOf(pt, magnet);
  const end = shapeIn(ctx.catalog, draft.kind, a.point);
  if (toolOf(ctx.catalog, draft.kind).arity === 2)
    return { ...draft, points: [draft.points[0], end] };
  // A 1-point draft follows the pointer; its anchor is re-derived (snap may change).
  const next: Annotation = { ...draft, points: [end], axisId: a.axisId };
  if (a.traceId !== undefined) next.traceId = a.traceId;
  else delete next.traceId;
  return next;
}

/** A point shaped for `kind` and quantized through the context's x axis. */
function commitPoint(
  ctx: ToolsContext,
  kind: string,
  p: AnnotationPoint,
  snapped: boolean,
  pxStep: number
): AnnotationPoint {
  return shapeIn(ctx.catalog, kind, quantizePointIn(ctx.xAxis, p, snapped, pxStep));
}

function quantizeDraft(
  ctx: ToolsContext,
  draft: Annotation,
  snapped: boolean[],
  pxStep: number
): Annotation {
  return {
    ...draft,
    points: draft.points.map((p, i) =>
      commitPoint(ctx, draft.kind, p, snapped[i] ?? false, pxStep)
    ),
  };
}

/** The commit that appends `drawing` to the list. */
export function appendCommitIn(
  catalog: Catalog,
  drawing: Annotation
): NonNullable<ToolsResult['commit']> {
  return {
    fn: (list) => [...list, drawing],
    label: `Draw ${shortLabel(catalog, drawing.kind)}`,
  };
}

function afterCommitPrefs(prefs: AnnotationToolPrefs): Partial<AnnotationToolPrefs> | undefined {
  return prefs.stay || prefs.tool === 'cursor' ? undefined : { tool: 'cursor' };
}

/** The create commit: id minted here (event handler), colour by creation index in `fn`. */
function createResult(
  ctx: ToolsContext,
  prefs: AnnotationToolPrefs,
  draft: Annotation,
  pt: ToolPoint,
  firstSnapped: boolean
): ToolsResult {
  const id = makeAnnotationId();
  const endSnapped = prefs.magnet && !!pt.snap;
  const tool = toolOf(ctx.catalog, draft.kind);
  const snapped = tool.arity === 1 ? [endSnapped] : [firstSnapped, endSnapped];
  const shaped = { ...quantizeDraft(ctx, draft, snapped, pt.pxStep ?? 0), id };
  const result: ToolsResult = {
    gesture: EMPTY_GESTURE,
    commit: appendCommitIn(ctx.catalog, shaped),
    select: id,
  };
  if (tool.inlineText === true) result.edit = id;
  const p = afterCommitPrefs(prefs);
  if (p) result.prefs = p;
  return result;
}

function replaceResult(
  ctx: ToolsContext,
  original: Annotation,
  draft: Annotation,
  label: string
): ToolsResult {
  const points = draft.points;
  return {
    gesture: EMPTY_GESTURE,
    commit: {
      fn: (list) =>
        list.some((a) => a.id === original.id)
          ? list.map((a) => (a.id === original.id ? { ...a, points } : a))
          : list,
      label: `${label} ${shortLabel(ctx.catalog, original.kind)}`,
    },
  };
}

function dragDraft(
  ctx: ToolsContext,
  drag: DragGesture,
  pt: ToolPoint,
  magnet: boolean
): Annotation {
  const { original, start } = drag;
  if (drag.mode === 'modifier') {
    return { ...original, points: [original.points[0], { t: pt.t, v: pt.v }] };
  }
  const pxStep = pt.pxStep ?? 0;
  if (drag.mode === 'handle') {
    const i = drag.index ?? 0;
    const a = anchorOf(pt, magnet);
    const p = commitPoint(ctx, original.kind, a.point, a.snapped, pxStep);
    return { ...original, points: original.points.map((q, j) => (j === i ? p : q)) };
  }
  const dt = pt.t - start.t;
  const dv = pt.v - start.v;
  return {
    ...original,
    points: original.points.map((q) =>
      commitPoint(ctx, original.kind, { t: q.t + dt, v: q.v + dv }, false, pxStep)
    ),
  };
}

/** The catalog's shift-drag tool (the measure), if it offers one. */
function modifierTool(catalog: Catalog): DrawingTool | undefined {
  return catalog.tools.find((t) => t.modifierGesture === 'shift');
}

function pointerDown(
  ctx: ToolsContext,
  prefs: AnnotationToolPrefs,
  gesture: GestureState,
  pt: ToolPoint,
  hit: ToolHit,
  shift: boolean
): ToolsResult {
  const { pending, draft } = gesture;
  // Second click of a 2-point draw.
  if (pending && pending.phase === 'await' && draft) {
    return {
      gesture: {
        pending: { ...pending, phase: 'second', start: { x: pt.x, y: pt.y } },
        draft: stretchDraft(ctx, draft, pt, prefs.magnet),
      },
    };
  }
  if (isLive(gesture)) return { gesture };

  if (prefs.tool !== 'cursor') {
    const tool = prefs.tool;
    return {
      gesture: {
        pending: { tool, start: { x: pt.x, y: pt.y }, phase: 'press' },
        draft: seedDrawingIn(ctx.catalog, tool, anchorOf(pt, prefs.magnet)),
      },
    };
  }

  const modifier = shift ? modifierTool(ctx.catalog) : undefined;
  if (modifier) {
    const original = seedDrawingIn(ctx.catalog, modifier.kind, anchorOf(pt, false));
    return { gesture: { drag: { mode: 'modifier', start: pt, moved: false, original } } };
  }

  if (hit.kind === 'none' || hit.annotation.hidden) return { gesture };
  const a = hit.annotation;
  if (a.locked) return { gesture, select: a.id };
  const drag: DragGesture =
    hit.kind === 'handle'
      ? { mode: 'handle', start: pt, moved: false, original: a, index: hit.index }
      : { mode: 'move', start: pt, moved: false, original: a };
  return { gesture: { drag }, select: a.id };
}

function pointerMove(
  ctx: ToolsContext,
  prefs: AnnotationToolPrefs,
  gesture: GestureState,
  pt: ToolPoint
): ToolsResult {
  const { pending, drag, draft } = gesture;
  if (pending && draft) {
    if (
      toolOf(ctx.catalog, draft.kind).arity === 1 ||
      pending.phase !== 'press' ||
      beyondThreshold(pending.start, pt)
    ) {
      return { gesture: { pending, draft: stretchDraft(ctx, draft, pt, prefs.magnet) } };
    }
    return { gesture };
  }
  if (drag) {
    const moved = drag.moved || beyondThreshold(drag.start, pt);
    if (!moved) return { gesture };
    return {
      gesture: { drag: { ...drag, moved }, draft: dragDraft(ctx, drag, pt, prefs.magnet) },
    };
  }
  return { gesture };
}

function pointerUp(
  ctx: ToolsContext,
  prefs: AnnotationToolPrefs,
  gesture: GestureState,
  pt: ToolPoint
): ToolsResult {
  const { pending, drag, draft } = gesture;
  if (pending && draft) {
    const final = stretchDraft(ctx, draft, pt, prefs.magnet);
    if (
      toolOf(ctx.catalog, draft.kind).arity === 2 &&
      pending.phase === 'press' &&
      !beyondThreshold(pending.start, pt)
    ) {
      // A click: keep the first anchor and wait for the second click.
      return { gesture: { pending: { ...pending, phase: 'await' }, draft } };
    }
    if (pending.phase === 'await') return { gesture };
    const firstSnapped = draft.traceId !== undefined && prefs.magnet;
    return createResult(ctx, prefs, final, pt, firstSnapped);
  }
  if (drag) {
    if (drag.mode === 'modifier' || !drag.moved) return { gesture: EMPTY_GESTURE };
    const final = dragDraft(ctx, drag, pt, prefs.magnet);
    return replaceResult(ctx, drag.original, final, drag.mode === 'move' ? 'Move' : 'Edit');
  }
  return { gesture };
}

/** Advance the tool state machine by one event, reading tools from `ctx.catalog`. */
export function reduceToolsIn(
  ctx: ToolsContext,
  prefs: AnnotationToolPrefs,
  gesture: GestureState,
  event: ToolEvent
): ToolsResult {
  switch (event.type) {
    case 'arm':
      return { gesture: EMPTY_GESTURE, prefs: { tool: event.tool } };
    case 'setStay':
      return { gesture, prefs: { stay: event.on } };
    case 'setMagnet':
      return { gesture, prefs: { magnet: event.on } };
    case 'pointerDown':
      return pointerDown(ctx, prefs, gesture, event.pt, event.hit, event.shift ?? false);
    case 'pointerMove':
      return pointerMove(ctx, prefs, gesture, event.pt);
    case 'pointerUp':
      return pointerUp(ctx, prefs, gesture, event.pt);
    case 'cancel':
      if (hasGesture(gesture)) return { gesture: EMPTY_GESTURE, consumed: true };
      if (prefs.tool !== 'cursor') return { gesture, prefs: { tool: 'cursor' }, consumed: true };
      return { gesture };
    case 'keyDelete': {
      const target = event.target;
      if (isLive(gesture) || !target || target.locked) return { gesture };
      return {
        gesture,
        commit: {
          fn: (list) =>
            list.some((a) => a.id === target.id) ? list.filter((a) => a.id !== target.id) : list,
          label: `Delete ${shortLabel(ctx.catalog, target.kind)}`,
        },
        select: null,
        consumed: true,
      };
    }
  }
}
