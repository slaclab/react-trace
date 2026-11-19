// One CSV cell for the context tools' exports.
//
// A text cell is quoted when it holds a quote, comma or line break. A text
// cell that a spreadsheet would read as a formula (one starting with `=`,
// `+`, `-`, `@`, a tab or a carriage return, such as a PV name or a label the
// operator typed) is prefixed with `'`, so opening the file never evaluates
// it. Numbers are written by the caller with `String(n)` and never pass
// through here, so a negative value stays a number.

const FORMULA_START = /^[=+\-@\t\r]/;

/** A text cell, neutralised against formula evaluation and quoted as needed. */
export function csvField(text: string): string {
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
