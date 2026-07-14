// Generates unique ids for plots, traces, and axes.
//
// These were previously built inline as `${kind}-${Date.now()}`, which
// collides when two ids of the same kind are created within one millisecond
// (e.g. a batch import that adds several axes at once), corrupting lookups
// keyed by id. A module-level monotonic counter appended to the timestamp
// keeps ids unique regardless of timing while preserving the readable
// `kind-...` shape. The counter is process-wide, so ids stay unique across
// every plot/trace/axis in the session, not just within one component.

let counter = 0;

export type IdKind = 'plot' | 'trace' | 'axis';

export function makeId(kind: IdKind): string {
  return `${kind}-${Date.now()}-${counter++}`;
}
