// Trace's plot-level drawing helpers: a plot's drawing list on the `Plot`
// record, and the unknown-axis reassignment shared by rehydrate, the tuple
// decoder and undo. Pure: no React.
import type { AxisRef } from '../../../annotations/catalog/types';
import type { Annotation } from '../../../annotations/model';
import type { Plot } from '../../../types';

/** `plot` with `list` as its annotations; an empty list deletes the key so it never reaches the wire. */
export function withAnnotations(plot: Plot, list: Annotation[]): Plot {
  if (list.length > 0) return { ...plot, annotations: list };
  const rest = { ...plot };
  delete rest.annotations;
  return rest;
}

/**
 * `list` with every drawing whose `axisId` is not in `axes` moved to the first
 * axis. Returns `list` itself when nothing moves (or there is no axis), so
 * callers can detect a change by identity; untouched items keep identity.
 * Pure and silent: the caller decides whether a move deserves a warning.
 */
export function reassignUnknownAxes(
  list: Annotation[],
  axes: readonly Pick<AxisRef, 'id'>[]
): Annotation[] {
  if (axes.length === 0) return list;
  const known = new Set(axes.map((a) => a.id));
  if (list.every((a) => known.has(a.axisId))) return list;
  const first = axes[0].id;
  return list.map((a) => (known.has(a.axisId) ? a : { ...a, axisId: first }));
}
