import {
  errorInfo as formulaErrorInfo,
  type ErrorInfo as FormulaErrorInfo,
} from '../api/errorInfo';
import { nsToMs, type TimeWindowNs } from '../api/time';
import type { FormulaResultDTO, FormulaSpec } from '@slaclab/canopy-client';
import { RETRY_DELAYS_MS, retryDelayMs } from './retry';

// Per-trace formula evaluation state behind useFormulaSeries: one store per
// mounted hook (TraceApp), read through useSyncExternalStore.
//
// Every entry is stamped with the spec it was evaluated for. Trace ids collide
// across workspaces (legacy imports always produce `formula-1`), so a result is
// only ever shown under the spec that produced it: a new spec starts from no
// points, and an unbound spec has no entry at all.
//
// Each Formula Engine evaluation reads every raw sample in the window, so the store asks
// for one only when the window needs it, decided per trace:
// - a window inside the range already evaluated is drawn from what's there
//   (pan, zoom in, and a window following "now" until it drifts past
//   NEAR_NOW_SLACK_MS or 1% of its span), except a zoom into under half of a
//   decimated result, which needs the Formula Engine's detail for the narrower window;
// - an in-flight request isn't repeated, nor aborted when the window only slid
//   forward from it (still overlapping it, or following "now") unless the
//   evaluated range already serves the window. Aborting wouldn't save the Formula Engine any
//   work: it never cancels an evaluation the client has gone away from;
// - a failure that will recur for the same input waits for a new spec or span;
//   any other failure is retried on a backoff timer, not on every window move.
//   A client timeout is retried too, but only a few times per span.
//
// `evaluate` is injected so the policy can be tested without the network, and
// errors are duck-typed on `{ code, detail, status }` rather than tied to one
// error class.

// ── Policy ───────────────────────────────────────────────────────────────────

// How far a window that reaches "now" may run ahead of the evaluated range
// before it's re-evaluated, and how close to "now" a window must end to count
// as following it (or 1% of its span, if larger). Matches the archive store's
// drift interval.
export const NEAR_NOW_SLACK_MS = 2_000;

// Transient failures are retried on the shared backoff schedule.
export { RETRY_DELAYS_MS, retryDelayMs };

// Client-side limit on one evaluation. One hang may be a brief Formula Engine overload, so
// a timeout is retried, starting at the last backoff step. But the Formula Engine keeps
// evaluating after the client gives up, so each timeout leaves a full
// evaluation running server-side. After MAX_CLIENT_TIMEOUTS at one span (at
// most that many abandoned evaluations per spec and span, about 45 s apart) it's
// terminal for that span, and retried when the spec or the span changes.
export const EVAL_TIMEOUT_MS = 30_000;
export const CLIENT_TIMEOUT_CODE = 'client_timeout';
export const MAX_CLIENT_TIMEOUTS = 3;

// Failures are read with the shared errorInfo(), which keeps the HTTP status
// isTerminalError() needs.
export { formulaErrorInfo, type FormulaErrorInfo };

// Failures the same spec over the same span would hit again: the Formula Engine's 400s
// (parse, unsafe, circular reference) and its 422s (type, dimension mismatch,
// window too large, request validation). 422 formula_input_missing is the
// exception, as in the Formula Engine's own live loop. On this REST path it only comes from
// binned mode, which the client never requests; the transient error an
// unbuffered PV actually produces is 404 pv_not_buffered. Everything else (5xx,
// 404, network, a client timeout) is transient; see MAX_CLIENT_TIMEOUTS for
// when timeouts stop being retried.
export function isTerminalError(info: FormulaErrorInfo): boolean {
  return (info.status === 400 || info.status === 422) && info.code !== 'formula_input_missing';
}

// ── Entries ──────────────────────────────────────────────────────────────────

export interface FormulaEntry {
  // specKey() of the spec `points` belong to.
  identity: string;
  // 'loading' until the first answer for this identity. A re-evaluation under
  // the same identity keeps the previous status and points until it settles.
  status: 'loading' | 'ready' | 'error';
  points: [number, number][];
  decimated: boolean;
  error?: FormulaErrorInfo;
}

export interface FormulaRequest {
  // Null when the formula isn't evaluable (empty or unbound) or has no window.
  spec: FormulaSpec | null;
  window: TimeWindowNs | null;
}

export type EvaluateFn = (
  spec: FormulaSpec,
  t0Ns: number,
  t1Ns: number,
  signal: AbortSignal
) => Promise<FormulaResultDTO>;

export interface FormulaStoreDeps {
  evaluate: EvaluateFn;
  // Wall clock in ms; injected for tests. Defaults to Date.now.
  now?: () => number;
}

export function specKey(spec: FormulaSpec): string {
  return JSON.stringify(spec);
}

function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

function toPoints(res: FormulaResultDTO): [number, number][] {
  const ts = res.timeseries;
  const points: [number, number][] = [];
  if (!ts) return points;
  for (let i = 0; i < ts.tsNs.length; i++) {
    const v = ts.values[i];
    if (v != null && Number.isFinite(v)) points.push([nsToMs(ts.tsNs[i]), v]);
  }
  return points;
}

// ── Window geometry ──────────────────────────────────────────────────────────

const spanOf = (win: TimeWindowNs) => win.toNs - win.fromNs;

// 1% of the requested span: jitter below this isn't worth an evaluation.
function tolerance(win: TimeWindowNs): number {
  return Math.max(1, spanOf(win) * 0.01);
}

function spanChanged(prevSpanNs: number, win: TimeWindowNs): boolean {
  return Math.abs(spanOf(win) - prevSpanNs) > tolerance(win);
}

function nearNowSlack(win: TimeWindowNs): number {
  return Math.max(tolerance(win), NEAR_NOW_SLACK_MS * 1e6);
}

// Both are judged at `askedAtNs`, the time the window was asked for: a retry or
// catch-up runs later than that.
//
// `win` ended no earlier than the slack before "now": a live window, or one
// ending in the future. Coverage gives these the slack.
function reachesNow(win: TimeWindowNs, askedAtNs: number): boolean {
  return win.toNs >= askedAtNs - nearNowSlack(win);
}

// `win` ended at "now", within the slack either way: a live window. Only these
// wait on an in-flight request they no longer overlap.
function followsNow(win: TimeWindowNs, askedAtNs: number): boolean {
  return Math.abs(win.toNs - askedAtNs) <= nearNowSlack(win);
}

// The evaluated range `cover` already holds what `win` needs. `decimated` is
// whether the Formula Engine thinned that result to its output cap.
function covers(
  cover: TimeWindowNs,
  decimated: boolean,
  win: TimeWindowNs,
  askedAtNs: number
): boolean {
  const tol = tolerance(win);
  if (cover.fromNs > win.fromNs + tol) return false;
  // Zoomed into under half of a decimated result: the points on hand are too
  // sparse for the narrower window, so ask the Formula Engine for its detail.
  if (decimated && spanOf(win) < spanOf(cover) / 2) return false;
  if (cover.toNs >= win.toNs - tol) return true;
  // A window reaching "now" may run ahead by the slack; a historical window
  // (panned into the past, absolute) keeps the plain tolerance.
  return reachesNow(win, askedAtNs) && cover.toNs >= win.toNs - nearNowSlack(win);
}

function sameWindow(a: TimeWindowNs, b: TimeWindowNs): boolean {
  const tol = tolerance(b);
  return Math.abs(a.fromNs - b.fromNs) <= tol && Math.abs(a.toNs - b.toNs) <= tol;
}

// `win` is `prev` moved forward at the same span, and either still overlaps it
// or both follow "now" (the same live window, further along because the Formula Engine is
// slower than its span). Waiting for that answer keeps one evaluation in
// flight at a time. Any other jump forward is a new request.
function forwardSlide(
  prev: TimeWindowNs,
  prevFollowedNow: boolean,
  win: TimeWindowNs,
  winFollowsNow: boolean
): boolean {
  return (
    win.toNs >= prev.toNs &&
    win.fromNs >= prev.fromNs - tolerance(win) &&
    !spanChanged(spanOf(prev), win) &&
    (win.fromNs < prev.toNs || (prevFollowedNow && winFollowsNow))
  );
}

// ── Store ────────────────────────────────────────────────────────────────────

type Timer = ReturnType<typeof setTimeout>;

interface Failure {
  // isTerminalError(), or MAX_CLIENT_TIMEOUTS reached: wait for a new span (a
  // new spec is a new entry).
  terminal: boolean;
  // Consecutive transient failures; drives the backoff step.
  attempts: number;
  // Client timeouts at this span since the last success.
  timeouts: number;
  // Span of the request that failed.
  spanNs: number;
  info: FormulaErrorInfo;
}

interface Internal {
  spec: FormulaSpec;
  identity: string;
  data: FormulaEntry;
  // Window `data.points` were evaluated over; null until an evaluation under
  // this identity succeeds.
  cover: TimeWindowNs | null;
  // Window of the in-flight request, and whether it followed "now".
  requested: TimeWindowNs | null;
  requestedFollowedNow: boolean;
  // Latest window asked for (issued or not), and when. Every evaluation is
  // for this window; retries and catch-ups re-read it.
  wanted: TimeWindowNs;
  wantedAtMs: number;
  controller: AbortController | null;
  timeoutTimer: Timer | null;
  failure: Failure | null;
  retryTimer: Timer | null;
}

type Listener = () => void;

export class FormulaStore {
  private readonly evaluate: EvaluateFn;
  private readonly now: () => number;
  private entries = new Map<string, Internal>();
  private snapshot: ReadonlyMap<string, FormulaEntry> = new Map();
  private listeners = new Set<Listener>();

  constructor(deps: FormulaStoreDeps) {
    this.evaluate = deps.evaluate;
    this.now = deps.now ?? (() => Date.now());
  }

  getSnapshot = (): ReadonlyMap<string, FormulaEntry> => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // Ask for trace `id` to show `req.spec` over `req.window`. Cheap to call on
  // every render: a request that needs no evaluation doesn't publish.
  request(id: string, req: FormulaRequest): void {
    if (!req.spec || !req.window) {
      this.release(id);
      return;
    }
    const identity = specKey(req.spec);
    const existing = this.entries.get(id);
    if (!existing || existing.identity !== identity) {
      // New trace, edited spec, or an id reused by a newly loaded workspace:
      // nothing from the previous entry carries over.
      if (existing) this.drop(existing);
      const entry: Internal = {
        spec: req.spec,
        identity,
        data: { identity, status: 'loading', points: [], decimated: false },
        cover: null,
        requested: null,
        requestedFollowedNow: false,
        wanted: req.window,
        wantedAtMs: this.now(),
        controller: null,
        timeoutTimer: null,
        failure: null,
        retryTimer: null,
      };
      this.entries.set(id, entry);
      this.start(id, entry);
      this.publish();
      return;
    }
    existing.wanted = req.window;
    existing.wantedAtMs = this.now();
    this.refresh(id, existing);
  }

  // Forget a trace (deleted, no longer a formula, or not evaluable).
  release(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.drop(entry);
    this.entries.delete(id);
    this.publish();
  }

  // Release every trace not in `ids`.
  retain(ids: ReadonlySet<string>): void {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (ids.has(id)) continue;
      this.drop(entry);
      this.entries.delete(id);
      changed = true;
    }
    if (changed) this.publish();
  }

  // Abort everything and forget all entries, without publishing: this runs in
  // an effect cleanup during teardown (or StrictMode's simulated unmount, whose
  // remount re-requests and publishes). The store stays usable.
  dispose(): void {
    for (const entry of this.entries.values()) this.drop(entry);
    this.entries.clear();
  }

  // Bring an entry whose identity is unchanged up to date for the window it
  // wants: evaluate it only if what it has (or is about to get) doesn't serve
  // that window. The current points stay up until a new answer lands.
  private refresh(id: string, entry: Internal): void {
    const win = entry.wanted;
    const askedAtNs = entry.wantedAtMs * 1e6;
    if (entry.cover && covers(entry.cover, entry.data.decimated, win, askedAtNs)) {
      // What's drawn serves this window, whatever failed for another one. The
      // failure stays on record, so its backoff or terminal span still applies
      // if the window leaves this range again. An in-flight request is for a
      // window the evaluated range didn't serve, so it's no longer wanted, and
      // landing would swap in its range (even one this window slid forward from).
      this.cancelRequest(entry);
      this.showStatus(entry, null);
      return;
    }
    if (entry.controller && entry.requested) {
      // Let an in-flight request land when it was for (nearly) this window or
      // one this window only slid forward from. EVAL_TIMEOUT_MS bounds the wait.
      const winFollowsNow = followsNow(win, askedAtNs);
      const { requested, requestedFollowedNow } = entry;
      if (
        sameWindow(requested, win) ||
        forwardSlide(requested, requestedFollowedNow, win, winFollowsNow)
      ) {
        return;
      }
      // That answer is for a window that's no longer wanted (a pan back past
      // the evaluated range, or a window that a failure blocks), and landing
      // would swap in its range.
      this.cancelRequest(entry);
    }
    // A terminal failure waits for a new span; a transient one for its retry
    // timer, which re-drives the entry.
    const failure = entry.failure;
    if (failure && (entry.retryTimer || (failure.terminal && !spanChanged(failure.spanNs, win)))) {
      this.showStatus(entry, failure);
      return;
    }
    this.start(id, entry);
  }

  // Show `failure` as the entry's status: 'error' with its info, or 'ready'
  // for null. Publishes only if that changes what's shown.
  private showStatus(entry: Internal, failure: Failure | null): void {
    const status = failure ? 'error' : 'ready';
    if (entry.data.status === status && entry.data.error === failure?.info) return;
    entry.data = { ...entry.data, status, error: failure?.info };
    this.publish();
  }

  // Evaluate the window the entry wants.
  private start(id: string, entry: Internal): void {
    this.cancelRequest(entry);
    this.clearRetry(entry);
    const win = entry.wanted;
    const controller = new AbortController();
    entry.controller = controller;
    entry.requested = win;
    // Judged at the time the window was asked for: a retry or catch-up can
    // start well after that.
    entry.requestedFollowedNow = followsNow(win, entry.wantedAtMs * 1e6);
    // Settled here rather than through the aborted fetch's rejection, so a
    // request that ignores its signal still can't hold the entry.
    entry.timeoutTimer = setTimeout(() => {
      if (!this.owns(id, entry, controller)) return;
      this.fail(
        id,
        entry,
        {
          code: CLIENT_TIMEOUT_CODE,
          detail: `No answer from the Formula Engine within ${EVAL_TIMEOUT_MS / 1000} s`,
        },
        win
      );
      controller.abort();
    }, EVAL_TIMEOUT_MS);
    let pending: Promise<FormulaResultDTO>;
    try {
      pending = this.evaluate(entry.spec, win.fromNs, win.toNs, controller.signal);
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      (res) => {
        if (!this.owns(id, entry, controller)) return;
        this.finishRequest(entry);
        entry.data = {
          identity: entry.identity,
          status: 'ready',
          points: toPoints(res),
          decimated: !!res.timeseries?.decimated,
        };
        entry.cover = win;
        entry.failure = null;
        this.publish();
        // The window may have slid on while this was in flight; if nothing
        // else asks again (a frozen or absolute window), catch up now.
        this.refresh(id, entry);
      },
      (err: unknown) => {
        if (!this.owns(id, entry, controller) || isAbort(err)) return;
        this.fail(id, entry, formulaErrorInfo(err), win);
      }
    );
  }

  private fail(id: string, entry: Internal, info: FormulaErrorInfo, win: TimeWindowNs): void {
    this.finishRequest(entry);
    const prev = entry.failure;
    const timedOut = info.code === CLIENT_TIMEOUT_CODE;
    // Timeouts since the last success, counted per span. A request after a
    // terminal failure is for a new span, so it starts over too.
    const priorTimeouts =
      prev && !prev.terminal && !spanChanged(prev.spanNs, win) ? prev.timeouts : 0;
    const timeouts = priorTimeouts + (timedOut ? 1 : 0);
    const terminal = isTerminalError(info) || timeouts >= MAX_CLIENT_TIMEOUTS;
    let attempts = !terminal && prev && !prev.terminal ? prev.attempts + 1 : 1;
    // A timeout already waited EVAL_TIMEOUT_MS on an overloaded Formula Engine: retry it,
    // and anything after it until a success, at the last backoff step.
    if (timedOut) attempts = Math.max(attempts, RETRY_DELAYS_MS.length);
    entry.failure = { terminal, attempts, timeouts, spanNs: spanOf(win), info };
    // Points survive only because the identity is unchanged: they are the
    // last good result for this same spec.
    entry.data = { ...entry.data, status: 'error', error: info };
    if (!terminal) this.scheduleRetry(id, entry, retryDelayMs(attempts));
    this.publish();
  }

  private scheduleRetry(id: string, entry: Internal, delayMs: number): void {
    this.clearRetry(entry);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      if (this.entries.get(id) === entry) this.refresh(id, entry);
    }, delayMs);
  }

  // The settling request is still the current one for a live entry.
  private owns(id: string, entry: Internal, controller: AbortController): boolean {
    return this.entries.get(id) === entry && entry.controller === controller;
  }

  private finishRequest(entry: Internal): void {
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    entry.timeoutTimer = null;
    entry.controller = null;
  }

  private cancelRequest(entry: Internal): void {
    entry.controller?.abort();
    this.finishRequest(entry);
  }

  private clearRetry(entry: Internal): void {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }

  private drop(entry: Internal): void {
    this.cancelRequest(entry);
    this.clearRetry(entry);
  }

  private publish(): void {
    const next = new Map<string, FormulaEntry>();
    for (const [id, entry] of this.entries) next.set(id, entry.data);
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
