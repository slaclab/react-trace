import { canopyFetch } from './client';
import type { PVValueDTO } from './types';

export async function getPv(pv: string, signal?: AbortSignal): Promise<PVValueDTO> {
  return canopyFetch<PVValueDTO>(`/hare/v1/pvs/${encodeURIComponent(pv)}`, { signal });
}

// Same-origin WS URL. The Vite dev proxy (vite.config.ts) and any prod reverse
// proxy handle the /hare upgrade and inject X-API-Key, so the bundle never
// holds the key. SSR-safe: returns an empty string when `window` is undefined.
export function liveWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/hare/v1/ws/pvs`;
}
