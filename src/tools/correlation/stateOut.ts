// The correlation plot's state, reported back to the embedding host (the
// CANOPY workspace) through the context tools' publisher
// (../shared/publishQuery.ts).
//
// When the operator changes a role (X, Y, density Y), the trigger, N, the
// lookback, the view, the Y layout or the statistics metrics (the metric list
// is part of the query), the plot waits for the edits to settle, then writes
// the new query into its own URL and posts `{type:'canopy:trace-query',
// query}` to the host.
//
// The drawings: the query is serialized with its shed counts, and the counts
// go to the plot's `ShedStore` (embedded or not) for the drawing status line.
// The drawing steps leave room for the page keys the publisher puts in front
// of the query, so the written URL reloads with the drawings the counts
// report.

import { useMemo } from 'react';
import type { Catalog } from '../../annotations/catalog/types';
import type { ShedStore } from '../../annotations/host/shedStore';
import { pageKeyReserve, usePublishedQuery } from '../shared/publishQuery';
import { serializeCorrelationQueryWithShed, type CorrelationState } from './query';

export interface CorrelationStateOutOptions {
  /** Receives the drawings' shed counts of every serialization. */
  shed?: ShedStore;
  /** The catalog the drawings are written against; default `CORRELATION_CATALOG`. */
  catalog?: Catalog;
}

// Report the state to the host 500 ms after it last changed.
export function useCorrelationStateOut(
  state: CorrelationState,
  opts: CorrelationStateOutOptions = {}
): void {
  const { shed: shedStore, catalog } = opts;
  // Serialized once per state object, so a warning is not repeated per render.
  const { query, shed } = useMemo(
    () => serializeCorrelationQueryWithShed(state, { catalog, reserve: pageKeyReserve() }),
    [state, catalog]
  );
  usePublishedQuery(query, shed, shedStore);
}
