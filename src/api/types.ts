// Transitional: trace's Mole wire-type names and severity alias, backed by
// @slaclab/canopy-client. Removed once nothing imports it.

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
