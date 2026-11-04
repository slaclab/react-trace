// The Waveform tool's state, reported back to the embedding host (the CANOPY
// workspace), through the context tools' publisher (../shared/publishQuery.ts).
//
// When the operator changes the state, the tool waits for the edits to
// settle, then writes the new query into its own URL (in place, page keys
// kept, so a tile reload reopens it) and posts
// `{type:'canopy:trace-query', query}` to the host. The opening state is
// never posted: the host already holds it.
//
// What is reported is exactly what `serializeWaveformQuery` writes, so a
// snapshot reference never leaves the page and Δ against a snapshot is
// not written: taking, dropping or restyling a snapshot changes no
// query and posts nothing.
//
// Only while embedded: a standalone page leaves its URL alone.
//
// Drawings: the query comes from `serializeWaveformQueryWithShed`, with
// the bytes of the page keys this page carries as the drawing steps' reserve,
// so a link carrying drawings still fits once those keys are prepended. What
// the link could not carry is published to the plot's shed store (when one is
// given) for the drawing status line.

import { useMemo } from 'react';
import type { Catalog } from '../../annotations/catalog/types';
import type { ShedStore } from '../../annotations/host/shedStore';
import { pageKeyReserve, usePublishedQuery } from '../shared/publishQuery';
import { serializeWaveformQueryWithShed, type WaveformState } from './query';

export interface WaveformStateOutOptions {
  /** The plot's drawing catalog; default WAVEFORM_CATALOG. */
  catalog?: Catalog;
  /** Where what the link could not carry is published. */
  shed?: ShedStore;
}

// Report the state to the host 500 ms after it last changed. The comparison
// is on the serialized query, so an edit that does not change it posts nothing.
export function useWaveformStateOut(
  state: WaveformState,
  opts: WaveformStateOutOptions = {}
): void {
  const { catalog, shed } = opts;
  // Serialized once per state object, so a shedding warning is not repeated per render.
  const out = useMemo(
    () => serializeWaveformQueryWithShed(state, { catalog, reserve: pageKeyReserve() }),
    [state, catalog]
  );
  usePublishedQuery(out.query, out.shed, shed);
}
