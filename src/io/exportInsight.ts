import type { InsightMeta, InsightRow } from '../hooks/useInsightData';
import { encodeMatFile, type MatValue } from './mat';

// Export helpers for the Data Insight Tool. Mirror the Python DIT's output:
// a metadata header (Address/Unit/Description) and timestamps as epoch seconds.
// CSV, JSON, and MAT (MATLAB Level-5) are all produced client-side.

function csvField(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function valueStr(v: InsightRow['value']): string {
  if (v === null) return '';
  return String(v);
}

export function buildInsightCsv(meta: InsightMeta, rows: InsightRow[]): string {
  const header = [
    `Address: ${meta.pv}`,
    `Unit: ${meta.units ?? ''}`,
    `Description: ${meta.description ?? ''}`,
  ].join('\n');
  const cols = 'time_s,datetime_iso,value,severity,source';
  const body = rows.map((r) => {
    const timeS = r.tsNs / 1e9;
    const iso = new Date(r.tsNs / 1e6).toISOString();
    return [timeS, iso, csvField(valueStr(r.value)), r.severity, r.source].join(',');
  });
  return [header, '', cols, ...body].join('\n') + '\n';
}

export function buildInsightJson(meta: InsightMeta, rows: InsightRow[]): string {
  return JSON.stringify(
    {
      meta: { address: meta.pv, unit: meta.units, description: meta.description },
      data: rows.map((r) => ({
        timeS: r.tsNs / 1e9,
        value: r.value,
        severity: r.severity,
        source: r.source,
      })),
    },
    null,
    2
  );
}

// MAT export writes `value` as a numeric column; non-numeric/empty samples
// become NaN. The Insight tool's data is numeric scalars in practice, so there
// is no decode-as-string path here (unlike the Python DIT's waveform handling).
function toNumber(v: InsightRow['value']): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// Build a MATLAB Level-5 .mat with the same variables scipy.io.savemat would
// emit from the Python DIT: the Address/Unit/Description metadata as char
// arrays plus one column per data field.
export function buildInsightMat(meta: InsightMeta, rows: InsightRow[]): Uint8Array<ArrayBuffer> {
  const n = rows.length;
  const timeS = new Array<number>(n);
  const value = new Array<number>(n);
  const severity = new Array<string>(n);
  const source = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    timeS[i] = r.tsNs / 1e9;
    value[i] = toNumber(r.value);
    severity[i] = r.severity;
    source[i] = r.source;
  }
  const vars: Record<string, MatValue> = {
    Address: { type: 'char', value: meta.pv },
    Unit: { type: 'char', value: meta.units ?? '' },
    Description: { type: 'char', value: meta.description ?? '' },
    time_s: { type: 'double', rows: n, cols: 1, data: timeS },
    value: { type: 'double', rows: n, cols: 1, data: value },
    severity: { type: 'charMatrix', rows: severity },
    source: { type: 'charMatrix', rows: source },
  };
  return encodeMatFile(vars);
}
