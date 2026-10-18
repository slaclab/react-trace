import { nsToMs, type TimeWindowNs } from '../api/time';
import type { FormulaResultDTO, FormulaSpecDTO } from '../api/types';

// Per-trace formula evaluation state behind useFormulaSeries: one store per
// mounted hook (TraceApp), read through useSyncExternalStore.
//
// Every entry is stamped with the spec it was evaluated for. Trace ids collide
// across workspaces (legacy imports always produce `formula-1`), so a result is
// only ever shown under the spec that produced it: a new spec starts from no
// points, and an unbound spec has no entry at all.
//
// Each Fox evaluation reads every raw sample in the window, so the store asks
// for one only when the window needs it, decided per trace:
// - a window inside the range already evaluated is drawn from what's there
//   (pan, zoom in, and a window following "now" until it drifts past
//   NEAR_NOW_SLACK_MS or 1% of its span), except a zoom into under half of a
//   decimated result, which needs Fox's detail for the narrower window;
// - an in-flight request isn't repeated or aborted when the window only slid
//   forward. Aborting wouldn't save Fox any work: it never cancels an
//   evaluation the client has gone away from;
// - a failure that will recur for the same input waits for a new spec or span;
//   any other failure is retried on a backoff timer, not on every window move.
//
// `evaluate` is injected so the policy can be tested without the network, and
// errors are duck-typed on `{ code, detail, status }` rather than tied to one
// error class.

// ── Policy ───────────────────────────────────────────────────────────────────

// How far a window that tracks "now" may run ahead of the evaluated range
// before it's re-evaluated (or 1% of its span, if larger). Matches the archive
// store's drift interval.
export const NEAR_NOW_SLACK_MS = 2_000;

// Retry schedule for transient failures; the last step repeats. Mirrors
// liveStore's reconnect backoff.
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000];

// Client-side limit on one evaluation. A timeout is treated like a terminal
// error: Fox keeps evaluating after the client gives up, so retrying the same
// window on a timer would re-run the whole evaluation server-side every time
// without ever showing a result. It's retried when the spec or the span changes.
export const EVAL_TIMEOUT_MS = 30_000;
export const CLIENT_TIMEOUT_CODE = 'client_timeout';

export function retryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1];
}

export interface FormulaErrorInfo {
  code: string;
  detail: string;
  status?: number;
}

// Failures the same spec over the same span would hit again: Fox's 400s
// (parse, unsafe, circular reference), its 422s (type, dimension mismatch,
// window too large, request validation) and a client timeout. 422
// formula_input_missing is the exception, as in Fox's own live loop. On this
// REST path it only comes from binned mode, which the client never requests;
// the transient error an unbuffered PV actually produces is 404
// pv_not_buffered. Everything else (5xx, 404, network) is transient.
export function isTerminalError(info: FormulaErrorInfo): boolean {
  if (info.code === CLIENT_TIMEOUT_CODE) return true;
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
  spec: FormulaSpecDTO | null;
  window: TimeWindowNs | null;
}

export type EvaluateFn = (
  spec: FormulaSpecDTO,
  t0Ns: number,
  t1Ns: number,
  signal: AbortSignal
) => Promise<FormulaResultDTO>;

export interface FormulaStoreDeps {
  evaluate: EvaluateFn;
  // Wall clock in ms; injected for tests. Defaults to Date.now.
  now?: () => number;
}

export function specKey(spec: FormulaSpecDTO): string {
  return JSON.stringify(spec);
}

export function formulaErrorInfo(err: unknown): FormulaErrorInfo {
  const e = err as { code?: unknown; detail?: unknown; status?: unknown; message?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  if (typeof e?.code === 'string') {
    return {
      code: e.code,
      detail: typeof e.detail === 'string' ? e.detail : message,
      status: typeof e.status === 'number' ? e.status : undefined,
    };
  }
  return { code: 'unknown_error', detail: message };
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

// The evaluated range `cover` already holds what `win` needs. `decimated` is
// whether Fox thinned that result to its output cap.
function covers(
  cover: TimeWindowNs,
  decimated: boolean,
  win: TimeWindowNs,
  nowNs: number
): boolean {
  const tol = tolerance(win);
  if (cover.fromNs > win.fromNs + tol) return false;
  // Zoomed into under half of a decimated result: the points on hand are too
  // sparse for the narrower window, so ask Fox for its detail.
  if (decimated && spanOf(win) < spanOf(cover) / 2) return false;
  if (cover.toNs >= win.toNs - tol) return true;
  // A window tracking "now" may run ahead by the slack; a historical window
  // (panned into the past, absolute) keeps the plain tolerance.
  const slack = Math.max(tol, NEAR_NOW_SLACK_MS * 1e6);
  return win.toNs >= nowNs - slack && cover.toNs >= win.toNs - slack;
}

function sameWindow(a: TimeWindowNs, b: TimeWindowNs): boolean {
  const tol = tolerance(b);
  return Math.abs(a.fromNs - b.fromNs) <= tol && Math.abs(a.toNs - b.toNs) <= tol;
}

// `win` is `prev` moved forward at the same span, and either still overlaps it
// or has moved no further than the clock since `prev` was sent (a following
// window shorter than Fox's latency). Waiting for that answer keeps one
// evaluation in flight at a time. A jump further than that is a new request.
function forwardSlide(prev: TimeWindowNs, win: TimeWindowNs, elapsedNs: number): boolean {
  const tol = tolerance(win);
  return (
    win.toNs >= prev.toNs &&
    win.fromNs >= prev.fromNs - tol &&
    !spanChanged(spanOf(prev), win) &&
    (win.fromNs < prev.toNs || win.toNs - prev.toNs <= elapsedNs + tol)
  );
}

// ── Store ────────────────────────────────────────────────────────────────────

type Timer = ReturnType<typeof setTimeout>;

interface Failure {
  // isTerminalError(): wait for a new span (a new spec is a new entry).
  terminal: boolean;
  // Consecutive transient failures; drives the backoff step.
  attempts: number;
  // Span of the request that failed.
  spanNs: number;
  info: FormulaErrorInfo;
}

interface Internal {
  spec: FormulaSpecDTO;
  identity: string;
  data: FormulaEntry;
  // Window `data.points` were evaluated over; null until an evaluation under
  // this identity succeeds.
  cover: TimeWindowNs | null;
  // Window of the in-flight request, and when it was sent (ms).
  requested: TimeWindowNs | null;
  startedAtMs: number;
  // Latest window asked for, issued or not. Retries and catch-ups use it.
  wanted: TimeWindowNs;
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
        startedAtMs: 0,
        wanted: req.window,
        controller: null,
        timeoutTimer: null,
        failure: null,
        retryTimer: null,
      };
      this.entries.set(id, entry);
      this.start(id, entry, req.window);
      this.publish();
      return;
    }
    existing.wanted = req.window;
    this.refresh(id, existing, req.window);
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

  // Bring an entry whose identity is unchanged up to date for `win`: evaluate
  // it only if what it has (or is about to get) doesn't serve the window. The
  // current points stay up until a new answer lands.
  private refresh(id: string, entry: Internal, win: TimeWindowNs): void {
    const nowMs = this.now();
    if (entry.controller && entry.requested) {
      // Let an in-flight request land when it was for (nearly) this window or
      // one this window only slid forward from. EVAL_TIMEOUT_MS bounds the wait.
      const elapsedNs = (nowMs - entry.startedAtMs) * 1e6;
      if (sameWindow(entry.requested, win) || forwardSlide(entry.requested, win, elapsedNs)) {
        return;
      }
      // That answer is for a window that's no longer wanted (a pan back, or a
      // window that a failure blocks), and landing would swap in its range.
      this.cancelRequest(entry);
    }
    const failure = entry.failure;
    if (entry.cover && covers(entry.cover, entry.data.decimated, win, nowMs * 1e6)) {
      // What's drawn serves this window, whatever failed for another one. The
      // failure stays on record, so its backoff or terminal span still applies
      // if the window leaves this range again.
      this.showFailure(entry, null);
      return;
    }
    // A terminal failure waits for a new span; a transient one for its retry
    // timer, which re-drives the entry.
    if (failure && (entry.retryTimer || (failure.terminal && !spanChanged(failure.spanNs, win)))) {
      this.showFailure(entry, failure);
      return;
    }
    this.start(id, entry, win);
  }

  // Show `failure` as the entry's status, or 'ready' for null, publishing only
  // if that changes what's shown.
  private showFailure(entry: Internal, failure: Failure | null): void {
    const status = failure ? 'error' : 'ready';
    if (entry.data.status === status && entry.data.error === failure?.info) return;
    entry.data = { ...entry.data, status, error: failure?.info };
    this.publish();
  }

  private start(id: string, entry: Internal, win: TimeWindowNs): void {
    this.cancelRequest(entry);
    this.clearRetry(entry);
    const controller = new AbortController();
    entry.controller = controller;
    entry.requested = win;
    entry.startedAtMs = this.now();
    // Settled here rather than through the aborted fetch's rejection, so a
    // request that ignores its signal still can't hold the entry.
    entry.timeoutTimer = setTimeout(() => {
      if (!this.owns(id, entry, controller)) return;
      this.fail(
        id,
        entry,
        {
          code: CLIENT_TIMEOUT_CODE,
          detail: `No answer from Fox within ${EVAL_TIMEOUT_MS / 1000} s`,
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
        this.refresh(id, entry, entry.wanted);
      },
      (err: unknown) => {
        if (!this.owns(id, entry, controller) || isAbort(err)) return;
        this.fail(id, entry, formulaErrorInfo(err), win);
      }
    );
  }

  private fail(id: string, entry: Internal, info: FormulaErrorInfo, win: TimeWindowNs): void {
    this.finishRequest(entry);
    const terminal = isTerminalError(info);
    const prev = entry.failure;
    const attempts = !terminal && prev && !prev.terminal ? prev.attempts + 1 : 1;
    entry.failure = { terminal, attempts, spanNs: spanOf(win), info };
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
      if (this.entries.get(id) === entry) this.refresh(id, entry, entry.wanted);
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
