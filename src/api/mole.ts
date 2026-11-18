// Transitional shim over @slaclab/canopy-client's Mole client, bound to the
// shared connection so trace's original signatures keep working while call
// sites move to the SDK. Removed once nothing imports it.
import * as sdk from '@slaclab/canopy-client';
import type {
  ArchiverDataDTO,
  ArchiverListDTO,
  FetchDataParams,
  PVMetadataDTO,
  SearchResultsDTO,
} from '@slaclab/canopy-client';
import { canopyConnection } from './connection';

export type { FetchDataParams } from '@slaclab/canopy-client';

export function fetchData(
  pv: string,
  params: FetchDataParams,
  signal?: AbortSignal
): Promise<ArchiverDataDTO> {
  return sdk.fetchData(canopyConnection, pv, params, signal);
}

export function fetchMetadata(
  pv: string,
  archiver?: string,
  signal?: AbortSignal
): Promise<PVMetadataDTO> {
  return sdk.fetchMetadata(canopyConnection, pv, archiver, signal);
}

export function searchPVs(
  pattern: string,
  options: { archiver?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<SearchResultsDTO> {
  return sdk.searchPVs(canopyConnection, pattern, options, signal);
}

export function listArchivers(signal?: AbortSignal): Promise<ArchiverListDTO> {
  return sdk.listArchivers(canopyConnection, signal);
}
