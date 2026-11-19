import type { PVTrace } from './types';
import { parseOffsetMs, formatOffsetLabel } from './api/time';

type TraceNames = Pick<PVTrace, 'id' | 'displayName' | 'pvName' | 'timeOffset'>;

// Stable numbering for unnamed traces. Once a trace ID is assigned a number it
// keeps it for the session, so deleting a sibling doesn't shift labels.
const assignedNumbers = new Map<string, number>();
let nextNumber = 1;

// Effective label for a trace: an explicit display name wins, then the PV
// name, then a numbered placeholder ("New Trace 1", "New Trace 2", ...).
// displayName stays empty until the user types one, so a trace's label follows
// its PV automatically until renamed.
export function traceLabel(trace: TraceNames, siblings?: readonly TraceNames[]): string {
  let base: string;
  if (trace.displayName) base = trace.displayName;
  else if (trace.pvName) base = trace.pvName;
  else if (siblings) {
    if (!assignedNumbers.has(trace.id)) {
      assignedNumbers.set(trace.id, nextNumber++);
    }
    base = `New Trace ${assignedNumbers.get(trace.id)}`;
  } else {
    base = 'New Trace';
  }
  if (trace.timeOffset) {
    const ms = parseOffsetMs(trace.timeOffset);
    if (ms != null) return `${base} (${formatOffsetLabel(ms)})`;
  }
  return base;
}
