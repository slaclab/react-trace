// Ranking of PV names typed into a PV field against the channel catalog.
//
// A query is split on whitespace and every token must match the candidate as a
// case-insensitive subsequence. Each matched character scores BASE, plus
// BOUNDARY_BONUS when it starts the name or follows a word boundary (`.`, `_`,
// `-` or a lowercase-to-uppercase step) and CONSECUTIVE_BONUS when it directly
// follows the previous match, so "bpm1" ranks `SIM:BPM1:X` above a name that
// merely contains those letters spread out. The matched character ranges come
// back as spans for highlighting.

export interface FuzzyResult {
  score: number;
  spans: Array<[number, number]>;
}

const BASE = 1; // every matched character is worth at least this
const BOUNDARY_BONUS = 10; // match at index 0 or right after a word boundary
const CONSECUTIVE_BONUS = 5; // match immediately following the previous match

/** True at index 0, after `.`/`_`/`-`, or on a lowercase→uppercase step. */
function isBoundary(candidate: string, idx: number): boolean {
  if (idx === 0) return true;
  const prev = candidate.charAt(idx - 1);
  if (prev === '.' || prev === '_' || prev === '-') return true;
  const cur = candidate.charAt(idx);
  return /[a-z]/.test(prev) && /[A-Z]/.test(cur);
}

/** Greedy in-order placement of a lowercased token, or null. */
function matchToken(token: string, lower: string): number[] | null {
  const indices: number[] = [];
  let from = 0;
  for (const ch of token) {
    const found = lower.indexOf(ch, from);
    if (found === -1) return null;
    indices.push(found);
    from = found + 1;
  }
  return indices;
}

function scoreIndices(indices: number[], candidate: string): number {
  let score = 0;
  for (let p = 0; p < indices.length; p++) {
    const idx = indices[p];
    score += BASE;
    if (isBoundary(candidate, idx)) score += BOUNDARY_BONUS;
    if (p > 0 && idx === indices[p - 1] + 1) score += CONSECUTIVE_BONUS;
  }
  return score;
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/**
 * Whitespace-tokenized, all-tokens-AND subsequence match. Null when any token
 * fails; an empty query matches with score 0.
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyResult | null {
  const tokens = query.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return { score: 0, spans: [] };

  const lower = candidate.toLowerCase();
  const ranges: Array<[number, number]> = [];
  let score = 0;
  for (const token of tokens) {
    const indices = matchToken(token.toLowerCase(), lower);
    if (indices === null) return null;
    score += scoreIndices(indices, candidate);
    for (const idx of indices) ranges.push([idx, idx + 1]);
  }
  return { score, spans: mergeRanges(ranges) };
}

/** Substring hits needed before they alone form the pool. */
export const MIN_POOL = 8;
/** Most entries returned in `results`; `total` is never capped. */
export const RENDER_CAP = 50;

export interface ChannelMatch {
  value: string;
  spans: Array<[number, number]>;
}

export interface ChannelMatchResult {
  results: ChannelMatch[];
  total: number;
}

/**
 * Rank `catalog` against `query`. Case-insensitive substring hits are the pool
 * when there are at least MIN_POOL of them, else every fuzzy match in the
 * catalog is; both rank by fuzzy score, then by value. An empty query returns
 * the first RENDER_CAP entries in catalog order.
 */
export function matchChannels(query: string, catalog: readonly string[]): ChannelMatchResult {
  const trimmed = query.trim();
  if (trimmed === '') {
    return {
      results: catalog.slice(0, RENDER_CAP).map((value) => ({ value, spans: [] })),
      total: catalog.length,
    };
  }

  const lowerQuery = trimmed.toLowerCase();
  const substringHits: string[] = [];
  for (const value of catalog) {
    if (value.toLowerCase().includes(lowerQuery)) substringHits.push(value);
  }

  const candidates = substringHits.length >= MIN_POOL ? substringHits : catalog;
  const pool: Array<{ value: string; score: number; spans: Array<[number, number]> }> = [];
  for (const value of candidates) {
    const hit = fuzzyMatch(query, value);
    if (hit !== null) pool.push({ value, score: hit.score, spans: hit.spans });
  }

  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  });
  return {
    results: pool.slice(0, RENDER_CAP).map(({ value, spans }) => ({ value, spans })),
    total: pool.length,
  };
}
