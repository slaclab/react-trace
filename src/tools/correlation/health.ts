// The correlation tab's health line: a pure reducer over subscription
// events, plus the line the tab shows, evaluated each second.
//
// The state is keyed on the tab's **current subscription id** — the id of the
// subscribe call it made last (minted by useTable). Frames carrying any other
// id are ignored. Per current id:
//   none    — no spec can be built (no X, no accepted Y, a refused trigger)
//   pending — subscribed, no result since that subscribe or since the Formula Engine
//             socket last (re)opened
//   live    — a result arrived since then
//   errored — a non-retryable error; it survives every later socket change
//             and is left only by a new id (Retry or a spec change)
//
// The Formula Engine socket status is an input: a close since the last successful open
// is remembered, so `connecting` after such a close (a backoff attempt, or
// the relay holding a blackholed upstream for its open timeout) still reads
// as "connection lost" and an outage shows steadily.
//
// The line, first match wins: paused; none; errored; socket down; waiting for
// data (retryable error); pending; per-PV disconnected/INVALID (only while
// Hare is up); no data; trigger silent / stale; ok. Suffixes come from the
// current id's latest result frame; the last one is the row rate (rows/s over
// the trailing 10 s of the data clock, stats.ts `rowsPerSecond`) once known.

import {
  AlarmSeverity,
  type FormulaEngineConnectionStatus,
  type FormulaEngineError,
  type HareConnectionStatus,
  type PVData,
  type TableResultDTO,
} from '@slaclab/canopy-client';
import type { CorrelationTrigger } from './query';
import { formatSig } from '../../statistics/evaluate';

/** With fewer than 3 arrivals, silent this long after the first result. */
export const SILENCE_FALLBACK_MS = 10_000;
/** The median rule never fires sooner than this after the last arrival. */
export const SILENCE_MIN_MS = 2_000;
export const SILENCE_MEDIAN_FACTOR = 5;
/** Intervals the median is taken over. */
export const SILENCE_INTERVALS = 100;
/** Timer staleness: 3 × the server's poll interval plus this grace. */
export const STALE_GRACE_MS = 2_000;
export const STALE_INTERVALS = 3;
/** The server's poll floor: Timer mode polls every max(Δt, 500 ms). */
export const MIN_POLL_MS = 500;

/** UI help on the trigger: the Hare broker coalesces live data to 100 ms. */
export const TRIGGER_RATE_HELP =
  'Rows are taken at most 10 times per second: a faster trigger is sampled every 100 ms.';

export type SubscriptionState = 'none' | 'pending' | 'live' | 'errored';

export interface HealthState {
  /** The current subscription id; 0 before the first subscribe. */
  id: number;
  sub: SubscriptionState;
  /** Message of the non-retryable error, while errored. */
  error: string | null;
  /** Message of the retryable error, while it is the current id's newest frame. */
  waiting: string | null;
  status: FormulaEngineConnectionStatus;
  /** The socket has opened at least once. */
  everOpened: boolean;
  /** The socket closed since it last opened. */
  closedSinceOpen: boolean;
  /** Browser time (ms) of the current id's first result. */
  firstResultAt: number | null;
  /** Browser time (ms) of the current id's latest result. */
  lastResultAt: number | null;
  /** Browser times (ms) of the last arrivals, at most SILENCE_INTERVALS + 1. */
  arrivals: number[];
  /** Newest row time seen for the current id. */
  newestTsNs: number | null;
  /** The current id's latest result frame. */
  latest: TableResultDTO | null;
}

export type HealthEvent =
  /** A new Formula Engine service: fresh socket bookkeeping. */
  | { type: 'service'; status: FormulaEngineConnectionStatus }
  | { type: 'status'; status: FormulaEngineConnectionStatus }
  /** No spec can be built. */
  | { type: 'none' }
  | { type: 'subscribe'; id: number }
  | { type: 'result'; id: number; table: TableResultDTO; now: number }
  | { type: 'error'; id: number; error: FormulaEngineError };

export function initialHealth(status: FormulaEngineConnectionStatus = 'idle'): HealthState {
  return {
    id: 0,
    sub: 'none',
    error: null,
    waiting: null,
    status,
    everOpened: false,
    closedSinceOpen: false,
    firstResultAt: null,
    lastResultAt: null,
    arrivals: [],
    newestTsNs: null,
    latest: null,
  };
}

function cleared(state: HealthState, sub: SubscriptionState, id = state.id): HealthState {
  return {
    ...state,
    id,
    sub,
    error: null,
    waiting: null,
    firstResultAt: null,
    lastResultAt: null,
    arrivals: [],
    newestTsNs: null,
    latest: null,
  };
}

function newestOf(table: TableResultDTO): number | null {
  const ts = table.tsNs;
  return ts.length === 0 ? null : ts[ts.length - 1];
}

/** Whether a frame is for the current id and may change its state. */
function accepts(state: HealthState, id: number): boolean {
  return id === state.id && (state.sub === 'pending' || state.sub === 'live');
}

export function reduceHealth(state: HealthState, event: HealthEvent): HealthState {
  switch (event.type) {
    case 'service':
      return { ...state, status: event.status, everOpened: false, closedSinceOpen: false };
    case 'status': {
      if (event.status === state.status) return state;
      if (event.status === 'connected') {
        return {
          ...state,
          status: event.status,
          everOpened: true,
          closedSinceOpen: false,
          sub: state.sub === 'live' ? 'pending' : state.sub,
          waiting: null,
        };
      }
      if (event.status === 'disconnected') {
        return { ...state, status: event.status, closedSinceOpen: true };
      }
      return { ...state, status: event.status };
    }
    case 'none':
      return state.sub === 'none' ? state : cleared(state, 'none');
    case 'subscribe':
      return cleared(state, 'pending', event.id);
    case 'result': {
      if (!accepts(state, event.id)) return state;
      const newest = newestOf(event.table);
      const first = state.firstResultAt === null;
      const advanced = newest !== null && (state.newestTsNs === null || newest > state.newestTsNs);
      const arrivals =
        first || advanced
          ? [...state.arrivals, event.now].slice(-(SILENCE_INTERVALS + 1))
          : state.arrivals;
      return {
        ...state,
        sub: 'live',
        waiting: null,
        firstResultAt: state.firstResultAt ?? event.now,
        lastResultAt: event.now,
        arrivals,
        newestTsNs: advanced ? newest : state.newestTsNs,
        latest: event.table,
      };
    }
    case 'error': {
      if (!accepts(state, event.id)) return state;
      const message = event.error.message !== '' ? event.error.message : event.error.code;
      if (event.error.retryable) return { ...state, waiting: message };
      return { ...state, sub: 'errored', error: message, waiting: null };
    }
  }
}

// ── The line ──────────────────────────────────────────────────────────────

/** What the line needs of the instance's Hare service. */
export interface HealthPVSource {
  readonly status: HareConnectionStatus;
  getSnapshot(pvName: string): PVData | undefined;
}

export interface HealthContext {
  paused: boolean;
  /** The trigger of the current id's spec. */
  trigger: CorrelationTrigger | null;
  /** Binding → PV of the current id's spec. */
  bindingPvs: Record<string, string>;
  pvs: HealthPVSource;
  /** Rows per second of the frame shown (`rowsPerSecond`); null until known. */
  rowsPerS: number | null;
}

export type HealthKind =
  | 'paused'
  | 'none'
  | 'errored'
  | 'connection-lost'
  | 'unreachable'
  | 'waiting'
  | 'connecting'
  | 'pv-disconnected'
  | 'pv-invalid'
  | 'no-data'
  | 'silent'
  | 'stale'
  | 'ok';

export interface HealthLine {
  kind: HealthKind;
  /** The state's text, without suffixes. */
  text: string;
  suffixes: string[];
  /** The line shows a Retry action. */
  retry: boolean;
  /** `text` and the suffixes, as shown. */
  line: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function socketDown(state: HealthState): boolean {
  return (
    state.status === 'disconnected' || (state.status === 'connecting' && state.closedSinceOpen)
  );
}

function rolePvs(ctx: HealthContext): string[] {
  return [...new Set(Object.values(ctx.bindingPvs))];
}

function pvStatus(ctx: HealthContext): [HealthKind, string] | null {
  if (ctx.pvs.status !== 'connected') return null;
  const down: string[] = [];
  const invalid: string[] = [];
  for (const pv of rolePvs(ctx)) {
    const snap = ctx.pvs.getSnapshot(pv);
    if (snap === undefined) continue;
    if (!snap.connected) down.push(pv);
    else if (snap.severity === AlarmSeverity.INVALID) invalid.push(pv);
  }
  if (down.length > 0) return ['pv-disconnected', `disconnected: ${down.join(', ')}`];
  if (invalid.length > 0) return ['pv-invalid', `INVALID: ${invalid.join(', ')}`];
  return null;
}

function pvOf(ctx: HealthContext, binding: string): string {
  return ctx.bindingPvs[binding] ?? binding;
}

type TableInput = TableResultDTO['inputs'][string];

/** The PVs, deduplicated, of the frame's inputs that match `pred`. */
function inputPvs(
  latest: TableResultDTO,
  ctx: HealthContext,
  pred: (input: TableInput) => boolean
): string[] {
  const pvs = Object.entries(latest.inputs)
    .filter(([, input]) => pred(input))
    .map(([binding]) => pvOf(ctx, binding));
  return [...new Set(pvs)];
}

function noData(state: HealthState, ctx: HealthContext): string | null {
  if (state.latest === null) return null;
  const pvs = inputPvs(state.latest, ctx, (i) => i.status === 'no-data');
  return pvs.length === 0 ? null : `no data: ${pvs.join(', ')}`;
}

function timing(state: HealthState, ctx: HealthContext, now: number): HealthKind | null {
  const first = state.firstResultAt;
  if (first === null || ctx.trigger === null) return null;
  if (ctx.trigger.mode === 'timer') {
    const interval = Math.max(ctx.trigger.dtS * 1000, MIN_POLL_MS);
    const last = state.lastResultAt ?? first;
    return now - last > STALE_INTERVALS * interval + STALE_GRACE_MS ? 'stale' : null;
  }
  const arrivals = state.arrivals;
  if (arrivals.length < 3 && now - first >= SILENCE_FALLBACK_MS) return 'silent';
  if (arrivals.length >= 2) {
    const intervals: number[] = [];
    for (let i = 1; i < arrivals.length; i++) intervals.push(arrivals[i] - arrivals[i - 1]);
    const limit = Math.max(SILENCE_MEDIAN_FACTOR * median(intervals), SILENCE_MIN_MS);
    if (now - arrivals[arrivals.length - 1] > limit) return 'silent';
  }
  return null;
}

/** Suffixes of the current id's latest frame, and of a Hare outage. */
export function healthSuffixes(state: HealthState, ctx: HealthContext): string[] {
  const out: string[] = [];
  const latest = state.latest;
  if (latest !== null) {
    const named = (pred: (i: TableInput) => boolean): string[] => inputPvs(latest, ctx, pred);
    for (const pv of named((i) => i.history === 'live-only'))
      out.push(`no archive history for ${pv}`);
    for (const pv of named((i) => i.history === 'not-archived')) out.push(`not archived: ${pv}`);
    for (const pv of named((i) => i.history === 'truncated'))
      out.push(`history truncated for ${pv}`);
    for (const pv of named((i) => i.lateAfterFinal === true)) out.push(`late data for ${pv}`);
    const shown = latest.tsNs.length;
    if (latest.totalRows > shown) out.push(`${shown} of ${latest.totalRows} rows shown`);
  }
  if (state.sub !== 'none' && ctx.pvs.status !== 'connected') out.push('PV status unavailable');
  if (ctx.rowsPerS !== null) out.push(`${formatSig(ctx.rowsPerS)} rows/s`);
  return out;
}

const TEXT: Record<
  Exclude<HealthKind, 'errored' | 'waiting' | 'pv-disconnected' | 'pv-invalid' | 'no-data'>,
  string
> = {
  paused: 'paused',
  none: 'add an X and at least one Y',
  'connection-lost': 'connection lost',
  unreachable: 'cannot reach the Formula Engine',
  connecting: 'connecting…',
  silent: 'trigger silent',
  stale: 'stale',
  ok: 'ok',
};

function main(state: HealthState, ctx: HealthContext, now: number): [HealthKind, string] {
  if (ctx.paused) return ['paused', TEXT.paused];
  if (state.sub === 'none') return ['none', TEXT.none];
  if (state.sub === 'errored') return ['errored', `error: ${state.error ?? ''}`];
  if (socketDown(state)) {
    return state.everOpened
      ? ['connection-lost', TEXT['connection-lost']]
      : ['unreachable', TEXT.unreachable];
  }
  if (state.waiting !== null) return ['waiting', `waiting for data: ${state.waiting}`];
  if (state.sub === 'pending') return ['connecting', TEXT.connecting];
  const pv = pvStatus(ctx);
  if (pv !== null) return pv;
  const missing = noData(state, ctx);
  if (missing !== null) return ['no-data', missing];
  const late = timing(state, ctx, now);
  if (late !== null) return [late, TEXT[late === 'silent' ? 'silent' : 'stale']];
  return ['ok', TEXT.ok];
}

/** The health line at `now` (browser ms). */
export function healthLine(state: HealthState, ctx: HealthContext, now: number): HealthLine {
  const [kind, text] = main(state, ctx, now);
  const suffixes = kind === 'none' ? [] : healthSuffixes(state, ctx);
  return {
    kind,
    text,
    suffixes,
    retry: kind === 'errored',
    line: [text, ...suffixes].join(' · '),
  };
}
