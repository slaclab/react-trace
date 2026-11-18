// Correlation's creation paths, bound to this page load's site defaults
// (src/site): a fresh view opens with the site's lookback, Timer period,
// metrics and drawing rail, and switching the trigger back to Timer starts at
// the site's period. Read at call time.
//
// A fresh view's query carries no state beyond its PVs and, as a Trace link
// may carry a range, a lookback, which then wins over the site's: what
// another tool's "Open in Correlation" writes (tools/contextMenu.ts).
// Correlation's own link writer always states the period, the row count and
// the view too, so every link it writes reads at the baseline.
import { siteDefaults } from '../../site/store';
import type { CorrelationDefaults } from '../../site/types';
import { carriesOnly } from '../shared/freshQuery';
import { parseCorrelationQuery, type CorrelationState, type CorrelationTrigger } from './query';

/** The keys a fresh query carries: X, the Ys, the trigger PV, and a lookback. */
export const CORRELATION_FRESH_KEYS: readonly string[] = ['x', 'y', 'trig', 'lookback'];

/** `state` with the site's creation defaults; a trigger PV is kept, and a lookback unless `lookback`. */
export function withCorrelationCreation(
  state: CorrelationState,
  d: CorrelationDefaults,
  opts: { lookback: boolean } = { lookback: true }
): CorrelationState {
  const out: CorrelationState = {
    ...state,
    lookback: opts.lookback ? d.lookback : state.lookback,
    trigger: state.trigger.mode === 'timer' ? { mode: 'timer', dtS: d.dt } : state.trigger,
    metrics: d.metrics.map((m) => ({ ...m })),
  };
  if (d.drawingTools) delete out.drawingTools;
  else out.drawingTools = false;
  return out;
}

/** The state a page with query `search` opens with (a fresh one: the site defaults). */
export function initialCorrelationState(
  search: string,
  d: CorrelationDefaults = siteDefaults().correlation
): CorrelationState {
  const state = parseCorrelationQuery(search);
  if (!carriesOnly(search, CORRELATION_FRESH_KEYS)) return state;
  const lookback = !new URLSearchParams(search.replace(/^\?/, '')).has('lookback');
  return withCorrelationCreation(state, d, { lookback });
}

/** The Timer trigger at the site's period. */
export function siteTimer(): CorrelationTrigger {
  return { mode: 'timer', dtS: siteDefaults().correlation.dt };
}
