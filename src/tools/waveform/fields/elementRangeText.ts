// The Element range field's commit rule, apart from its renderer so the component module exports
// components only. Same domain as `elems=` in `../query`: 0-based
// inclusive element indices, either side may be open, First ≤ Last.

import type { WaveformElementRange } from '../query';

export const ELEMENT_RANGE_ERROR = 'Use whole element indices from 0, with First ≤ Last.';

/** The text a range side shows: its index, or '' when open. */
export function elementRangeText(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function side(text: string): number | undefined | 'invalid' {
  const t = text.trim();
  if (t === '') return undefined;
  if (!/^\d+$/.test(t)) return 'invalid';
  return Number(t);
}

/**
 * The range two typed texts commit to: null when both are empty (all
 * elements), the range otherwise; 'invalid' when a side is not a whole index
 * from 0 or First > Last.
 */
export function commitElementRange(
  first: string,
  last: string
): WaveformElementRange | null | 'invalid' {
  const f = side(first);
  const l = side(last);
  if (f === 'invalid' || l === 'invalid') return 'invalid';
  if (f !== undefined && l !== undefined && f > l) return 'invalid';
  const out: WaveformElementRange = {};
  if (f !== undefined) out.first = f;
  if (l !== undefined) out.last = l;
  return f === undefined && l === undefined ? null : out;
}

/** Two ranges hold the same bounds (null and {} both mean all elements). */
export function sameElementRange(
  a: WaveformElementRange | null,
  b: WaveformElementRange | null
): boolean {
  return a?.first === b?.first && a?.last === b?.last;
}
