// The context tools' state-out (Correlation, Waveform), as Trace's
// src/embed/stateOut.ts does for Trace: while embedded, a tool writes its
// serialized query into its own URL (in place, page keys kept, so a tile
// reload reopens it) and posts it to the host once the edits settle. The
// opening query is never posted: the host already holds it. A standalone page
// leaves its URL alone.

import { useEffect, useRef } from 'react';
import type { ShedSnapshot, ShedStore } from '../../annotations/host/shedStore';
import { isEmbedded } from '../../embed/embedded';
import { PAGE_KEYS } from '../../embed/pageKeys';
import { BENCH_KEY } from './renderMark';

export const STATE_OUT_DEBOUNCE_MS = 500;

// Query keys that configure the page and survive a state write.
const KEPT_KEYS = [...PAGE_KEYS, BENCH_KEY];

/**
 * The message a tool posts to its host. Every context tool posts
 * `canopy:trace-query`, Trace's message name, on purpose: the host listens
 * for that one type from any tool.
 */
export interface ToolQueryMessage {
  type: 'canopy:trace-query';
  query: string;
}

// The page keys of the current URL, as written in front of the query.
function pageKeys(): string {
  const current = new URLSearchParams(window.location.search);
  const kept = new URLSearchParams();
  for (const key of KEPT_KEYS) {
    for (const value of current.getAll(key)) kept.append(key, value);
  }
  return kept.toString();
}

/** The bytes the page keys add in front of a query (their text and the joining `&`). */
export function pageKeyReserve(): number {
  const keys = pageKeys();
  return keys === '' ? 0 : new TextEncoder().encode(keys).length + 1;
}

function pageUrl(query: string): string {
  const search = [pageKeys(), query].filter((s) => s !== '').join('&');
  return `${window.location.pathname}${search === '' ? '' : `?${search}`}${window.location.hash}`;
}

function publish(query: string): void {
  window.history.replaceState(window.history.state, '', pageUrl(query));
  const message: ToolQueryMessage = { type: 'canopy:trace-query', query };
  window.parent.postMessage(message, window.location.origin);
}

/**
 * Publish `shed` to `shedStore`, and, while embedded, write `query` into the
 * page URL and post it to the host 500 ms after it last changed. The
 * comparison is on the serialized query, so an edit that does not change it
 * posts nothing.
 */
export function usePublishedQuery(
  query: string,
  shed: ShedSnapshot,
  shedStore: ShedStore | undefined
): void {
  const published = useRef(query);

  useEffect(() => {
    shedStore?.publish(shed);
  }, [shedStore, shed]);

  useEffect(() => {
    if (!isEmbedded() || query === published.current) return;
    const timer = window.setTimeout(() => {
      published.current = query;
      publish(query);
    }, STATE_OUT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
}
