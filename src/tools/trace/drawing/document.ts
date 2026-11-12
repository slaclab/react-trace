// Trace's drawing document: a `DrawingDocument` over
// the drawing props TraceApp hands each SinglePlot through its
// `AnnotationChannel` (`annotationMountProps`). The state stays TraceApp's:
// commits go through its `update` (one undo step each), selection through its
// queued cross-plot select, prefs and hide-all through its per-plot maps. An
// absent writer becomes a no-op, which is what the layer did with an absent
// callback; an absent hide-all writer stays absent, so the strip offers no
// hide toggle. Undo stays TraceApp's document-level `primary+Z` listener (one
// per window), so `undo` here does nothing.
import { useMemo } from 'react';
import type { Annotation } from '../../../annotations/model';
import type { AnnotationToolPrefs } from '../../../annotations/tools';
import {
  READ_ONLY_DOCUMENT,
  type DrawingDocument,
} from '../../../annotations/host/useDrawingDocument';

/** SinglePlot's drawing props (the `AnnotationChannel` slice of one plot) and its list. */
export interface TraceDrawingProps {
  annotations?: readonly Annotation[];
  annotationsHidden?: boolean;
  annotationPrefs?: AnnotationToolPrefs;
  onAnnotationPrefs?: (patch: Partial<AnnotationToolPrefs>) => void;
  selectedAnnotationId?: string | null;
  onSelectAnnotation?: (id: string | null) => void;
  onCommitAnnotations?: (fn: (list: Annotation[]) => Annotation[], label: string) => void;
  onAnnotationsHidden?: (on: boolean) => void;
}

// An absent prop falls back to the read-only document's value.
const NONE = READ_ONLY_DOCUMENT;

export function traceDrawingDocument(p: TraceDrawingProps): DrawingDocument {
  return {
    annotations: p.annotations ?? NONE.annotations,
    commit: p.onCommitAnnotations ?? NONE.commit,
    undo: NONE.undo,
    selectedId: p.selectedAnnotationId ?? null,
    select: p.onSelectAnnotation ?? NONE.select,
    prefs: p.annotationPrefs ?? NONE.prefs,
    setPrefs: p.onAnnotationPrefs ?? NONE.setPrefs,
    hidden: p.annotationsHidden === true,
    setHidden: p.onAnnotationsHidden,
  };
}

/** The memoized {@link traceDrawingDocument}: a new object only when a prop changes. */
export function useTraceDrawingDocument(p: TraceDrawingProps): DrawingDocument {
  const {
    annotations,
    annotationsHidden,
    annotationPrefs,
    onAnnotationPrefs,
    selectedAnnotationId,
    onSelectAnnotation,
    onCommitAnnotations,
    onAnnotationsHidden,
  } = p;
  return useMemo(
    () =>
      traceDrawingDocument({
        annotations,
        annotationsHidden,
        annotationPrefs,
        onAnnotationPrefs,
        selectedAnnotationId,
        onSelectAnnotation,
        onCommitAnnotations,
        onAnnotationsHidden,
      }),
    [
      annotations,
      annotationsHidden,
      annotationPrefs,
      onAnnotationPrefs,
      selectedAnnotationId,
      onSelectAnnotation,
      onCommitAnnotations,
      onAnnotationsHidden,
    ]
  );
}
