import { canopyWebSocketUrl } from './client';

// Same-origin WS URL. The Vite dev proxy (vite.config.ts) and any prod reverse
// proxy handle the /hare upgrade and inject X-API-Key, so the bundle never
// holds the key. SSR-safe: returns an empty string when `window` is undefined.
export function liveWsUrl(): string {
  return canopyWebSocketUrl('/hare/v1/ws/pvs');
}
