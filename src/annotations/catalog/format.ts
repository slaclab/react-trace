// Value formatters shared by the drawing tools. Tool definitions import these
// from here, never from `model.ts`, so the catalog cannot form an import cycle
// with the model.

import type { AxisRef } from './types';

/** A value as the Layers label and the measure card print it (4 significant digits). */
export function fmtValue(v: number): string {
  return String(Number(v.toPrecision(4)));
}

/** The unit text of `axis`: its unit override, else its EGU; undefined when it has none. */
export function axisUnit(axis: AxisRef | undefined): string | undefined {
  return axis ? (axis.unitLabel ?? axis.units) || undefined : undefined;
}

/** `text` followed by the axis unit text, when there is one. */
export function withUnit(text: string, unit: string | undefined): string {
  return unit ? `${text} ${unit}` : text;
}

const DURATION_UNITS: [string, number][] = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1000],
];

/** A duration as its two largest non-zero units (`12 m 30 s`, `1 h`); under a second in ms. */
export function formatDuration(ms: number): string {
  const total = Math.round(Math.abs(ms));
  if (total === 0) return '0 s';
  if (total < 1000) return `${total} ms`;
  let rest = Math.floor(total / 1000) * 1000;
  const parts: string[] = [];
  for (const [unit, size] of DURATION_UNITS) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0 || parts.length > 0) parts.push(n > 0 ? `${n} ${unit}` : '');
    if (parts.length === 2) break;
  }
  return parts.filter(Boolean).join(' ');
}

/** The figure dash a readout prints for a value it cannot give. */
export const READOUT_DASH = '—';

/** Space between the terms of a readout line: an em space, which svg text never collapses. */
export const TERM_GAP = ' ';

/** `text` with a leading hyphen-minus set as the minus sign. */
export function withMinus(text: string): string {
  return text.startsWith('-') ? `−${text.slice(1)}` : text;
}

/** One readout term as a figure prints it: `Δx = −26.57 A`; `—` for a missing value. */
export function term(symbol: string, v: number | null | undefined, unit?: string): string {
  const shown =
    v === null || v === undefined || !Number.isFinite(v)
      ? READOUT_DASH
      : withUnit(withMinus(fmtValue(v)), unit);
  return `${symbol} = ${shown}`;
}

/** Readout terms on one line. */
export function terms(...parts: string[]): string {
  return parts.join(TERM_GAP);
}
