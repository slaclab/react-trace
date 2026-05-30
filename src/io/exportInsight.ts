import type { InsightMeta, InsightRow } from '../hooks/useInsightData';

// Export helpers for the Data Insight Tool. Mirror the Python DIT's output:
// a metadata header (Address/Unit/Description) and timestamps as epoch seconds.
// MAT export is intentionally deferred to the backend (see docs/data-insight-tool.md).

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
