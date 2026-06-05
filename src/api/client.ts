import type { ErrorEnvelope } from './types';

// Vite dev server proxies /mole/* to the Canopy backend (see vite.config.ts) and injects X-API-Key,
// so the browser bundle never sees the key. In a non-dev build the same path can be served by a
// reverse proxy with the same header-injection responsibility.
const BASE = '';

export class CanopyError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string;

  constructor(code: string, status: number, detail: string) {
    super(`${code} (${status}): ${detail}`);
    this.name = 'CanopyError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export interface FetchOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
}

function buildQuery(query: FetchOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export async function canopyFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const url = `${BASE}${path}${buildQuery(options.query)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options.signal,
    });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw err;
    throw new CanopyError('network_error', 0, (err as Error).message ?? 'network failure');
  }

  if (!res.ok) {
    let envelope: ErrorEnvelope | null = null;
    try {
      envelope = (await res.json()) as ErrorEnvelope;
    } catch {
      // fall through with no envelope
    }
    const code = envelope?.code ?? 'unknown_error';
    const detail = envelope?.detail ?? res.statusText;
    throw new CanopyError(code, res.status, detail);
  }

  return (await res.json()) as T;
}
