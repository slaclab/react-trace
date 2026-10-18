import { canopyFetch } from './client';
import type {
  ArchiverDataDTO,
  ArchiverListDTO,
  BinningMode,
  PVMetadataDTO,
  SearchResultsDTO,
} from './types';

export interface FetchDataParams {
  fromNs: number;
  toNs?: number;
  archiver?: string;
  binning?: BinningMode;
  maxPoints?: number;
  binSizeNs?: number;
  // Also return the last sample before `fromNs`. Raw requests only.
  includeLastBefore?: boolean;
}

export async function fetchData(
  pv: string,
  params: FetchDataParams,
  signal?: AbortSignal
): Promise<ArchiverDataDTO> {
  return canopyFetch<ArchiverDataDTO>(`/mole/v1/data/${encodeURIComponent(pv)}`, {
    query: {
      from: params.fromNs,
      to: params.toNs,
      archiver: params.archiver,
      binning: params.binning,
      maxPoints: params.maxPoints,
      binSize: params.binSizeNs,
      includeLastBefore: params.includeLastBefore,
    },
    signal,
  });
}

export async function fetchMetadata(
  pv: string,
  archiver?: string,
  signal?: AbortSignal
): Promise<PVMetadataDTO> {
  return canopyFetch<PVMetadataDTO>(`/mole/v1/metadata/${encodeURIComponent(pv)}`, {
    query: { archiver },
    signal,
  });
}

export async function searchPVs(
  pattern: string,
  options: { archiver?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<SearchResultsDTO> {
  return canopyFetch<SearchResultsDTO>('/mole/v1/search', {
    query: { pattern, archiver: options.archiver, limit: options.limit },
    signal,
  });
}

export async function listArchivers(signal?: AbortSignal): Promise<ArchiverListDTO> {
  return canopyFetch<ArchiverListDTO>('/mole/v1/archivers', { signal });
}
