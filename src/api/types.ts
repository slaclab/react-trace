// Transitional: trace's wire-type names, now backed by @slaclab/canopy-client.
// The Mole DTOs and the error envelope are the SDK's own types. Vole, Magpie and
// E-log below stay here until their clients move to the SDK.

import type { SampleDTO as MoleSampleDTO, WireAlarmSeverity } from '@slaclab/canopy-client';

export type AlarmSeverity = WireAlarmSeverity;

export type {
  ArchiverBinnedSeriesDTO,
  ArchiverDataDTO,
  ArchiverInfoDTO,
  ArchiverListDTO,
  ArchiverSeriesDTO,
  BinnedPointDTO,
  BinningMode,
  ErrorEnvelope,
  PVMetadataDTO,
  SearchResultsDTO,
} from '@slaclab/canopy-client';

// One stored sample: Mole's (source 'archive') or Vole's live buffer
// (source 'live'). The SDK's SampleDTO only knows Mole's.
export interface SampleDTO extends Omit<MoleSampleDTO, 'source'> {
  source: 'archive' | 'live';
}

export interface VoleSeriesDTO {
  pv: string;
  count: number;
  samples: SampleDTO[];
}

// ── Magpie (config store) DTOs ───────────────────────────────────────────────
// Source: canopy.magpie.schemas.config (camelCase wire). A Config stores an
// opaque JSON `data` blob for a consuming app (here, "trace") — magpie does not
// define its shape; the workspace shape is trace's concern (see io/serialize.ts).

export interface ConfigDTO {
  id: string;
  app: string;
  slug: string;
  name: string | null;
  description: string | null;
  // Opaque to the wire layer: a TraceWorkspace object, parsed by io/serialize's
  // deserializeConfigData on load (deserializeWorkspace is the string-file door).
  data: unknown;
  createdBy: string | null;
  createdDate: string; // ISO 8601
  lastModifiedDate: string; // ISO 8601
}

// Canopy's standard list envelope (canopy.contracts.pagination.PagedResult).
export interface PagedResult<T> {
  results: T[];
  continuationToken: string | null;
  totalCount: number | null;
}

// ── E-Log DTOs ───────────────────────────────────────────────────────────────
// Source: canopy.elog (camelCase wire), mounted at /elog. Each client app has its
// own elog-plus application token server-side; Trace's app path is
// /elog/v1/apps/trace. Logbooks and tags are referenced by id.

export interface ElogConfigDTO {
  enabled: boolean;
  provider: string | null;
  defaultLogbookIds: string[];
  // Why posting is disabled (no provider configured, or no token for this app).
  reason: string | null;
}

export interface ElogLogbookDTO {
  id: string;
  name: string;
}

export interface ElogAttachmentDTO {
  id: string;
}

export interface ElogNewEntryDTO {
  logbookIds: string[];
  title: string;
  // Canopy renders Markdown to HTML before handing the entry to elog-plus.
  bodyMarkdown: string;
  tagIds?: string[];
  attachmentIds?: string[];
  additionalAuthors?: string[];
  important?: boolean;
  eventAt?: string | null;
  followsUpEntryId?: string | null;
}

export interface ElogEntryCreatedDTO {
  id: string;
  url: string | null;
}
