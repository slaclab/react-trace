// Waveform exports. The CSV is the currently published frames
// over the element range, one row per element: `element`, then the X-source
// position when the X source is usable, then one column per drawn curve in
// colour order (Δ values, headed `Δ <name>`, when Δ is on), then the reference
// as its own column. A non-finite value (NaN gap, ±Infinity) and an element
// past the end of a shorter frame are empty cells. The PNG is the chart's data
// URL with the drawings composed on top: every
// `svg[data-annotation-layer]` overlay in the chart's stage, through the
// multi-overlay composer; with drawings hidden, or no overlay, the chart
// alone, synchronously. File names follow Correlation's pattern,
// `waveform-<iso>.<ext>`; the image source, the download and the header cells
// (neutralised against spreadsheet formulas) come from ../shared.

import type { PngSource } from '../chartElogPost';
import { chartPngSource, downloadHref, type ChartImage } from '../shared/chartImage';
import { csvField } from '../shared/csv';
import { elementSpan } from './frames';
import type { WaveformElementRange } from './query';

/** One exported column: its header name and its full (un-ranged) frame. */
export interface WaveformExportColumn {
  name: string;
  values: Float64Array;
}

/** What the canvas published, as the export reads it. */
export interface WaveformExport {
  /** Publish time, ms since the epoch; stamps the file name. */
  time: number;
  /** The drawn Live curves in colour order; already Δ when `delta` is on. */
  curves: readonly WaveformExportColumn[];
  /** The reference frame, exported raw as its own column; null for none or hidden. */
  reference: WaveformExportColumn | null;
  /** The X source; its column is written only when usable and published. */
  x: { name: string; values: Float64Array | null; usable: boolean } | null;
  /** Element range; null = all elements. */
  range: WaveformElementRange | null;
  /** Whether the curve columns hold Δ = live − reference. */
  delta: boolean;
}

function cell(values: Float64Array, i: number): string {
  if (i >= values.length) return '';
  const v = values[i];
  return Number.isFinite(v) ? String(v) : '';
}

function rangeLabel(range: WaveformElementRange | null): string {
  if (range === null || (range.first === undefined && range.last === undefined)) return 'all';
  return `${range.first ?? ''}..${range.last ?? ''}`;
}

/** The CSV of the published frames over the element range. */
export function waveformCsv(data: WaveformExport): string {
  const columns: { header: string; values: Float64Array }[] = [];
  if (data.x !== null && data.x.usable && data.x.values !== null) {
    columns.push({ header: data.x.name, values: data.x.values });
  }
  for (const curve of data.curves) {
    columns.push({ header: data.delta ? `Δ ${curve.name}` : curve.name, values: curve.values });
  }
  if (data.reference !== null) {
    columns.push({ header: data.reference.name, values: data.reference.values });
  }

  // The rows span the drawn frames (the X source alone draws nothing).
  let len = 0;
  for (const c of data.curves) len = Math.max(len, c.values.length);
  if (data.reference !== null) len = Math.max(len, data.reference.values.length);
  const { start, end } = elementSpan(len, data.range);

  const lines = [
    '# canopy waveform export',
    `# delta: ${data.delta ? 'on (live − reference)' : 'off'}`,
    `# elements: ${rangeLabel(data.range)}`,
    ['element', ...columns.map((c) => csvField(c.header))].join(','),
  ];
  for (let i = start; i < end; i++) {
    lines.push([String(i), ...columns.map((c) => cell(c.values, i))].join(','));
  }
  return lines.join('\n') + '\n';
}

/** `waveform-<iso>.<ext>`, the ISO time with `:` and `.` made file-safe. */
export function waveformFileName(time: number, ext: 'csv' | 'png'): string {
  const d = new Date(time);
  const stamp = Number.isNaN(d.getTime()) ? 'empty' : d.toISOString().replace(/[:.]/g, '-');
  return `waveform-${stamp}.${ext}`;
}

/** Download the CSV of the published frames. */
export function downloadWaveformCsv(data: WaveformExport): void {
  const blob = new Blob([waveformCsv(data)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  downloadHref(url, waveformFileName(data.time, 'csv'));
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const PIXEL_RATIO = 2;

/**
 * The chart as a PNG source for Export PNG and Post to e-log: the chart's
 * data URL with every drawing overlay in its stage composed on top; the chart
 * alone (and synchronously) when `drawingsHidden`, when no overlay is mounted,
 * or when the chart yields no data URL. A failed compose falls back to the chart.
 */
export function waveformPngSource(chart: ChartImage, drawingsHidden: boolean): PngSource {
  return chartPngSource(chart, drawingsHidden);
}

/** Download the chart (with its drawings unless hidden) as a PNG. */
export function downloadWaveformPng(
  chart: ChartImage,
  backgroundColor: string,
  time: number,
  drawingsHidden = false
): void {
  const fileName = waveformFileName(time, 'png');
  const href = waveformPngSource(chart, drawingsHidden).getDataURL({
    type: 'png',
    pixelRatio: PIXEL_RATIO,
    backgroundColor,
  });
  if (typeof href === 'string') downloadHref(href, fileName);
  else void href.then((url) => downloadHref(url, fileName));
}
