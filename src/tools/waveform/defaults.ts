// Waveform's creation paths, bound to this page load's site defaults
// (src/site): a fresh view (a query with no state beyond its PVs) opens with
// the site's metrics and drawing rail, and turning the Rolling mean on starts
// at the site's window. Read at call time.
//
// Waveform's link writer leaves every key at its baseline out, so a view at
// the baseline writes its PVs alone, and a link of PVs alone opens as a new
// view, with the defaults of the site that opens it. While this site's new
// views differ from the baseline, such a link carries `rail=1` (the drawing
// rail on, its baseline), so it reopens at the baseline, as it is.
import { siteDefaults } from '../../site/store';
import type { WaveformDefaults } from '../../site/types';
import { namesOnlyPvs } from '../shared/freshQuery';
import {
  defaultWaveformState,
  parseWaveformQuery,
  serializeWaveformQuery,
  type WaveformState,
} from './query';

/** The keys that only name PVs: the Live PVs, the Reference PV and the X source. */
export const WAVEFORM_PV_KEYS: readonly string[] = ['pv', 'ref', 'xs'];

/** `state` with the site's creation defaults. */
export function withWaveformCreation(state: WaveformState, d: WaveformDefaults): WaveformState {
  const out: WaveformState = { ...state, metrics: d.metrics.map((m) => ({ ...m })) };
  if (d.drawingTools) delete out.drawingTools;
  else out.drawingTools = false;
  return out;
}

/** The state a page with query `search` opens with (a fresh one: the site defaults). */
export function initialWaveformState(
  search: string,
  d: WaveformDefaults = siteDefaults().waveform
): WaveformState {
  const state = parseWaveformQuery(search);
  return namesOnlyPvs(search, WAVEFORM_PV_KEYS) ? withWaveformCreation(state, d) : state;
}

/** The Rolling mean window a user turns on, in seconds. */
export function siteRollS(): number {
  return siteDefaults().waveform.rollS;
}

// Whether a query of PVs alone opens here exactly as the baseline does;
// memoized per defaults record (one per page load).
const freshIsBaseline = new WeakMap<WaveformDefaults, boolean>();

function freshQueryIsBaseline(d: WaveformDefaults): boolean {
  const known = freshIsBaseline.get(d);
  if (known !== undefined) return known;
  const baseline = serializeWaveformQuery(withWaveformCreation(defaultWaveformState(), d)) === '';
  freshIsBaseline.set(d, baseline);
  return baseline;
}

/**
 * `query` (a serialized state) as a link writes it: with `rail=1` added when
 * it names PVs alone but a query of PVs alone would open with this site's
 * defaults instead of the baseline.
 */
export function waveformLinkQuery(
  query: string,
  d: WaveformDefaults = siteDefaults().waveform
): string {
  if (!namesOnlyPvs(query, WAVEFORM_PV_KEYS) || freshQueryIsBaseline(d)) return query;
  return query === '' ? 'rail=1' : `${query}&rail=1`;
}
