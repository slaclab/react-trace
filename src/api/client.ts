import type { ErrorEnvelope } from './types';

// Vite dev server proxies /mole/* (and /formula-engine/*) to the Canopy backend (see
// vite.config.ts) and injects X-API-Key, so the browser bundle never sees the
// key. In deployed builds, VITE_CANOPY_BASE_PATH is served by Trace's reverse
// proxy, for example /trace/api/canopy.
const BASE = (import.meta.env.VITE_CANOPY_BASE_PATH ?? '').replace(/\/$/, '');

export function canopyWebSocketUrl(path: string): string {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${BASE}${path}`;
}

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
  // HTTP method; defaults to GET. POST is used for the Formula Engine's validate/evaluate;
  // PUT/DELETE by Magpie's config-store CRUD.
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  // JSON request body (POST/PUT). Serialized with a JSON content-type.
  body?: unknown;
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
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body,
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
