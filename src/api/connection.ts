import type { CanopyConnection } from '@slaclab/canopy-client';

// How the browser reaches Canopy. Always a same-origin path: the Vite dev proxy
// (vite.config.ts) and Trace's reverse proxy in deployed builds forward it to
// Canopy and inject X-API-Key, so the bundle never holds the key.
//
// - '' (the local-dev default): per-module paths, /mole/..., /hare/..., /formula-engine/...
// - VITE_CANOPY_BASE_PATH, e.g. /trace/api/canopy: one prefix in front of them.
export function canopyBaseUrl(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/\/+$/, '');
}

// The connection every Canopy call goes through. React code reads it from
// <CanopyProvider> (main.tsx) with useCanopyConnection(); the module-level
// stores (archiveStore, liveStore) live outside React and import it directly.
export const canopyConnection: CanopyConnection = {
  baseUrl: canopyBaseUrl(import.meta.env.VITE_CANOPY_BASE_PATH as string | undefined),
};
