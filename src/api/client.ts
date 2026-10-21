import type { ErrorEnvelope } from './types';

// Vite dev server proxies /mole/* (and /hare, /fox, /elog) to the Canopy
// backend (see vite.config.ts) and injects X-API-Key, so the browser bundle
// never sees the key. In deployed builds, VITE_CANOPY_BASE_PATH is served by
// Trace's reverse proxy, for example /trace/api/canopy.
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
  // HTTP method; defaults to GET. POST is used for Fox's validate/evaluate.
  method?: 'GET' | 'POST';
  // Request body (POST only). FormData is sent as multipart as-is (the browser
  // sets the boundary); anything else is serialized with a JSON content-type.
  body?: unknown;
}

// Canopy errors carry a string `detail`. FastAPI's default 422 body carries a
// list of {loc, msg, type} instead, so join its messages.
function readDetail(detail: unknown): string | null {
  if (typeof detail === 'string') return detail;
  if (!Array.isArray(detail)) return null;
  const msgs = detail
    .map((d) => (d as { msg?: unknown } | null)?.msg)
    .filter((m): m is string => typeof m === 'string');
  return msgs.length > 0 ? msgs.join('; ') : null;
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
  let body: string | FormData | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
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
    const detail = readDetail(envelope?.detail) ?? res.statusText;
    throw new CanopyError(code, res.status, detail);
  }

  return (await res.json()) as T;
}
