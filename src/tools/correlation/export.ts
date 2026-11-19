// Clear and the exports.
//
// Clear is on the data clock: it records the newest tsNs on screen as the
// cut, and from then on every frame drops its rows with tsNs ≤ the cut —
// later frames stay filtered. It works while paused.
//
// Exports take the frame on screen after the cut — while paused, the frozen
// frame the readout shows, so Pause → read → export ties a readout to its CSV
// rows. The CSV is wide: `tsNs, iso, <X PV>, <Y PVs…>` in the frame's own
// column order, named from the frame's column→PV map, so a role edit made
// while paused never relabels a frozen frame. Its `#` header comment records
// the Clear cut (`# clear-cut-tsNs: <n>` or `none`), so an offline fit can
// drop the same rows. Header cells go through the shared `csvField`, which
// neutralises a cell a spreadsheet would read as a formula.
//
// The image export and the download live in ../shared/chartImage.ts.

import type { TableResultDTO } from '@slaclab/canopy-client';
import { downloadHref } from '../shared/chartImage';
import { csvField } from '../shared/csv';
import { yColumns, type FrameLike } from './stats';

export const CSV_CUT_PREFIX = '# clear-cut-tsNs: ';

/** The newest tsNs of a frame, null when it has no rows. */
export function newestTsNs(frame: FrameLike | null): number | null {
  const ts = frame?.table.tsNs;
  return ts !== undefined && ts.length > 0 ? ts[ts.length - 1] : null;
}

/**
 * The frame with its rows at or before `cutNs` dropped. Returns the same
 * object when nothing is dropped (no cut, or every row newer).
 */
export function applyCut<F extends FrameLike>(frame: F, cutNs: number | null): F;
export function applyCut<F extends FrameLike>(frame: F | null, cutNs: number | null): F | null;
export function applyCut<F extends FrameLike>(frame: F | null, cutNs: number | null): F | null {
  if (frame === null || cutNs === null) return frame;
  const { tsNs } = frame.table;
  let start = 0;
  // Rows are oldest first, so the kept rows are a suffix.
  while (start < tsNs.length && tsNs[start] <= cutNs) start++;
  if (start === 0) return frame;
  const columns: Record<string, (number | null)[]> = {};
  for (const [name, cells] of Object.entries(frame.table.columns)) {
    columns[name] = cells.slice(start);
  }
  const table: TableResultDTO = { ...frame.table, tsNs: tsNs.slice(start), columns };
  return { ...frame, table };
}

/** Plotted columns of a frame in CSV order: x, then the Ys in colour order. */
export function csvColumns(columnPvs: Record<string, string>): string[] {
  return [...(columnPvs.x !== undefined ? ['x'] : []), ...yColumns(columnPvs)];
}

function isoOf(tsNs: number): string {
  const d = new Date(tsNs / 1e6);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** The wide CSV of the frame on screen (`frame` already cut by `cutNs`). */
export function frameCsv(frame: FrameLike, cutNs: number | null): string {
  const columns = csvColumns(frame.columnPvs);
  const { tsNs } = frame.table;
  const lines = [
    '# canopy correlation export',
    `${CSV_CUT_PREFIX}${cutNs === null ? 'none' : String(cutNs)}`,
    '# tsNs is a JSON number: exact in the browser only to ~256 ns',
    ['tsNs', 'iso', ...columns.map((c) => csvField(frame.columnPvs[c]))].join(','),
  ];
  for (let i = 0; i < tsNs.length; i++) {
    if (cutNs !== null && tsNs[i] <= cutNs) continue;
    const cells = columns.map((c) => {
      const v = frame.table.columns[c]?.[i];
      return v === null || v === undefined ? '' : String(v);
    });
    lines.push([String(tsNs[i]), isoOf(tsNs[i]), ...cells].join(','));
  }
  return lines.join('\n') + '\n';
}

/** A file name for an export, stamped with the newest row's time. */
export function exportFileName(frame: FrameLike | null, ext: 'csv' | 'png'): string {
  const newest = newestTsNs(frame);
  const stamp = newest === null ? 'empty' : isoOf(newest).replace(/[:.]/g, '-');
  return `correlation-${stamp}.${ext}`;
}

/** Download the CSV of the frame on screen. */
export function downloadCsv(frame: FrameLike, cutNs: number | null): void {
  const blob = new Blob([frameCsv(frame, cutNs)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  downloadHref(url, exportFileName(frame, 'csv'));
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
