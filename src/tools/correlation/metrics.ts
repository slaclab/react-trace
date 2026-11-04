// Correlation's metric catalog: what the shared statistics library
// (src/statistics) evaluates for each Y. Callers pass `CORRELATION_METRICS` to
// the library's functions (src/statistics/model.ts), as Waveform and Trace
// pass theirs.
//
// Variables: `x`, `y` (this row's Y), `y1..y8` (a Y by position), `t`
// (seconds relative to the newest row, ≤ 0), `n` (row count). A row's
// evaluation sees the rows where X, its Y and every referenced Y are all
// finite, because `x` and `y` are the joint set. Units: the row's Y unit, the
// X unit, Y per X, or none.

import type { MetricCatalog, MetricPreset } from '../../statistics/model';

export type MetricUnit = '' | 'x' | 'y' | 'y/x';
export const METRIC_UNITS: readonly MetricUnit[] = ['', 'x', 'y', 'y/x'];

/** The built-in metrics, in default column order. */
export const PRESETS: readonly MetricPreset[] = Object.freeze([
  { id: 'n', label: 'n', expr: 'n', unit: '', defaultOn: true },
  { id: 'mean', label: 'mean', expr: 'mean(y)', unit: 'y', defaultOn: true },
  { id: 'std', label: 'std', expr: 'std(y)', unit: 'y', defaultOn: true },
  { id: 'r', label: 'r', expr: 'corr(x, y)', unit: '', range: [-1, 1], defaultOn: true },
  { id: 'slope', label: 'slope', expr: 'slope(x, y)', unit: 'y/x', defaultOn: true },
  { id: 'r2', label: 'R²', expr: 'r2(x, y)', unit: '', range: [0, 1], defaultOn: false },
  { id: 'intercept', label: 'intercept', expr: 'intercept(x, y)', unit: 'y', defaultOn: false },
  { id: 'min', label: 'min', expr: 'min(y)', unit: 'y', defaultOn: false },
  { id: 'max', label: 'max', expr: 'max(y)', unit: 'y', defaultOn: false },
  { id: 'p2p', label: 'p2p', expr: 'ptp(y)', unit: 'y', defaultOn: false },
  { id: 'rms', label: 'rms', expr: 'rms(y)', unit: 'y', defaultOn: false },
  { id: 'xmean', label: 'X mean', expr: 'mean(x)', unit: 'x', defaultOn: false },
  { id: 'xstd', label: 'X std', expr: 'std(x)', unit: 'x', defaultOn: false },
]);

export const CORRELATION_METRICS: MetricCatalog = {
  id: 'correlation',
  vectorVars: ['x', 'y', 't'],
  scalarVars: ['n'],
  jointVars: ['x', 'y'],
  alignedRows: true,
  units: [
    { value: '', label: 'None' },
    { value: 'y', label: 'Y unit' },
    { value: 'x', label: 'X unit' },
    { value: 'y/x', label: 'Y per X' },
  ],
  presets: PRESETS,
  rowNoun: 'Y PV',
  variables: [
    { name: 'x', signature: 'x', description: 'The X PV over the evaluated rows.' },
    { name: 'y', signature: 'y', description: 'The Y PV this readout row is for.' },
    { name: 'y1', signature: 'y1 … y8', description: 'A Y PV by its position in the Y list.' },
    { name: 't', signature: 't', description: 'Seconds relative to the newest row (≤ 0).' },
    { name: 'n', signature: 'n', description: 'The number of evaluated rows.' },
    { name: 'pi', signature: 'pi', description: 'The constant π.' },
    { name: 'e', signature: 'e', description: "Euler's number." },
  ],
  example:
    'Expressions over x and y (this row’s Y), e.g. std(y - mean(y)), max(abs(y)), slope(t, y).',
};
