// Transitional: trace's wire-type names, now backed by @slaclab/canopy-client.
// The Mole DTOs and the error envelope are the SDK's own types; the Hare and Fox
// sections below go as their modules move to the SDK. Removed once nothing
// imports it.

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

// ── Hare (live PV) DTOs ──────────────────────────────────────────────────────
// Source: canopy.contracts.pv.PVValue + canopy.hare.api.v1.ws frame schema.
// `tsNs` matches Mole's Sample.tsNs so live and archive share one time domain.

export type PVScalarValue = number | string | boolean | null;
export type PVValueType = PVScalarValue | PVScalarValue[];

export interface PVValueDTO {
  pv: string;
  value: PVValueType;
  severity: AlarmSeverity;
  tsNs: number;
  connected: boolean;
  units: string | null;
  precision: number | null;
  error: string | null;
}

export interface WsInitialFrame {
  type: 'initial';
  data: Record<string, PVValueDTO>;
  count: number;
}

export interface WsDiffFrame {
  type: 'diff';
  data: Record<string, PVValueDTO>;
  count: number;
  timestamp: number;
}

export interface WsHeartbeatFrame {
  type: 'heartbeat';
  timestamp: number;
  backend: string | null;
}

export interface WsPongFrame {
  type: 'pong';
  timestamp: number;
}

export interface WsErrorFrame {
  type: 'error';
  code: string;
  message: string;
}

export type WsFrame = WsInitialFrame | WsDiffFrame | WsHeartbeatFrame | WsPongFrame | WsErrorFrame;

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
