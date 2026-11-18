// The archiver half of PV search: Mole's index through the SDK client,
// `GET /mole/v1/search` under the page's base (api/connection.ts),
// so it works behind a prefixed gateway path and with a per-trace archiver.
// Mole still contributes archived-only PVs that the channel catalog does not
// list.

import { searchPVs } from '@slaclab/canopy-client';
import { canopyConnection } from '../api/connection';

/**
 * The PV-name search behind every PV field (components/PvCombo.tsx): PV names
 * matching the user's text, best first; rejects on a failed search. One
 * signature, so a page can inject its own (tests do).
 */
export type PvSearch = (pattern: string, signal?: AbortSignal) => Promise<string[]>;

/** Mole's cap on one search; the catalog adds its own matches ahead of these. */
export const MOLE_SEARCH_LIMIT = 50;

/**
 * Mole's search is an anchored regex (the pattern must match the whole name),
 * so a plain fragment is wrapped as `.*x.*`; one that already has `.` or `*`
 * is the user's own pattern and passes as is.
 */
export function moleSearchPattern(text: string): string {
  const trimmed = text.trim();
  return trimmed.includes('.') || trimmed.includes('*') ? trimmed : `.*${trimmed}.*`;
}

/**
 * The regex for a search pattern the user typed as a glob (the Search PVs
 * dialog). The Archiver Appliance matches it against the whole PV name, so a
 * bare glob such as `SIM:BPM2*:X` would be read as "BPM" followed by any
 * number of 2s and match nothing. Follow the Python Trace search dialog
 * instead: `*` and `%` stand for any run of characters, `?` for one, and the
 * result is unanchored so a fragment matches anywhere in the name. Other regex
 * syntax passes through, and an explicit `.*`, `^` or `$` at either end is
 * left alone, so `SIM.*` and `^SIM` keep meaning what they say. The group
 * keeps an alternation such as `SIM|TEST` inside the wrap. With a top-level
 * alternation an end of the text belongs to one branch only, so `SIM|TEST*` is
 * wrapped on both sides: otherwise the SIM branch would have to end the name.
 */
export function toSearchRegex(text: string): string {
  // One pass, so a converted character is never read again: an escaped
  // character such as `\*` stays literal, `(?` keeps its group prefix, an
  // explicit `.*` stays as typed, and `?*` becomes `..*`.
  const body = text
    .trim()
    .replace(/\\.|\(\?|\.\*|[?*%]/g, (m) =>
      m[0] === '\\' || m === '(?' || m === '.*' ? m : m === '?' ? '.' : '.*'
    );
  const branches = hasTopLevelAlternation(body);
  const lead = !branches && (body.startsWith('^') || body.startsWith('.*')) ? '' : '.*';
  const tail = !branches && (body.endsWith('$') || body.endsWith('.*')) ? '' : '.*';
  return `${lead}(?:${body})${tail}`;
}

// A `|` outside every group and character class, and not escaped.
function hasTopLevelAlternation(regex: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < regex.length; i++) {
    const c = regex[i];
    if (c === '\\') i++;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) return true;
  }
  return false;
}

export interface MoleSearchOptions {
  /** The archiver whose index is searched; the default archiver when unset. */
  archiver?: string;
  /** Mole's cap on the names returned; MOLE_SEARCH_LIMIT by default. */
  limit?: number;
  /**
   * What the user typed, as the regex Mole is sent: `moleSearchPattern` (the
   * PV fields) by default, `toSearchRegex` for glob patterns.
   */
  toPattern?: (text: string) => string;
}

/** A search of `archiver`'s index (the default archiver when unset). */
export function moleSearch(options: MoleSearchOptions = {}): PvSearch {
  const { archiver, limit = MOLE_SEARCH_LIMIT, toPattern = moleSearchPattern } = options;
  return async (pattern, signal) => {
    const result = await searchPVs(
      canopyConnection,
      toPattern(pattern),
      { archiver, limit },
      signal
    );
    return result.pvs;
  };
}
