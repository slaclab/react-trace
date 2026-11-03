import type { CanopyConnection, FetchLike } from '@slaclab/canopy-client';

// How the browser reaches Canopy. Always a same-origin path: the Vite dev proxy
// (vite.config.ts) and Trace's reverse proxy in deployed builds forward it to
// Canopy and inject X-API-Key, so the bundle never holds the key.
//
// - VITE_CANOPY_BASE_PATH, e.g. /trace/api/canopy: one prefix in front of the
//   per-module paths.
// - Unset: the parent directory of the page. Trace served one directory below a
//   gateway root (e.g. /x/y/trace/) reaches the modules as its siblings
//   (/x/y/mole, /x/y/hare, /x/y/formula-engine); at the site root the prefix is
//   empty, the per-module paths /mole/..., /hare/..., /formula-engine/... the
//   dev proxy owns.
export function canopyBaseUrl(raw: string | undefined, documentBase?: string): string {
  const configured = (raw ?? '').trim().replace(/\/+$/, '');
  if (configured || documentBase === undefined) return configured;
  // Collapse leading slashes: a page at `//evil.example/x/` has that pathname,
  // and as a prefix it would make every request protocol-relative, off-origin.
  const parent = new URL('../', documentBase).pathname.replace(/^\/+/, '/');
  return parent.replace(/\/+$/, '');
}

// Every request stays on this origin: the proxy behind it injects the key.
// A URL that resolves elsewhere (a VITE_CANOPY_BASE_PATH naming another host,
// or a <base href> on another origin) is refused before it is sent.
export const sameOriginFetch: FetchLike = (url, init) => {
  if (
    typeof document !== 'undefined' &&
    new URL(url, document.baseURI).origin !== window.location.origin
  ) {
    return Promise.reject(new Error(`Refused a request outside this origin: ${url}`));
  }
  return globalThis.fetch(url, init as RequestInit);
};

// The connection every Canopy call goes through. React code reads it from
// <CanopyProvider> (main.tsx) with useCanopyConnection(); the module-level
// stores (archiveStore, liveStore) live outside React and import it directly.
// The base is read at each request, against the document as it is then.
export const canopyConnection: CanopyConnection = {
  get baseUrl() {
    return canopyBaseUrl(
      import.meta.env.VITE_CANOPY_BASE_PATH as string | undefined,
      typeof document === 'undefined' ? undefined : document.baseURI
    );
  },
  fetch: sameOriginFetch,
};
