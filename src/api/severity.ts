import { AlarmSeverity, type WireAlarmSeverity } from '@slaclab/canopy-client';

// Trace keeps alarm severity as the wire string (`WireAlarmSeverity`): Mole
// samples, Formula Engine results, the Data Insight table and the CSV/MAT
// exports all carry it. The SDK's PV services report the numeric `AlarmSeverity` instead, which
// adds DISCONNECTED; that is a connection state, not an alarm, so it maps to null.
const WIRE_SEVERITY: Record<AlarmSeverity, WireAlarmSeverity | null> = {
  [AlarmSeverity.NO_ALARM]: 'NO_ALARM',
  [AlarmSeverity.MINOR]: 'MINOR',
  [AlarmSeverity.MAJOR]: 'MAJOR',
  [AlarmSeverity.INVALID]: 'INVALID',
  [AlarmSeverity.DISCONNECTED]: null,
};

export function toWireSeverity(severity: AlarmSeverity): WireAlarmSeverity | null {
  return WIRE_SEVERITY[severity] ?? null;
}
