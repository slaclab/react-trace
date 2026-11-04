// Trace's state, reported back to the embedding host (the CANOPY workspace).
//
// When the operator changes the first plot's PVs, x-axis range or display
// configuration (axes, trace looks, plot options: plotConfig.ts), Trace waits
// for the edits to settle, then writes the new state into its own URL (in
// place, so a tile reload reopens it) and posts it to the host, which keeps it
// with the workspace tab. The state is the query grammar of query.ts; formula
// traces and plots after the first are not part of it.
//
// Only while embedded: standalone Trace leaves its URL alone.

import { useEffect, useRef } from 'react';
import { isEmbedded } from './embedded';
import { PAGE_KEYS } from './pageKeys';
import { plotConfigOf, type PlotConfig, type PlotConfigSource } from './plotConfig';
import { serializeTraceQuery, type TraceQueryXAxis } from './query';

export const STATE_OUT_DEBOUNCE_MS = 500;

// A plot as Trace holds it; fields the config reads may be absent (defaults).
export interface StateOutPlot extends PlotConfigSource {
  xAxis: TraceQueryXAxis;
}

export interface TraceQueryMessage {
  type: 'canopy:trace-query';
  query: string;
}

// What the host persists, as a cheap comparable key. Built from the same
// fields serializeTraceQuery reads, so a change here is a change there.
function stateKey(plot: StateOutPlot | undefined, config: PlotConfig | undefined): string {
  if (plot === undefined) return '';
  const pvs = plot.traces.filter((t) => t.kind !== 'formula').map((t) => t.pvName);
  const { timeRange, timeFrom, timeTo } = plot.xAxis;
  return JSON.stringify([pvs, timeRange, timeFrom ?? '', timeTo ?? '', config ?? null]);
}

function pageUrl(query: string): string {
  const current = new URLSearchParams(window.location.search);
  const kept = new URLSearchParams();
  for (const key of PAGE_KEYS) {
    for (const value of current.getAll(key)) kept.append(key, value);
  }
  const search = [kept.toString(), query].filter((s) => s !== '').join('&');
  return `${window.location.pathname}${search === '' ? '' : `?${search}`}${window.location.hash}`;
}

function publish(plot: StateOutPlot, config: PlotConfig | undefined): void {
  const query = serializeTraceQuery(plot.traces, plot.xAxis, config);
  window.history.replaceState(window.history.state, '', pageUrl(query));
  const message: TraceQueryMessage = { type: 'canopy:trace-query', query };
  window.parent.postMessage(message, window.location.origin);
}

// Report plot 0's PVs, range and config to the host, 500 ms after they last
// changed. The opening state is not reported: the host already holds it.
// The plot's own palette decides which trace colors the config leaves out
// (plotConfigOf).
export function useTraceStateOut(plots: readonly StateOutPlot[]): void {
  const first = plots[0];
  const config = first === undefined ? undefined : plotConfigOf(first);
  const key = stateKey(first, config);
  const published = useRef(key);
  const latest = useRef({ first, config });

  useEffect(() => {
    latest.current = { first, config };
  });

  useEffect(() => {
    if (!isEmbedded() || key === published.current) return;
    const timer = window.setTimeout(() => {
      const { first: plot, config: current } = latest.current;
      if (plot === undefined) return;
      published.current = key;
      publish(plot, current);
    }, STATE_OUT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [key]);
}
