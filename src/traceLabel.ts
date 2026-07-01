import type { PVTrace } from './types';

type TraceNames = Pick<PVTrace, 'id' | 'displayName' | 'pvName'>;

// Stable numbering for unnamed traces. Once a trace ID is assigned a number it
// keeps it for the session, so deleting a sibling doesn't shift labels.
const assignedNumbers = new Map<string, number>();
let nextNumber = 1;

// Effective label for a trace: an explicit display name wins, then the PV
// name, then a numbered placeholder ("New Trace 1", "New Trace 2", ...).
// displayName stays empty until the user types one, so a trace's label follows
// its PV automatically until renamed.
export function traceLabel(trace: TraceNames, siblings?: readonly TraceNames[]): string {
  if (trace.displayName) return trace.displayName;
  if (trace.pvName) return trace.pvName;
  if (siblings) {
    if (!assignedNumbers.has(trace.id)) {
      assignedNumbers.set(trace.id, nextNumber++);
    }
    return `New Trace ${assignedNumbers.get(trace.id)}`;
  }
  return 'New Trace';
}
