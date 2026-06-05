// Same-origin WS URL. The Vite dev proxy (vite.config.ts) and any prod reverse
// proxy handle the /hare upgrade and inject X-API-Key, so the bundle never
// holds the key. SSR-safe: returns an empty string when `window` is undefined.
export function liveWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/hare/v1/ws/pvs`;
}
