// Transitional: trace's wire-type names, now backed by @slaclab/canopy-client.
// The Mole DTOs and the error envelope are the SDK's own types. Vole, Magpie
// and Fox below stay here until their clients move to the SDK.

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

// ── Fox (formula) DTOs ───────────────────────────────────────────────────────
// Source: canopy.contracts.formula + canopy.fox.schemas.formula (camelCase wire).
// A formula curve evaluates an `expression` over named `bindings` (variable ->
// PV name) for a time window. Results are a discriminated union keyed on `kind`.

export type FormulaKind = 'scalar' | 'timeseries' | 'waveform';
export type FormulaDataMode = 'raw' | 'binned';
export type FormulaAlignMode = 'last' | 'interpolate';
export type FormulaIndexMode = 'union' | 'intersection' | 'grid' | 'first_input';

export interface FormulaSpecDTO {
  kind: FormulaKind;
  expression: string;
  // Variable name -> PV name (a referenced curve is resolved to its PV upstream).
  bindings: Record<string, string>;
  // mode/align/index carry server defaults (raw / last / union) when omitted.
  mode?: FormulaDataMode;
  align?: FormulaAlignMode;
  index?: FormulaIndexMode;
  gridDtNs?: number | null;
  maxPoints?: number | null;
}

export interface FormulaTimeseriesResultDTO {
  tsNs: number[];
  values: (number | null)[];
  severity: AlarmSeverity[];
  inputs: Record<string, string>;
  decimated: boolean;
}

export interface FormulaScalarResultDTO {
  tsNs: number;
  value: number | string | boolean;
  severity: AlarmSeverity;
  inputsUsed: Record<string, number>;
}

export interface FormulaWaveformResultDTO {
  tsNs: number;
  values: number[];
  severity: AlarmSeverity;
}

export interface FormulaResultDTO {
  kind: FormulaKind;
  scalar?: FormulaScalarResultDTO | null;
  timeseries?: FormulaTimeseriesResultDTO | null;
  waveform?: FormulaWaveformResultDTO | null;
}

export interface FormulaValidationDTO {
  valid: boolean;
  tokens: string[];
  errors: string[];
}
