import { canopyFetch, type FetchOptions } from './client';
import type { VoleSeriesDTO } from './types';

const BACKFILL_MAX_POINTS = 10_000;

export interface BackfillOptions {
  to?: number;
  maxPoints?: number;
  signal?: AbortSignal;
}

export function fetchBackfill(
  pv: string,
  fromNs: number,
  opts: BackfillOptions = {}
): Promise<VoleSeriesDTO> {
  const query: FetchOptions['query'] = {
    from: String(fromNs),
    align: 'last',
    maxPoints: opts.maxPoints ?? BACKFILL_MAX_POINTS,
  };
  if (opts.to != null) query.to = String(opts.to);

  return canopyFetch<VoleSeriesDTO>(`/vole/v1/pvs/${encodeURIComponent(pv)}`, {
    query,
    signal: opts.signal,
  });
}

export interface VoleSubscribeResponse {
  subscribed: string[];
}

export function subscribeVoleBuffer(
  pvs: string[],
  opts: { signal?: AbortSignal } = {}
): Promise<VoleSubscribeResponse> {
  return canopyFetch<VoleSubscribeResponse>('/vole/v1/pvs/subscribe', {
    method: 'POST',
    body: { pvs },
    signal: opts.signal,
  });
}
