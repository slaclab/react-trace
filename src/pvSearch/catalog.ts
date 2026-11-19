// The deployment's channel catalog: every channel the control system knows,
// served by the host at `GET <Canopy base>/channels` as a JSON string[] and ranked
// here in the browser (fuzzy.ts).
//
// The catalog is fetched once per page. The host answers with a strong ETag and
// `Cache-Control: no-cache`, so a reload costs a 304. A 404 (this deployment
// has no catalog), a network error or a malformed body all mean "no catalog":
// suggestions then come from Mole alone, silently.

import { useEffect, useMemo, useState } from 'react';
import { canopyConnection } from '../api/connection';
import { matchChannels } from './fuzzy';

let catalogPromise: Promise<string[]> | null = null;
let catalogValue: string[] | null = null;

async function fetchCatalog(): Promise<string[]> {
  try {
    if (typeof window === 'undefined' || typeof fetch !== 'function') return [];
    const response = await fetch(`${window.location.origin}${canopyConnection.baseUrl}/channels`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    return Array.isArray(body) ? body.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** The channel catalog, fetched once per page; [] when there is none. */
export function loadChannelCatalog(): Promise<string[]> {
  catalogPromise ??= fetchCatalog().then((list) => (catalogValue = list));
  return catalogPromise;
}

/** Forget the fetched catalog (tests). */
export function resetChannelCatalog(): void {
  catalogPromise = null;
  catalogValue = null;
}

/** The channel catalog; [] until loaded and when there is none. */
export function useChannelCatalog(): string[] {
  const [catalog, setCatalog] = useState<string[]>(() => catalogValue ?? []);
  useEffect(() => {
    let live = true;
    void loadChannelCatalog().then((list) => {
      // An empty catalog changes nothing: skip the re-render.
      if (live && list.length > 0) setCatalog(list);
    });
    return () => {
      live = false;
    };
  }, []);
  return catalog;
}

/** Catalog names matching `query` (at most RENDER_CAP), best first. */
export function channelMatches(query: string, catalog: readonly string[]): string[] {
  if (query.trim() === '' || catalog.length === 0) return [];
  return matchChannels(query, catalog).results.map((m) => m.value);
}

/** Debounce of the catalog matching while the user types. */
export const CHANNEL_DEBOUNCE_MS = 150;

/**
 * `channelMatches` of `query` against the catalog, debounced. The host's
 * catalog unless one is given (tests inject one).
 */
export function useChannelMatches(
  query: string,
  debounceMs = CHANNEL_DEBOUNCE_MS,
  catalog?: readonly string[]
): string[] {
  const hostCatalog = useChannelCatalog();
  catalog ??= hostCatalog;
  const [settled, setSettled] = useState(query);
  useEffect(() => {
    const handle = setTimeout(() => setSettled(query), debounceMs);
    return () => clearTimeout(handle);
  }, [query, debounceMs]);
  const cleared = query.trim() === '';
  return useMemo(
    () => (cleared ? [] : channelMatches(settled, catalog)),
    [cleared, settled, catalog]
  );
}

/** The lists concatenated in order, each name kept at its first occurrence. */
export function mergeSuggestions(...lists: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const pv of list) {
      if (pv && !seen.has(pv)) {
        seen.add(pv);
        out.push(pv);
      }
    }
  }
  return out;
}

/**
 * Trace's PV-name items: the committed PV first, then catalog
 * matches, then Mole hits, each name once.
 */
export function pvNameSuggestions(
  current: string,
  catalogHits: readonly string[],
  moleHits: readonly string[]
): string[] {
  return mergeSuggestions(current ? [current] : [], catalogHits, moleHits);
}
