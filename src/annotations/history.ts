// Drawing undo. Every drawing document (a Trace plot, a Correlation or
// Waveform plot) keeps a ring of its previous drawing lists.
// `withDrawingHistory` advances the rings as a pure post-transform of the
// app's single writer: `nowMs` is read once outside the state updater, so a
// StrictMode double invocation records one entry. The core knows documents
// only by id and reads their lists through an injected accessor; Trace's
// `withAnnotationHistory`/`popAnnotationHistory` are thin adapters over
// `plots` in `tools/trace/drawing/history`.
//
// The undo key is not a registry action: each host mounts
// `host/UndoKeyListener`, one native keydown listener per document, which
// uses the predicates that live here. Pure: no React.
import type { Annotation } from './model';

/** Depth of each plot's undo ring. */
export const HISTORY_DEPTH = 60;
/** Consecutive writes to the same single drawing within this many ms are one undo step. */
export const COALESCE_MS = 500;

/** Writes that never become an undo step. */
export type HistoryTag = 'undo' | 'rehydrate';

/**
 * The last recorded single-drawing write, for coalescing a drag into one step.
 * `plotId` is the id of the drawing document (a plot) the write went to.
 */
export interface AnnotationMark {
  plotId: string;
  id: string;
  atMs: number;
}

/** The undo rings of a set of drawing documents, keyed by document id. */
export interface DrawingHistoryState {
  history: Map<string, Annotation[][]>;
  annotationMark?: AnnotationMark | null;
}

/**
 * The drawing lists of `app` by document id. A document missing from the map
 * does not exist (so nothing is recorded for it); a present document whose
 * list is `undefined` has no drawings (`[]`).
 */
export type DrawingLists<S> = (app: S) => ReadonlyMap<string, readonly Annotation[] | undefined>;

/**
 * True when the change of document `docId` from `prevList` to `nextList` is a
 * pure migration (e.g. drawings moved off a removed axis) that must not become
 * an undo step. `next` is the new app state.
 */
export type DrawingMigrationCheck<S> = (
  prevList: Annotation[],
  nextList: Annotation[],
  docId: string,
  next: S
) => boolean;

/**
 * Writes `list` as document `docId`'s drawings in `state`; null when the
 * document no longer exists.
 */
export type DrawingRestore<S> = (state: S, list: Annotation[], docId: string) => S | null;

const NONE: Annotation[] = [];

/** The id of the one drawing `next` changed in place relative to `prev`; null otherwise. */
function singleEditedId(prev: Annotation[], next: Annotation[]): string | null {
  if (prev.length !== next.length) return null;
  let id: string | null = null;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] === next[i]) continue;
    if (id !== null || prev[i].id !== next[i].id) return null;
    id = next[i].id;
  }
  return id;
}

/**
 * `next` with the undo rings advanced for every document whose drawing list
 * identity changed between `prev` and `next` (lists read through `lists`): the
 * previous list is pushed (ring of {@link HISTORY_DEPTH}). Writes tagged
 * `undo` or `rehydrate` push nothing; a write `isMigration` reports as a pure
 * migration pushes nothing; consecutive writes to the same single drawing
 * within {@link COALESCE_MS} are one entry. Returns `next` itself when nothing
 * is recorded.
 */
export function withDrawingHistory<S extends DrawingHistoryState>(
  prev: S,
  next: S,
  tag: HistoryTag | undefined,
  nowMs: number,
  lists: DrawingLists<S>,
  isMigration?: DrawingMigrationCheck<S>
): S {
  const before = lists(prev);
  const after = lists(next);
  let history: Map<string, Annotation[][]> | null = null;
  let mark = next.annotationMark ?? null;
  let markChanged = false;
  for (const [docId, rawNext] of after) {
    if (!before.has(docId)) continue;
    const rawPrev = before.get(docId);
    if (rawPrev === rawNext) continue;
    const prevList = (rawPrev ?? NONE) as Annotation[];
    const nextList = (rawNext ?? NONE) as Annotation[];
    if (tag !== undefined) {
      if (mark?.plotId === docId) {
        mark = null;
        markChanged = true;
      }
      continue;
    }
    if (isMigration?.(prevList, nextList, docId, next)) continue;
    const edited = singleEditedId(prevList, nextList);
    const coalesce =
      edited !== null &&
      mark !== null &&
      mark.plotId === docId &&
      mark.id === edited &&
      nowMs - mark.atMs <= COALESCE_MS;
    mark = edited === null ? null : { plotId: docId, id: edited, atMs: nowMs };
    markChanged = true;
    if (coalesce) continue;
    history ??= new Map(next.history);
    const ring = [...(history.get(docId) ?? []), prevList];
    history.set(docId, ring.length > HISTORY_DEPTH ? ring.slice(-HISTORY_DEPTH) : ring);
  }
  if (!history && !markChanged) return next;
  return { ...next, history: history ?? next.history, annotationMark: mark };
}

/**
 * `state` with the newest ring entry of `docId` popped and written back as
 * that document's drawings through `restore`. Write it with the `undo` tag.
 * Returns `state` when there is nothing to undo or `restore` reports the
 * document gone.
 */
export function popDrawingHistory<S extends DrawingHistoryState>(
  state: S,
  docId: string,
  restore: DrawingRestore<S>
): S {
  const ring = state.history.get(docId);
  if (!ring || ring.length === 0) return state;
  const written = restore(state, ring[ring.length - 1], docId);
  if (written === null) return state;
  const history = new Map(state.history);
  history.set(docId, ring.slice(0, -1));
  return { ...written, history, annotationMark: null };
}

// ── One-document records ────────────────────────────────────────────────────

/**
 * A plot's app record with one drawing document (Correlation, Waveform): a
 * state carrying its drawing list, beside that document's undo ring.
 */
export interface DrawingRecord {
  state: { drawings: readonly Annotation[] };
  drawingHistory: DrawingHistoryState;
}

/** What the history core sees of a record: the ring beside the drawing list. */
type TrackedRecord = DrawingHistoryState & { drawings: readonly Annotation[] };

function trackedRecord(record: DrawingRecord): TrackedRecord {
  return { ...record.drawingHistory, drawings: record.state.drawings };
}

/**
 * `next` with a change of its drawing list recorded in document `docId`'s ring,
 * by {@link withDrawingHistory}'s rules. `prev` when `next` is `prev`; `next`
 * itself when nothing is recorded.
 */
export function withRecordHistory<R extends DrawingRecord>(
  prev: R,
  next: R,
  tag: HistoryTag | undefined,
  nowMs: number,
  docId: string
): R {
  if (next === prev) return prev;
  const after = trackedRecord(next);
  const out = withDrawingHistory(
    trackedRecord(prev),
    after,
    tag,
    nowMs,
    (t) => new Map([[docId, t.drawings]])
  );
  if (out === after) return next;
  return { ...next, drawingHistory: { history: out.history, annotationMark: out.annotationMark } };
}

/**
 * `record` with the newest step of document `docId` popped and its list
 * written back through `withDrawings`; `record` itself when there is nothing
 * to undo. Write it with the `undo` tag.
 */
export function popRecordHistory<R extends DrawingRecord>(
  record: R,
  docId: string,
  withDrawings: (state: R['state'], list: Annotation[]) => R['state']
): R {
  const t = trackedRecord(record);
  const popped = popDrawingHistory(t, docId, (s, list) => ({ ...s, drawings: list }));
  if (popped === t) return record;
  return {
    ...record,
    state: withDrawings(record.state, popped.drawings as Annotation[]),
    drawingHistory: { history: popped.history, annotationMark: popped.annotationMark },
  };
}

// ── The undo key ────────────────────────────────────────────────────────────

const TEXT_ENTRY_TYPES = new Set([
  'text',
  'search',
  'number',
  'email',
  'url',
  'password',
  'tel',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

/**
 * True when `target` takes typed text, so the browser's own undo applies: a
 * textarea, a contenteditable, or an `<input>` of a text-entry type. Never a
 * select, colour, checkbox, radio or button input. Duck-typed,
 * because a detached window's elements belong to another realm.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const el = target as (Partial<HTMLElement> & { type?: string }) | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  return TEXT_ENTRY_TYPES.has((el.type ?? 'text').toLowerCase());
}

/** The fields of a keydown the undo key reads. */
export interface UndoKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
}

/** True for an unclaimed `primary+Z` (Cmd on macOS, Ctrl elsewhere) outside text entry. */
export function isUndoKey(e: UndoKeyEvent, mac: boolean): boolean {
  if (e.defaultPrevented || e.altKey || e.shiftKey) return false;
  if (!(mac ? e.metaKey : e.ctrlKey)) return false;
  if (e.key.toLowerCase() !== 'z') return false;
  return !isTextEntryTarget(e.target);
}
