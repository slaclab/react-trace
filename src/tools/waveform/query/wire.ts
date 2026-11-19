// The Waveform link format; the grammar is documented in docs/waveform.md (Link format).
//
// What the parser and the serializer share: the byte count, the `plot` wire
// entry of a style (Trace's TraceConfig field names) and the `ann=` codec
// options.

import { VALUE_X_AXIS } from '../../../annotations/catalog/xAxis';
import type { ContextCodecOptions } from '../../../annotations/contextLink';
import { WAVEFORM_AXIS_ID, type WaveformState, type WaveformStyle } from './state';

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

// The wire entry of a style, in Trace's TraceConfig field names.
interface WireTrace {
  displayName?: string;
  color?: string;
  lineType?: string;
  lineWidth?: number;
  lineStyle?: string;
}

export function wireFromStyle(style: WaveformStyle | undefined, labels: boolean): WireTrace {
  const out: WireTrace = {};
  if (style === undefined) return out;
  if (labels && style.label !== undefined) out.displayName = style.label;
  if (style.color !== undefined) out.color = style.color;
  if (style.lineType !== undefined) out.lineType = style.lineType;
  if (style.width !== undefined) out.lineWidth = style.width;
  if (style.lineStyle !== undefined) out.lineStyle = style.lineStyle;
  return out;
}

// The `ann=` codec options of a state: one axis reference 'y', the magnet
// trace by its curve PV, the value x axis. A drawing placed against Δ while
// the reference is a snapshot is session data and is left out (counted).
export function codecOptions(state: WaveformState | null): ContextCodecOptions {
  const snapshot = state?.reference?.kind === 'snapshot';
  return {
    axisRef: () => WAVEFORM_AXIS_ID,
    axisId: (ref) => (ref === WAVEFORM_AXIS_ID ? WAVEFORM_AXIS_ID : null),
    xAxis: VALUE_X_AXIS,
    omit: (a) => snapshot && a.delta === true,
    warnPrefix: 'Waveform query',
  };
}
