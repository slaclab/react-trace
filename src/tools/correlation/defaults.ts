// Correlation's creation paths, bound to this page load's site defaults
// (src/site): a fresh view (a query with no state beyond its PVs) opens with
// the site's lookback, Timer period, metrics and drawing rail, and switching
// the trigger back to Timer starts at the site's period. Read at call time.
//
// Correlation's link writer always states the lookback, the period (Timer),
// the row count and the view, so every link it writes reads at the baseline;
// only a query naming PVs alone (another tool's "Open in Correlation") is
// fresh.
import { siteDefaults } from '../../site/store';
import type { CorrelationDefaults } from '../../site/types';
import { namesOnlyPvs } from '../shared/freshQuery';
import { parseCorrelationQuery, type CorrelationState, type CorrelationTrigger } from './query';

/** The keys that only name PVs: X, the Ys and the trigger PV. */
export const CORRELATION_PV_KEYS: readonly string[] = ['x', 'y', 'trig'];

/** `state` with the site's creation defaults; a trigger PV is kept. */
export function withCorrelationCreation(
  state: CorrelationState,
  d: CorrelationDefaults
): CorrelationState {
  const out: CorrelationState = {
    ...state,
    lookback: d.lookback,
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
  return namesOnlyPvs(search, CORRELATION_PV_KEYS) ? withCorrelationCreation(state, d) : state;
}

/** The Timer trigger at the site's period. */
export function siteTimer(): CorrelationTrigger {
  return { mode: 'timer', dtS: siteDefaults().correlation.dt };
}
