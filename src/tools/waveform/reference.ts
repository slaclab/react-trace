// What a live curve subtracts: one answer for the chart, the
// statistics frame, the CSV export and the model's Δ checks. A PV reference
// is one frame for every curve; a snapshot and a rolling reference hold one
// entry per curve. The spread (per-element σ) exists for a rolling reference
// and for a snapshot frozen from one.

import type { RollingFrame } from './frames';
import type { WaveformState } from './query';

/** The reference-side frames the controller publishes. */
export interface ReferenceFrames {
  /** The PV reference's latest frame. */
  reference: Float64Array | null;
  /** Per live PV, its rolling window's statistics (absent without a rolling reference). */
  rolling?: Readonly<Record<string, RollingFrame | undefined>>;
}

export interface CurveReference {
  values: Float64Array;
  /** Per-element σ, when the reference has one. */
  spread: Float64Array | null;
}

function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

/** The reference `pv` subtracts, or null when it has none yet. */
export function referenceFor(
  state: WaveformState,
  frames: ReferenceFrames,
  pv: string
): CurveReference | null {
  const ref = state.reference;
  if (ref === null) return null;
  if (ref.kind === 'pv') {
    return frames.reference === null ? null : { values: frames.reference, spread: null };
  }
  if (ref.kind === 'snapshot') {
    const values = own(ref.frames, pv);
    if (values === undefined) return null;
    return { values, spread: own(ref.spread, pv) ?? null };
  }
  const rolling = own(frames.rolling, pv);
  if (rolling === undefined) return null;
  return { values: rolling.mean, spread: rolling.std };
}

/** The label suffix of a per-curve reference entry: "(snapshot)" or "(rolling 60 s)". */
export function referenceSuffix(state: WaveformState): string {
  const ref = state.reference;
  if (ref?.kind === 'rolling') return `(rolling ${ref.seconds} s)`;
  if (ref?.kind === 'snapshot') {
    return ref.rolling === undefined ? '(snapshot)' : `(snapshot of rolling ${ref.rolling} s)`;
  }
  return '';
}
