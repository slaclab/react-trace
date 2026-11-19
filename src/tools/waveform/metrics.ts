// Waveform's statistics payload: the catalog the shared statistics
// library (src/statistics) evaluates, and the frame adapter over the
// controller's publish.
//
// Rows: every live curve in list order — so `y<k>` is the k-th of the Live
// list — the drawn ones with their values over the element range of the
// published frame, Δ applied when Δ is on (exactly what the old statistics
// row computed), the others (hidden, refused, no frame yet) hidden rows with
// no values. Columns: `y` (the values), `i` (the element index, as the X axis
// shows it), `x` (the X-source value when the axis uses it, else `i`), and
// the reference columns — `r` (what this curve subtracts),
// `s` (its per-element σ: rolling, or a snapshot frozen from one) and
// `d = raw − r` (the deviation whether or not Δ is drawn) — NaN throughout
// when the curve has no such reference, so only metrics that use them read
// "–"; `n` the finite elements in range.
// Units: the axis unit (`y`), the X source's EGU (`x`), or none.

import type { StatFrame, StatRow } from '../../statistics/evaluate';
import type { MetricCatalog } from '../../statistics/model';
import { deltaFrame, elementSpan } from './frames';
import type { WaveformModel } from './model';
import type { WaveformPlotFrames } from './plotOption';
import type { WaveformState } from './query';
import { referenceFor } from './reference';
import { autoYColor } from '../shared/colors';

export const WAVEFORM_METRICS: MetricCatalog = {
  id: 'waveform',
  vectorVars: ['y', 'i', 'x', 'r', 's', 'd'],
  scalarVars: ['n'],
  jointVars: ['y'],
  alignedRows: true,
  units: [
    { value: '', label: 'None' },
    { value: 'y', label: 'Axis unit' },
    { value: 'x', label: 'X axis PV unit' },
  ],
  presets: [
    { id: 'n', label: 'n', expr: 'n', unit: '', defaultOn: true },
    { id: 'mean', label: 'mean', expr: 'mean(y)', unit: 'y', defaultOn: true },
    { id: 'std', label: 'std', expr: 'std(y)', unit: 'y', defaultOn: true },
    { id: 'rms', label: 'rms', expr: 'rms(y)', unit: 'y', defaultOn: true },
    { id: 'p2p', label: 'p-p', expr: 'ptp(y)', unit: 'y', defaultOn: true },
    { id: 'min', label: 'min', expr: 'min(y)', unit: 'y', defaultOn: false },
    { id: 'max', label: 'max', expr: 'max(y)', unit: 'y', defaultOn: false },
    { id: 'median', label: 'median', expr: 'median(y)', unit: 'y', defaultOn: false },
    { id: 'peak', label: 'peak at', expr: 'at(i, argmax(y))', unit: '', defaultOn: false },
    { id: 'trough', label: 'trough at', expr: 'at(i, argmin(y))', unit: '', defaultOn: false },
    { id: 'devrms', label: 'dev rms', expr: 'rms(d)', unit: 'y', defaultOn: false },
    { id: 'devmax', label: 'dev max', expr: 'max(abs(d))', unit: 'y', defaultOn: false },
    { id: 'devsig', label: 'dev σ', expr: 'max(abs(d) / s)', unit: '', defaultOn: false },
    {
      id: 'worst',
      label: 'worst at',
      expr: 'at(i, argmax(abs(d) / s))',
      unit: '',
      defaultOn: false,
    },
  ],
  rowNoun: 'curve',
  variables: [
    {
      name: 'y',
      signature: 'y',
      description: 'This curve’s values over the element range (Δ when Δ is on).',
    },
    { name: 'i', signature: 'i', description: 'The element index of each value.' },
    {
      name: 'x',
      signature: 'x',
      description: 'The X-source value of each element; the index without one.',
    },
    {
      name: 'r',
      signature: 'r',
      description: 'The reference this curve subtracts, element by element; none → "–".',
    },
    {
      name: 's',
      signature: 's',
      description: 'The reference’s σ per element (rolling, or a snapshot frozen from one).',
    },
    {
      name: 'd',
      signature: 'd',
      description: 'The deviation from the reference, raw − r, whether or not Δ is drawn.',
    },
    { name: 'y1', signature: 'y1 … y8', description: 'A live curve by its position in the list.' },
    { name: 'n', signature: 'n', description: 'The number of finite elements in range.' },
    { name: 'pi', signature: 'pi', description: 'The constant π.' },
    { name: 'e', signature: 'e', description: "Euler's number." },
  ],
  example:
    'Expressions over y (this curve), e.g. max(abs(y)), at(i, argmax(y)), mean(y - y1), rms(d).',
};

/** The X-source values the frame draws against, when the axis uses them and they fit `length`. */
function xSource(model: WaveformModel, frames: WaveformPlotFrames, length: number) {
  if (model.xAxis.mode !== 'source' || frames.x === null) return null;
  return frames.x.length === length ? frames.x : null;
}

const NO_VALUES = new Float64Array(0);

/** A drawn live curve's raw frame, what it draws (Δ applied) and its reference; null when not drawn. */
function drawnValues(
  state: WaveformState,
  model: WaveformModel,
  frames: WaveformPlotFrames,
  pv: string
): {
  raw: Float64Array;
  values: Float64Array;
  r: Float64Array | null;
  s: Float64Array | null;
} | null {
  const row = model.live.find((r) => r.pv === pv);
  if (row === undefined || !row.drawable) return null;
  const curve = Object.prototype.hasOwnProperty.call(frames.live, pv) ? frames.live[pv] : undefined;
  if (curve === undefined) return null;
  const raw = curve.frame;
  const reference = referenceFor(state, frames, pv);
  const same = reference !== null && reference.values.length === raw.length;
  const r = same ? reference.values : null;
  const s =
    same && reference.spread !== null && reference.spread.length === raw.length
      ? reference.spread
      : null;
  if (!(model.delta.on && state.reference !== null)) return { raw, values: raw, r, s };
  if (r === null) return null;
  const values = deltaFrame(raw, r);
  return values === null ? null : { raw, values, r, s };
}

/** `raw − r` element-wise, or NaN throughout without a reference. */
function deviation(raw: Float64Array, r: Float64Array | null): Float64Array {
  const out = new Float64Array(raw.length);
  if (r === null) return out.fill(NaN);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] - r[i];
  return out;
}

function nanColumn(n: number): Float64Array {
  return new Float64Array(n).fill(NaN);
}

/**
 * The frame as the statistics library sees it: one row per live curve in
 * list order (the drawn ones with their values, Δ applied, over the element
 * range; the others hidden and empty), or null while no curve is drawn.
 */
export function waveformStatFrame(
  state: WaveformState,
  model: WaveformModel,
  frames: WaveformPlotFrames
): StatFrame | null {
  const rows: StatRow[] = [];
  let drawn = 0;
  state.pvs.forEach((pv, index) => {
    const style = Object.prototype.hasOwnProperty.call(state.styles, pv)
      ? state.styles[pv]
      : undefined;
    const base = { id: pv, label: style?.label || pv, color: style?.color ?? autoYColor(index) };
    const drawnRow = drawnValues(state, model, frames, pv);
    if (drawnRow === null) {
      rows.push({
        ...base,
        hidden: true,
        columns: {
          y: NO_VALUES,
          i: NO_VALUES,
          x: NO_VALUES,
          r: NO_VALUES,
          s: NO_VALUES,
          d: NO_VALUES,
        },
      });
      return;
    }
    const { raw, values } = drawnRow;
    const { start, end } = elementSpan(values.length, state.elems);
    const n = end - start;
    const y = values.subarray(start, end);
    const i = Float64Array.from({ length: n }, (_, k) => start + k);
    const source = xSource(model, frames, values.length);
    const x = source === null ? i : source.subarray(start, end);
    const r = drawnRow.r === null ? nanColumn(n) : drawnRow.r.subarray(start, end);
    const s = drawnRow.s === null ? nanColumn(n) : drawnRow.s.subarray(start, end);
    const d = deviation(raw.subarray(start, end), drawnRow.r?.subarray(start, end) ?? null);
    rows.push({ ...base, columns: { y, i, x, r, s, d } });
    drawn++;
  });
  return drawn === 0 ? null : { rows };
}

/** The unit text of a metric's kind: the axis unit, the X source's EGU, or none. */
export function waveformUnitOf(model: WaveformModel, unit: string): string {
  if (unit === 'y') return model.unit ?? '';
  if (unit === 'x') return model.xAxis.mode === 'source' ? (model.x?.egu ?? '') : '';
  return '';
}
