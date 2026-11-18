// Loading the site defaults, once per page load, before the first render
// (docs/site-defaults.md). Two sources, fetched in parallel:
//
//   - `config.json` next to the app, resolved against the document's base URL
//     so it works under any base path. Missing or unreadable, the built-ins
//     apply. A server that answers a missing file with its SPA page (nginx's
//     `try_files`, the desktop app's fallback, Vite) counts as missing.
//   - Canopy's site settings (`getSiteSettings`), which win over the file
//     because an admin can change them at runtime. A 404 (unset) or any
//     failure counts as none.
//
// Each source gets at most SITE_FETCH_TIMEOUT_MS; an answer that comes later
// is ignored until the next load, so defaults never change under a user. A
// source that answers sooner holds the first render no longer than it takes.
import { getSiteSettings } from '../api/magpie';
import { resolveSiteDefaults } from './resolve';
import { setSiteDefaults } from './store';
import type { SiteConfig, SiteDefaults } from './types';
import { validateSiteConfig } from './validate';

/** The file, next to the app's pages. */
export const SITE_CONFIG_FILE = 'config.json';
/** The longest either source may hold the first render, in ms. */
export const SITE_FETCH_TIMEOUT_MS = 1500;

const FILE_SOURCE = 'config.json';
const CANOPY_SOURCE = 'Canopy site settings';

/** One source's fetch: its parsed JSON, or null for none. */
export type SiteFetch = (signal: AbortSignal) => Promise<unknown>;

/** `config.json` next to the app, parsed; null when it is missing or unreadable. */
export async function fetchSiteFile(signal: AbortSignal): Promise<unknown> {
  if (typeof document === 'undefined') return null;
  const url = new URL(SITE_CONFIG_FILE, document.baseURI);
  // Same origin only, as every request of the app (api/connection.ts).
  if (url.origin !== window.location.origin) return null;
  const res = await fetch(url.href, {
    signal,
    cache: 'no-cache',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const text = await res.text();
  // A server's SPA fallback page: no file there.
  if (/html/i.test(res.headers.get('content-type') ?? '') || text.trimStart().startsWith('<')) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    console.warn(`Site defaults from ${FILE_SOURCE}: not valid JSON; ignoring it.`);
    return null;
  }
}

// `fetcher`'s answer, or null when it fails or takes longer than `ms`; a
// late answer is dropped and the request aborted.
function bounded(fetcher: SiteFetch, ms: number): Promise<unknown> {
  const controller = new AbortController();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, ms);
    const settle = (value: unknown) => {
      clearTimeout(timer);
      resolve(value);
    };
    fetcher(controller.signal).then(settle, () => settle(null));
  });
}

export interface SiteLoadOptions {
  file?: SiteFetch;
  canopy?: SiteFetch;
  timeoutMs?: number;
}

/** This page load's site defaults; never rejects (no source: the built-ins). */
export async function loadSiteDefaults(options: SiteLoadOptions = {}): Promise<SiteDefaults> {
  const ms = options.timeoutMs ?? SITE_FETCH_TIMEOUT_MS;
  const [file, canopy] = await Promise.all([
    bounded(options.file ?? fetchSiteFile, ms),
    bounded(options.canopy ?? getSiteSettings, ms),
  ]);
  const sources: SiteConfig[] = [];
  if (file !== null && file !== undefined) sources.push(validateSiteConfig(file, FILE_SOURCE));
  if (canopy !== null && canopy !== undefined) {
    sources.push(validateSiteConfig(canopy, CANOPY_SOURCE));
  }
  return resolveSiteDefaults(sources);
}

/**
 * Starts a page: loads the site defaults, sets them, then calls `render`.
 * Every page entry (main.tsx, the tools' main.tsx) renders through it.
 */
export function startPage(render: () => void, options?: SiteLoadOptions): Promise<void> {
  return loadSiteDefaults(options).then(setSiteDefaults).then(render);
}
