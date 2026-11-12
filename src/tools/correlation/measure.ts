// Correlation's measure provider: the rows of a measure
// drawing's card over the frame on screen. The rows cover only the measured
// box: Δx and Δy of the two corners, the slope Δy/Δx of the drawn diagonal,
// and the number of the owning Y's points inside the box with their mean and
// sample σ of y. The owning Y is the drawing's `axisId` (a Y PV).
//
// The frame reaches the provider only through a getter: the host
// config is never keyed on the frame, and the card re-reads on each `frames`
// bump. Pure apart from that getter.

import type { DrawingTextContext, MeasureProvider } from '../../annotations/catalog/types';
import { axisUnit, READOUT_DASH, term, terms } from '../../annotations/catalog/format';
import type { Annotation } from '../../annotations/model';
import { columnStats, yColumns, type FrameLike } from './stats';

/** What the card reads about the points inside the measured box. */
export interface CorrelationMeasureReadout {
  dx: number;
  dy: number;
  /** Δy / Δx of the drawn diagonal; null when Δx is 0 or not finite. */
  slope: number | null;
  /** The owning Y's points inside the box; null when that Y is not in the frame. */
  n: number | null;
  mean: number | null;
  std: number | null;
}

/** The [lo, hi] of two numbers. */
function span(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}

function finite(v: number | null | undefined): number | null {
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

/** The readout of measure drawing `a` over `frame`. Pure. */
export function correlationMeasureReadout(
  a: Annotation,
  frame: FrameLike | null
): CorrelationMeasureReadout {
  const p0 = a.points[0];
  const p1 = a.points[1] ?? p0;
  const dx = (p1?.t ?? Number.NaN) - (p0?.t ?? Number.NaN);
  const dy = (p1?.v ?? Number.NaN) - (p0?.v ?? Number.NaN);
  const slope = Number.isFinite(dx) && Number.isFinite(dy) && dx !== 0 ? dy / dx : null;
  const base = { dx, dy, slope };

  const column =
    frame === null
      ? undefined
      : yColumns(frame.columnPvs).find((c) => frame.columnPvs[c] === a.axisId);
  if (frame === null || column === undefined || p0 === undefined || p1 === undefined) {
    return { ...base, n: null, mean: null, std: null };
  }
  const [xlo, xhi] = span(p0.t, p1.t);
  const [ylo, yhi] = span(p0.v, p1.v);
  const xCells = frame.table.columns.x ?? [];
  const yCells = frame.table.columns[column] ?? [];
  const inside: number[] = [];
  const len = Math.min(xCells.length, yCells.length);
  for (let i = 0; i < len; i++) {
    const x = xCells[i];
    const y = yCells[i];
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < xlo || x > xhi || y < ylo || y > yhi) continue;
    inside.push(y);
  }
  const stats = columnStats(inside);
  return { ...base, n: stats.n, mean: stats.mean, std: stats.std };
}

/**
 * The readout's lines, as a figure prints them: `Δx = …  Δy = …  Δy/Δx = …`,
 * then `n = …  ȳ = …  σ = …`; `unit` (the owning Y's unit text) follows Δy,
 * the mean and σ.
 */
export function correlationMeasureLines(r: CorrelationMeasureReadout, unit?: string): string[] {
  return [
    terms(term('Δx', finite(r.dx)), term('Δy', finite(r.dy), unit), term('Δy/Δx', r.slope)),
    terms(
      r.n === null ? `n = ${READOUT_DASH}` : `n = ${r.n}`,
      term('ȳ', r.mean, unit),
      term('σ', r.std, unit)
    ),
  ];
}

/**
 * Correlation's {@link MeasureProvider}: reads the frame on screen through
 * `getFrame` at call time, never closing over a frame.
 */
export function createCorrelationMeasure(getFrame: () => FrameLike | null): MeasureProvider {
  return {
    card(a: Annotation, ctx: DrawingTextContext): string[] {
      return correlationMeasureLines(correlationMeasureReadout(a, getFrame()), axisUnit(ctx.axis));
    },
  };
}
