// Wire types mirroring Canopy/Mole DTOs (camelCase, as emitted by canopy.contracts.base.CanopyModel).
// Source of truth: the Canopy repo's src/canopy/mole/schemas + Canopy.wiki Module-Architecture:-Mole.md.

export type AlarmSeverity = 'NO_ALARM' | 'MINOR' | 'MAJOR' | 'INVALID';
export type BinningMode = 'auto' | 'time';

export interface SampleDTO {
  tsNs: number;
  value: number | string | boolean | null;
  severity: AlarmSeverity;
  source: 'archive';
}

export interface ArchiverSeriesDTO {
  mode: 'raw';
  pv: string;
  archiver: string;
  from: number;
  to: number;
  decimated: boolean;
  samples: SampleDTO[];
}

export interface BinnedPointDTO {
  tsNs: number;
  binNs: number;
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  count: number;
  severity: AlarmSeverity;
}

export interface ArchiverBinnedSeriesDTO {
  mode: 'binned';
  pv: string;
  archiver: string;
  from: number;
  to: number;
  binning: BinningMode;
  binSizeNs: number | null;
  targetBuckets: number | null;
  points: BinnedPointDTO[];
}

export type ArchiverDataDTO = ArchiverSeriesDTO | ArchiverBinnedSeriesDTO;

export interface PVMetadataDTO {
  pv: string;
  archiver: string;
  description: string | null;
  units: string | null;
  precision: number | null;
  displayLow: number | null;
  displayHigh: number | null;
  alarmLow: number | null;
  alarmHigh: number | null;
  warningLow: number | null;
  warningHigh: number | null;
}

export interface ArchiverInfoDTO {
  name: string;
  typeName: string;
  url: string;
  healthy: boolean;
  latencyMs: number | null;
  lastError: string | null;
}

export interface ArchiverListDTO {
  default: string;
  archivers: ArchiverInfoDTO[];
}

export interface SearchResultsDTO {
  archiver: string;
  pattern: string;
  pvs: string[];
}

export interface ErrorEnvelope {
  code: string;
  detail: string;
}

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
