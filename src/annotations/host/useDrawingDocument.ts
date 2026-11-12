// The drawing document: the one surface the drawing host parts read and
// write a plot's drawings through. It is an adapter, not a store. The drawing
// list lives in the plot's own state and is written only through the plot's
// single `update(fn: S => S)`, so the plot's history transform makes every
// write undoable. The selection is the workbench `SelectionStore`, with a
// drawing as an `item` of kind `annotation`. The hide-all flag is the
// `drawingsHidden` field of the plot's `ui` record. Only the drawing-tool
// prefs (the armed tool, stay, magnet) are session state the adapter holds
// itself, as Trace holds them beside its plots.
//
// Trace builds its document over TraceApp's state; Correlation and Waveform
// build theirs with `useDrawingDocument`. There is no `canUndo`, because
// nothing reads it, and no redo anywhere.
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import type { Annotation } from '../model';
import { DEFAULT_TOOL_PREFS, type AnnotationToolPrefs } from '../tools';
import type { SelectionStore } from '../../workbench/selection';
import { DRAWING_ITEM_KIND } from './workbench';

/** A plot's drawings, as the host parts see them. */
export interface DrawingDocument {
  /** The plot's drawing list (the state's own array, never a copy). */
  annotations: readonly Annotation[];
  /**
   * One drawing gesture: `fn` maps the current list to the next, written in a
   * single `update`, so it is one undo step. `label` names the gesture.
   */
  commit(fn: (list: Annotation[]) => Annotation[], label: string): void;
  /** Undo the newest drawing edit of this plot. */
  undo(): void;
  /** The selected drawing's id; null when no drawing is selected. */
  selectedId: string | null;
  /** Select a drawing (`null`: back to the tool level). */
  select(id: string | null): void;
  /** The drawing-tool prefs. */
  prefs: AnnotationToolPrefs;
  /** Merge `patch` into the prefs. */
  setPrefs(patch: Partial<AnnotationToolPrefs>): void;
  /** Hide all drawings of this plot. */
  hidden: boolean;
  /** Writes hide-all; absent, the strip offers no hide toggle. */
  setHidden?(on: boolean): void;
}

const NO_DRAWINGS: readonly Annotation[] = Object.freeze([]);
const noop = () => {};

/** The document of a plot given none: no drawings, and every writer a no-op. */
export const READ_ONLY_DOCUMENT: DrawingDocument = Object.freeze({
  annotations: NO_DRAWINGS,
  commit: noop,
  undo: noop,
  selectedId: null,
  select: noop,
  prefs: DEFAULT_TOOL_PREFS,
  setPrefs: noop,
  hidden: false,
  setHidden: noop,
});

/** The part of a plot's `ui` record the document reads. */
export interface DrawingUi {
  /** Hide all drawings; absent means shown. */
  drawingsHidden?: boolean;
}

/** A plot state whose drawings live in `drawings`. */
export interface DrawingsState {
  drawings: readonly Annotation[];
}

export interface DrawingDocumentInput<S extends DrawingsState, U extends DrawingUi> {
  /** The current drawing list: `state.drawings`. */
  list: readonly Annotation[];
  /** The plot's single, history-wrapped writer. */
  update(fn: (state: S) => S): void;
  /** The plot's undo: pops its drawing ring (written with the `undo` tag). */
  undo(): void;
  /** The workbench selection the plot passes to its layout. */
  selection: SelectionStore;
  /** The plot's transient UI record. */
  ui: U;
  /** Writes the `ui` record; a `useState` setter fits. */
  setUi(fn: (ui: U) => U): void;
}

/** The selected drawing's id: an `item`-level selection of kind `annotation`, else null. */
function selectedDrawingOf(selection: SelectionStore): string | null {
  const s = selection.get().selection;
  return s?.level === 'item' && s.kind === DRAWING_ITEM_KIND ? s.id : null;
}

/** The {@link DrawingDocument} of a plot whose drawings are `state.drawings`. */
export function useDrawingDocument<S extends DrawingsState, U extends DrawingUi>({
  list,
  update,
  undo,
  selection,
  ui,
  setUi,
}: DrawingDocumentInput<S, U>): DrawingDocument {
  const commit = useCallback(
    // The label is for the caller's own use; the history step is the write.
    (fn: (list: Annotation[]) => Annotation[]) =>
      // The schema's view is readonly; `fn` returns a fresh array.
      update((s) => ({ ...s, drawings: fn(s.drawings as Annotation[]) })),
    [update]
  );

  const getSelected = useCallback(() => selectedDrawingOf(selection), [selection]);
  const selectedId = useSyncExternalStore(selection.subscribe, getSelected, getSelected);
  const select = useCallback(
    (id: string | null) =>
      selection.select(id === null ? null : { level: 'item', kind: DRAWING_ITEM_KIND, id }, 'user'),
    [selection]
  );

  const [prefs, setPrefsState] = useState<AnnotationToolPrefs>(DEFAULT_TOOL_PREFS);
  const setPrefs = useCallback(
    (patch: Partial<AnnotationToolPrefs>) => setPrefsState((prev) => ({ ...prev, ...patch })),
    []
  );

  const hidden = ui.drawingsHidden === true;
  const setHidden = useCallback(
    (on: boolean) =>
      setUi((prev) =>
        (prev.drawingsHidden === true) === on ? prev : { ...prev, drawingsHidden: on }
      ),
    [setUi]
  );

  return useMemo<DrawingDocument>(
    () => ({
      annotations: list,
      commit,
      undo,
      selectedId,
      select,
      prefs,
      setPrefs,
      hidden,
      setHidden,
    }),
    [list, commit, undo, selectedId, select, prefs, setPrefs, hidden, setHidden]
  );
}
