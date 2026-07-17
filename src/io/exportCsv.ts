import type { Plot, PVTrace } from '../types';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import type { FormulaSeriesResult } from '../hooks/useFormulaSeries';
import { traceLabel } from '../traceLabel';
import { safeFilename } from './filename';

// Long-format CSV: one row per (trace, sample). Easier to write and easier to
// pivot later than a wide-format that aligns timestamps across PVs (Vole's job
// once it lands). One file per plot.
//
// Returns the filename → contents pairs the caller should download. Plots
// without any samples are skipped — there's nothing to write.
export function buildCsvFiles(
  plots: Plot[],
  archiveResultsByPlot: Map<string, Map<string, ArchiveSeriesResult>>,
  formulaResultsByPlot?: Map<string, Map<string, FormulaSeriesResult>>
): { filename: string; csv: string }[] {
  const out: { filename: string; csv: string }[] = [];
  for (const plot of plots) {
    const results = archiveResultsByPlot.get(plot.id);
    const formulaResults = formulaResultsByPlot?.get(plot.id);
    // A plot may have only formula curves (no archive map), so don't skip on a
    // missing archive map alone.
    const rows = buildPlotRows(plot, results ?? new Map(), formulaResults ?? new Map());
    if (rows.length === 0) continue;
    out.push({
      filename: safeFilename(plot.title) + '.csv',
      csv: ['pv,time_ns,time_iso,value', ...rows].join('\n') + '\n',
    });
  }
  return out;
}

function buildPlotRows(
  plot: Plot,
  results: Map<string, ArchiveSeriesResult>,
  formulaResults: Map<string, FormulaSeriesResult>
): string[] {
  const rows: string[] = [];
  for (const trace of plot.traces) {
    // Formula curves have no archive data (useArchive is false); their evaluated
    // points come from Fox, so pull them from the formula results instead. The
    // label column carries the formula's display name since it has no pvName.
    if (trace.kind === 'formula') {
      const fr = formulaResults.get(trace.id);
      if (!fr || fr.points.length === 0) continue;
      const label = csvField(traceLabel(trace, plot.traces));
      for (const [timeMs, value] of fr.points) {
        const ns = Math.round(timeMs * 1_000_000);
        const iso = new Date(timeMs).toISOString();
        rows.push(`${label},${ns},${iso},${formatValue(value)}`);
      }
      continue;
    }
    if (!trace.useArchive) continue;
    const result = results.get(trace.id);
    if (!result || result.mean.length === 0) continue;
    const pv = csvField(trace.pvName);
    for (const sample of result.mean) {
      // ArchivePlotPoint.time is ms; convert to ns for the canonical column.
      const ns = Math.round(sample.time * 1_000_000);
      const iso = new Date(sample.time).toISOString();
      rows.push(`${pv},${ns},${iso},${formatValue(sample.value)}`);
    }
  }
  return rows;
}

function formatValue(v: number): string {
  if (!Number.isFinite(v)) return '';
  return String(v);
}

function csvField(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Re-export for callers that want to count exportable traces before clicking
// (e.g. to disable the button when nothing is loaded).
export function countExportableTraces(
  plots: Plot[],
  archiveResultsByPlot: Map<string, Map<string, ArchiveSeriesResult>>,
  formulaResultsByPlot?: Map<string, Map<string, FormulaSeriesResult>>
): number {
  let n = 0;
  for (const plot of plots) {
    const results = archiveResultsByPlot.get(plot.id);
    const formulaResults = formulaResultsByPlot?.get(plot.id);
    for (const trace of plot.traces as PVTrace[]) {
      if (trace.kind === 'formula') {
        const fr = formulaResults?.get(trace.id);
        if (fr && fr.points.length > 0) n += 1;
        continue;
      }
      const r = results?.get(trace.id);
      if (trace.useArchive && r && r.mean.length > 0) n += 1;
    }
  }
  return n;
}
