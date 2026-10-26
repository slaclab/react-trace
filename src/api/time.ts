// Convert UI time-range strings into a (fromNs, toNs) pair anchored to a
// caller-supplied "now". Relative ranges are spans like "-1h"/"-90m"; "custom"
// resolves the plot's absolute From/To datetime-local fields.

const NS_PER_MS = 1_000_000n;

export function nowNs(): number {
  return Number(BigInt(Date.now()) * NS_PER_MS);
}

export function msToNs(ms: number): number {
  return Number(BigInt(Math.trunc(ms)) * NS_PER_MS);
}

export function nsToMs(ns: number): number {
  return Math.trunc(ns / 1_000_000);
}

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

function lastHourWindow(nowMs: number): TimeWindowNs {
  const toNs = msToNs(nowMs);
  return { fromNs: toNs - msToNs(ONE_HOUR_MS), toNs };
}

// Resolve a plot's x-axis into an absolute fetch window. Relative ranges end at
// `nowMs`; "custom" reads the From/To datetime-local fields (empty To = `nowMs`).
// Invalid custom ranges fall back to the hour before `nowMs` and report an error
// string. `nowMs` is the plot's clock (see useAutoScrollTimers), not the wall
// clock, so a plot that isn't tracking "now" resolves to the same window on
// every render.
export function resolveTimeWindow(xAxis: XAxisLike, nowMs: number): ResolvedTimeWindow {
  if (xAxis.timeRange === 'custom') {
    const fromMs = xAxis.timeFrom ? new Date(xAxis.timeFrom).getTime() : NaN;
    if (!Number.isFinite(fromMs)) {
      return { window: lastHourWindow(nowMs), error: 'Enter a valid "From" date and time.' };
    }
    const toMs = xAxis.timeTo ? new Date(xAxis.timeTo).getTime() : nowMs;
    if (!Number.isFinite(toMs)) {
      return { window: lastHourWindow(nowMs), error: 'Enter a valid "To" date and time.' };
    }
    if (fromMs >= toMs) {
      return { window: lastHourWindow(nowMs), error: '"From" must be before "To".' };
    }
    return { window: { fromNs: msToNs(fromMs), toNs: msToNs(toMs) } };
  }

  const spanMs = relativeRangeMs(xAxis.timeRange) ?? ONE_HOUR_MS;
  const toNs = msToNs(nowMs);
  return { window: { fromNs: toNs - msToNs(spanMs), toNs } };
}
