// Transitional shim over @slaclab/canopy-client: keeps trace's original
// signatures while call sites move to the SDK (which takes the connection as
// its first argument). Removed once nothing imports it.
import {
  canopyFetch as sdkCanopyFetch,
  toWsUrl,
  type CanopyFetchOptions,
} from '@slaclab/canopy-client';
import { canopyConnection } from './connection';

export { CanopyError } from '@slaclab/canopy-client';

export type FetchOptions = CanopyFetchOptions;

export function canopyFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  return sdkCanopyFetch<T>(canopyConnection, path, options);
}

// SSR-safe: returns an empty string when `window` is undefined.
export function canopyWebSocketUrl(path: string): string {
  if (typeof window === 'undefined') return '';
  return toWsUrl(canopyConnection.baseUrl, path);
}
