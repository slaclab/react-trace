// Convert UI time-range strings into a (fromNs, toNs) pair. toNs defaults to "now".
// `custom` is reserved for a future date picker; for now it falls back to -1h.

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

const RANGE_TO_MS: Record<string, number> = {
  '-1h': 60 * 60 * 1000,
  '-4h': 4 * 60 * 60 * 1000,
  '-1d': 24 * 60 * 60 * 1000,
  '-1w': 7 * 24 * 60 * 60 * 1000,
};

export interface TimeWindowNs {
  fromNs: number;
  toNs: number;
}

export function rangeToWindowNs(range: string): TimeWindowNs {
  const spanMs = RANGE_TO_MS[range] ?? RANGE_TO_MS['-1h'];
  const toNs = nowNs();
  const fromNs = toNs - msToNs(spanMs);
  return { fromNs, toNs };
}
