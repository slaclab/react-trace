// Transitional: trace's wire-type names, now backed by @slaclab/canopy-client.
// The Mole DTOs and the error envelope are the SDK's own types; the Fox section
// below goes when fox.ts moves to the SDK. Removed once nothing imports it.

import type { WireAlarmSeverity } from '@slaclab/canopy-client';

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
  SampleDTO,
  SearchResultsDTO,
} from '@slaclab/canopy-client';

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
