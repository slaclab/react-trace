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
