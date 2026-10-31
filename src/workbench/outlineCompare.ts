// What an Outline view-model *shows*, as a structural compare (the rate rule).
// A row is its id, kind, status, label and refusal; a section head is
// everything but its rows, the add row's search by identity. The Outline keeps
// the previous objects where these say "same"; a tool binding that returns its
// previous view-model while nothing shown changed uses `sameOutline`.

import type { OutlineRow, OutlineSection, OutlineViewModel } from './types';

export function sameRow(a: OutlineRow, b: OutlineRow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.status === b.status &&
    a.label === b.label &&
    a.refusal === b.refusal
  );
}

function sameAdd(a: OutlineSection['add'], b: OutlineSection['add']): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.placeholder === b.placeholder && a.disabled === b.disabled && a.search === b.search;
}

/** A section's header fields (everything but its rows). */
export function sameHead(a: OutlineSection, b: OutlineSection): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.title === b.title &&
    a.unit === b.unit &&
    a.count === b.count &&
    a.capacity === b.capacity &&
    a.muted === b.muted &&
    sameAdd(a.add, b.add)
  );
}

function sameSection(a: OutlineSection, b: OutlineSection): boolean {
  return (
    sameHead(a, b) &&
    a.rows.length === b.rows.length &&
    a.rows.every((row, i) => sameRow(row, b.rows[i]))
  );
}

/** Whether two view-models show the same thing. */
export function sameOutline(a: OutlineViewModel, b: OutlineViewModel): boolean {
  return (
    a.sections.length === b.sections.length &&
    a.sections.every((s, i) => sameSection(s, b.sections[i]))
  );
}
