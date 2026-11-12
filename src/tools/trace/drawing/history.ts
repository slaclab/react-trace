// Trace's drawing undo: `withAnnotationHistory`/`popAnnotationHistory` are thin adapters of
// the core `withDrawingHistory`/`popDrawingHistory` over Trace's `plots`, one
// drawing document per plot, keyed by plot id. Pure: no React.
import {
  popDrawingHistory,
  withDrawingHistory,
  type DrawingHistoryState,
  type HistoryTag,
} from '../../../annotations/history';
import type { Annotation } from '../../../annotations/model';
import type { Plot } from '../../../types';
import { reassignUnknownAxes, withAnnotations } from './plotDrawings';

/** The part of Trace's app state the history reads and writes. */
export interface AnnotationHistoryState extends DrawingHistoryState {
  plots: readonly Plot[];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

/** Trace's drawing documents: each plot's `annotations`, by plot id. */
function plotLists(app: AnnotationHistoryState): Map<string, readonly Annotation[] | undefined> {
  return new Map(app.plots.map((p) => [p.id, p.annotations]));
}

/** A write that only moves drawings off a removed axis. */
function isAxisMigration(
  prevList: Annotation[],
  nextList: Annotation[],
  plotId: string,
  next: AnnotationHistoryState
): boolean {
  const plot = next.plots.find((p) => p.id === plotId);
  return plot !== undefined && deepEqual(nextList, reassignUnknownAxes(prevList, plot.axes));
}

/**
 * {@link withDrawingHistory} over Trace's plots: a write that only moves
 * drawings off a removed axis (`next` deep-equals `reassignUnknownAxes(prev,
 * axes)`) pushes nothing.
 */
export function withAnnotationHistory<S extends AnnotationHistoryState>(
  prev: S,
  next: S,
  tag: HistoryTag | undefined,
  nowMs: number
): S {
  return withDrawingHistory(prev, next, tag, nowMs, plotLists, isAxisMigration);
}

/**
 * {@link popDrawingHistory} over Trace's plots: the restored drawings are each
 * moved onto an axis the plot still has. Returns `state`
 * when there is nothing to undo or the plot is gone.
 */
export function popAnnotationHistory<S extends AnnotationHistoryState>(
  state: S,
  plotId: string
): S {
  return popDrawingHistory(state, plotId, (s, list) => {
    const plot = s.plots.find((p) => p.id === plotId);
    if (!plot) return null;
    const restored = reassignUnknownAxes(list, plot.axes);
    return {
      ...s,
      plots: s.plots.map((p) => (p.id === plotId ? withAnnotations(p, restored) : p)),
    };
  });
}
