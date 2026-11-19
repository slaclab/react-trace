// A drawing's measure readout read back the way the drawing layer prints it
// (src/annotations/catalog/format.ts `term`/`terms`): each line is terms
// `symbol = value[ unit]` joined by an em space, a negative value carries the
// minus sign (U+2212), and a missing value is `—`.

/** The space between a line's terms (format.ts TERM_GAP). */
export const TERM_GAP = ' ';

/** One readout line as symbol → value (NaN for `—`); the unit is dropped. */
export function readoutTerms(line: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of line.split(TERM_GAP)) {
    const m = /^(.+?) = (\S+)/.exec(part.trim());
    if (m === null) continue;
    out[m[1]] = m[2] === '—' ? Number.NaN : Number(m[2].replace('−', '-'));
  }
  return out;
}
