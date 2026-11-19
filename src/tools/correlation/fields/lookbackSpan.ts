// The Lookback field's commit rule, apart from its renderer so
// the component module exports components only. Bounds as the query parser's
// (`src/correlation/query.ts`): a span in Trace's syntax within [1m, 24h].

import { parseSpanMs } from '../../../api/time';

const MIN_LOOKBACK_MS = 60 * 1000;
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MIN_LOOKBACK = '1m';
const MAX_LOOKBACK = '24h';

export const LOOKBACK_ERROR = 'Use a number plus m, h or d between 1m and 24h (e.g. 30m, 1.5h).';

/**
 * The lookback a typed text commits to: whitespace removed and clamped to
 * [1m, 24h]; null when the text is not a span.
 */
export function commitLookback(text: string): string | null {
  const span = text.replace(/\s+/g, '');
  if (span === '') return null;
  const ms = parseSpanMs(span);
  if (ms === null || ms <= 0) return null;
  if (ms < MIN_LOOKBACK_MS) return MIN_LOOKBACK;
  if (ms > MAX_LOOKBACK_MS) return MAX_LOOKBACK;
  return span;
}
