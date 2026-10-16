// Convert UI time-range strings into a (fromNs, toNs) pair. toNs defaults to "now".
// Relative ranges are spans like "-1h"/"-90m"; "custom" resolves the plot's
// absolute From/To datetime-local fields.

import { msToNs, nowNs } from '@slaclab/canopy-client';

// Epoch-ns helpers come from the SDK; re-exported so callers keep one import.
export { msToNs, nowNs, nsToMs } from '@slaclab/canopy-client';

// Span multipliers in milliseconds. Lowercase `m` is minutes; uppercase `M` is
// months (approximated as 30 days), matching the Python IOTimeParser units.
const SPAN_UNIT_MS: Record<string, number> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  M: 30 * 24 * 60 * 60 * 1000,
};

const ONE_HOUR_MS = SPAN_UNIT_MS.h;

// Parse a free-text span like "1.5h", "30m", "2w" into milliseconds. Returns
// null for anything that isn't a positive number followed by a known unit.
export function parseSpanMs(span: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([mhdwM])\s*$/.exec(span);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value * SPAN_UNIT_MS[match[2]];
}

// Resolve a relative range string ("-1h", "-90m") to a span in milliseconds.
// The leading "-" is required; the remainder is a span. Returns null otherwise.
export function relativeRangeMs(range: string): number | null {
  if (!range.startsWith('-')) return null;
  return parseSpanMs(range.slice(1));
}

// Format an epoch-ms instant as a datetime-local value ("YYYY-MM-DDTHH:mm") in
// local time, suitable for seeding the From/To inputs from an absolute time.
export function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface TimeWindowNs {
  fromNs: number;
  toNs: number;
}

interface XAxisLike {
  timeRange: string;
  timeFrom?: string;
  timeTo?: string;
}

export interface ResolvedTimeWindow {
  window: TimeWindowNs;
  // Set when a custom range is invalid; the window falls back to the last hour.
  error?: string;
}

function lastHourWindow(): TimeWindowNs {
  const toNs = nowNs();
  return { fromNs: toNs - msToNs(ONE_HOUR_MS), toNs };
}

// Resolve a plot's x-axis into an absolute fetch window. Relative ranges anchor
// to "now"; "custom" reads the From/To datetime-local fields (empty To = now).
// Invalid custom ranges fall back to the last hour and report an error string.
export function resolveTimeWindow(xAxis: XAxisLike): ResolvedTimeWindow {
  if (xAxis.timeRange === 'custom') {
    const fromMs = xAxis.timeFrom ? new Date(xAxis.timeFrom).getTime() : NaN;
    if (!Number.isFinite(fromMs)) {
      return { window: lastHourWindow(), error: 'Enter a valid "From" date and time.' };
    }
    const toMs = xAxis.timeTo ? new Date(xAxis.timeTo).getTime() : Date.now();
    if (!Number.isFinite(toMs)) {
      return { window: lastHourWindow(), error: 'Enter a valid "To" date and time.' };
    }
    if (fromMs >= toMs) {
      return { window: lastHourWindow(), error: '"From" must be before "To".' };
    }
    return { window: { fromNs: msToNs(fromMs), toNs: msToNs(toMs) } };
  }

  const spanMs = relativeRangeMs(xAxis.timeRange) ?? ONE_HOUR_MS;
  const toNs = nowNs();
  return { window: { fromNs: toNs - msToNs(spanMs), toNs } };
}
