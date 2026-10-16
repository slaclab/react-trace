import { fetchData as defaultFetchData } from '../api/mole';
import type { ArchiverDataDTO, BinnedPointDTO, SampleDTO } from '../api/types';
import type { TimeWindowNs } from '../api/time';
import { nsToMs } from '../api/time';

// ── Mode policy ──────────────────────────────────────────────────────────────
//
// Old trace switches between raw and optimized based on requested-window vs.
// archive buffer size (~14400 points). We don't have buffer size from the
// adapter, so use a coarse window-size threshold as a stand-in. Raw for short
// windows (where the user actually wants exact samples), binned for long ones
// (where the appliance's optimized_<N> is the only sensible answer).
const RAW_WINDOW_MS_THRESHOLD = 30 * 60 * 1000; // 30 min
const RAW_MAX_POINTS = 8000;
export const DEFAULT_OPTIMIZED_BINS = 5000;

export interface FetchMode {
  binning?: 'auto';
  maxPoints: number;
}

export function pickFetchMode(windowMs: number, traceBins?: number): FetchMode {
  if (windowMs <= RAW_WINDOW_MS_THRESHOLD) return { maxPoints: RAW_MAX_POINTS };
  return { binning: 'auto', maxPoints: traceBins ?? DEFAULT_OPTIMIZED_BINS };
}

// ── Errors ───────────────────────────────────────────────────────────────────

export interface ArchiveErrorInfo {
  code: string;
  detail: string;
}

// Mole's code for "the archiver doesn't have this PV". It's a property of the
// (pv, archiver) pair, not of the time window, so it's remembered rather than
// retried as the window moves.
export const NOT_ARCHIVED_CODE = 'pv_not_found_in_archiver';

// Retry schedule for every other failure (5xx, timeout, network, auth, ...).
// Mirrors liveStore's reconnect backoff; the last step repeats.
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000];

export function retryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1];
}

/**
 * Pull `{ code, detail }` out of a failed fetch. Duck-typed on the
 * `CanopyError` shape rather than `instanceof`, so it keeps working whichever
 * module the error class comes from.
 */
export function archiveErrorInfo(err: unknown): ArchiveErrorInfo {
  const e = err as { code?: unknown; detail?: unknown; message?: unknown } | null | undefined;
  if (typeof e?.code === 'string' && typeof e.detail === 'string') {
    return { code: e.code, detail: e.detail };
  }
  const message = typeof e?.message === 'string' ? e.message : String(err);
  return { code: 'unknown_error', detail: message };
}

export function isNotArchivedError(info: { code: string }): boolean {
  return info.code === NOT_ARCHIVED_CODE;
}

// ── Buffer model ─────────────────────────────────────────────────────────────

export interface ArchivePlotPoint {
  time: number;
  value: number;
}

export interface ArchiveBandPoint {
  time: number;
  min: number;
  max: number;
}

export type ArchiveStatus = 'loading' | 'ready' | 'error';

export interface ArchiveEntry {
  status: ArchiveStatus;
  // Buffered data. Empty until the first successful fetch. Survives in-flight
  // refetches, so the displayed series never blanks out mid-request.
  mean: ArchivePlotPoint[];
  band: ArchiveBandPoint[];
  // Window the buffer covers, in ns. Pan/zoom inside this is a free render.
  coverFromNs: number;
  coverToNs: number;
  mode: 'raw' | 'binned';
  archiver: string;
  decimated: boolean;
  error?: ArchiveErrorInfo;
}

// Identity of the data: changing pv or archiver means we're now talking about
// a different signal entirely, so the buffer is wiped on transition. Bins and
// mode are *fetch* parameters — different shapes of the same signal — so a
// transition keeps the prior buffer on screen during the refetch and avoids
// flashing back to the mock series.
interface IdentityKey {
  pv: string;
  archiver: string | null; // null → backend default
}

// Full fetch signature: identity + how-we-asked + window. Used for dedup so
// that re-issuing an in-flight or recently-completed request is a no-op.
interface FetchSig extends IdentityKey {
  bins: number;
  mode: 'raw' | 'binned';
}

// Why the last fetch for an entry failed, and when to try again.
interface Failure extends ArchiveErrorInfo {
  // The archiver doesn't have this PV. Sticky: no refetch on window drift.
  notArchived: boolean;
  // Consecutive transient failures; drives the backoff step.
  attempts: number;
  // Transient only: no automatic retry before this wall-clock time (ms).
  retryAtMs: number;
  // Span of the request that failed. A different span (a new time range or a
  // zoom) retries a not-archived entry once.
  spanNs: number;
}

interface InternalEntry {
  identityKey: IdentityKey;
  fetchSig: FetchSig;
  data: ArchiveEntry;
  // Most recently *issued* window. We only fetch when a new request lands
  // outside this (with tolerance). The in-flight promise covers `requestedWindow`.
  // Null for an entry created already knowing the PV isn't archived.
  requestedWindow: TimeWindowNs | null;
  // Most recent request, issued or not. `refetchAll()` re-issues this one so a
  // manual refresh uses the current window, not one from before a long sticky
  // or backoff stretch.
  wanted: RequestOpts;
  controller: AbortController | null;
  failure: Failure | null;
}

export interface RequestOpts {
  pv: string;
  archiver: string | undefined;
  bins?: number;
  window: TimeWindowNs;
}

export type FetchDataFn = typeof defaultFetchData;

export interface ArchiveStoreDeps {
  fetchData?: FetchDataFn;
  // Wall clock in ms. Injected so tests can drive backoff deterministically.
  now?: () => number;
}

// ── Coverage ─────────────────────────────────────────────────────────────────

function coverageTolerance(win: TimeWindowNs): number {
  // 1% of the requested span — matches the jitter threshold the previous
  // viewport-debounce had, but applied to "do we already have this data?"
  return Math.max(1, (win.toNs - win.fromNs) * 0.01);
}

function covers(entry: InternalEntry, win: TimeWindowNs): boolean {
  if (entry.data.mean.length === 0) return false;
  const tol = coverageTolerance(win);
  return entry.data.coverFromNs <= win.fromNs + tol && entry.data.coverToNs >= win.toNs - tol;
}

// True when we've already issued a request for this window (in flight or
// completed). Suppresses duplicate requests across renders — the
// render → publish → render loop, and StrictMode's double effect. Errors are
// handled separately by `Failure` (sticky not-archived, backoff otherwise), so
// this check doesn't have to stop error loops and is skipped once a failed
// entry is due for a retry.
function recentlyRequested(entry: InternalEntry, win: TimeWindowNs): boolean {
  if (!entry.requestedWindow) return false;
  const tol = coverageTolerance(win);
  return (
    Math.abs(entry.requestedWindow.fromNs - win.fromNs) <= tol &&
    Math.abs(entry.requestedWindow.toNs - win.toNs) <= tol
  );
}

function spanChanged(prevSpanNs: number, win: TimeWindowNs): boolean {
  return Math.abs(win.toNs - win.fromNs - prevSpanNs) > coverageTolerance(win);
}

function identityEqual(a: IdentityKey, b: IdentityKey): boolean {
  return a.pv === b.pv && a.archiver === b.archiver;
}

function fetchSigEqual(a: FetchSig, b: FetchSig): boolean {
  return identityEqual(a, b) && a.bins === b.bins && a.mode === b.mode;
}

function registryKey(pv: string, archiver: string | null | undefined): string {
  return `${pv}\u0000${archiver ?? ''}`;
}

interface ResolvedRequest {
  identityKey: IdentityKey;
  fetchSig: FetchSig;
  mode: FetchMode;
  key: string;
  spanNs: number;
}

function resolveRequest(opts: RequestOpts): ResolvedRequest {
  const spanNs = opts.window.toNs - opts.window.fromNs;
  const mode = pickFetchMode(spanNs / 1_000_000, opts.bins);
  const identityKey: IdentityKey = { pv: opts.pv, archiver: opts.archiver ?? null };
  const fetchSig: FetchSig = {
    ...identityKey,
    bins: mode.maxPoints,
    mode: mode.binning === 'auto' ? 'binned' : 'raw',
  };
  return { identityKey, fetchSig, mode, key: registryKey(opts.pv, opts.archiver), spanNs };
}

function notArchivedFailure(info: ArchiveErrorInfo, spanNs: number): Failure {
  return {
    code: info.code,
    detail: info.detail,
    notArchived: true,
    attempts: 0,
    retryAtMs: 0,
    spanNs,
  };
}

function dtoToData(
  dto: ArchiverDataDTO,
  mode: 'raw' | 'binned',
  window: TimeWindowNs
): ArchiveEntry {
  if (dto.mode === 'raw') {
    const mean: ArchivePlotPoint[] = [];
    for (const s of dto.samples as SampleDTO[]) {
      if (typeof s.value === 'number') mean.push({ time: nsToMs(s.tsNs), value: s.value });
    }
    return {
      status: 'ready',
      mean,
      band: [],
      coverFromNs: window.fromNs,
      coverToNs: window.toNs,
      mode: 'raw',
      archiver: dto.archiver,
      decimated: dto.decimated,
    };
  }
  const mean: ArchivePlotPoint[] = [];
  const band: ArchiveBandPoint[] = [];
  for (const p of dto.points as BinnedPointDTO[]) {
    const t = nsToMs(p.tsNs);
    mean.push({ time: t, value: p.mean });
    band.push({ time: t, min: p.min, max: p.max });
  }
  return {
    status: 'ready',
    mean,
    band,
    coverFromNs: window.fromNs,
    coverToNs: window.toNs,
    mode,
    archiver: dto.archiver,
    decimated: false,
  };
}

// ── Store ────────────────────────────────────────────────────────────────────

type Listener = () => void;

export class ArchiveStore {
  private entries = new Map<string, InternalEntry>();
  private snapshot: ReadonlyMap<string, ArchiveEntry> = new Map();
  private listeners = new Set<Listener>();
  // (pv, archiver) pairs the archiver reported it doesn't have. Shared by
  // every trace and by the Data Insight Tool, so one 404 answers them all.
  // Survives `release()`; cleared by `refetchAll()`, `forgetNotArchived()`, or
  // a later successful fetch of the same pair.
  private notArchived = new Map<string, ArchiveErrorInfo>();
  private readonly fetchData: FetchDataFn;
  private readonly now: () => number;

  constructor(deps: ArchiveStoreDeps = {}) {
    this.fetchData =
      deps.fetchData ?? ((pv, params, signal) => defaultFetchData(pv, params, signal));
    this.now = deps.now ?? (() => Date.now());
  }

  getSnapshot = (): ReadonlyMap<string, ArchiveEntry> => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * What the archiver said when it reported (pv, archiver) as not archived, or
   * undefined. The returned object is stable while the verdict stands, so it
   * works as a `useSyncExternalStore` snapshot.
   */
  getNotArchived(pv: string, archiver: string | undefined): ArchiveErrorInfo | undefined {
    return this.notArchived.get(registryKey(pv, archiver));
  }

  /** Record that the archiver doesn't have (pv, archiver). No-op if already known. */
  markNotArchived(pv: string, archiver: string | undefined, info: ArchiveErrorInfo): void {
    if (this.setNotArchived(registryKey(pv, archiver), info)) this.publish();
  }

  /** Forget a not-archived verdict so the next request asks the archiver again. */
  forgetNotArchived(pv: string, archiver: string | undefined): void {
    if (this.notArchived.delete(registryKey(pv, archiver))) this.publish();
  }

  release(traceId: string): void {
    const entry = this.entries.get(traceId);
    if (!entry) return;
    entry.controller?.abort();
    this.entries.delete(traceId);
    this.publish();
  }

  /**
   * Force a fresh fetch of every trace, bypassing the coverage / dedup /
   * not-archived / backoff checks that `request()` uses. This is the manual
   * "Refresh archive data" action, so it also forgets every not-archived
   * verdict. The prior buffer stays on screen while the refetch is in flight
   * (status flips to 'loading'), so the plot never blanks. Re-issues each
   * entry's most recent request (same pv, archiver, bins, window).
   */
  refetchAll(): void {
    const hadVerdicts = this.notArchived.size > 0;
    this.notArchived.clear();
    for (const [traceId, entry] of this.entries) {
      entry.controller?.abort();

      const opts = entry.wanted;
      const { fetchSig, mode } = resolveRequest(opts);
      const controller = new AbortController();
      entry.fetchSig = fetchSig;
      entry.requestedWindow = opts.window;
      entry.controller = controller;
      entry.failure = null;
      entry.data = { ...entry.data, status: 'loading', error: undefined };

      void this.runFetch(traceId, opts, fetchSig.mode, mode, controller);
    }
    if (this.entries.size > 0 || hadVerdicts) this.publish();
  }

  /**
   * Ask for the buffer for `traceId` to cover `window`.
   *
   * - Identity change (pv/archiver) wipes the buffer — different signal, nothing
   *   to keep showing.
   * - The archiver doesn't have this (pv, archiver): no fetch, whatever the
   *   window does. Asked again once when the span changes (a new time range or
   *   a zoom), or after `refetchAll()` / `forgetNotArchived()`.
   * - Same identity, same fetch signature, buffer already covers the window:
   *   free render, no fetch.
   * - Last fetch failed for another reason: no fetch until its backoff expires.
   * - Same identity, fetch signature or window changed: keep the prior buffer
   *   on screen, flip status to 'loading', fire a new fetch. Mode flips
   *   (binned ↔ raw) live in this branch — they refetch but don't wipe, so
   *   wheel-zooming across the threshold doesn't flash.
   * - In-flight or recently-completed request for this exact (sig, window):
   *   no-op (dedup).
   *
   * Every no-fetch path returns before touching status, and a retry of a
   * failed entry keeps showing the failure, so a trace that isn't archived (or
   * is backing off) doesn't flicker back to 'loading'.
   */
  request(traceId: string, opts: RequestOpts): void {
    const { identityKey, fetchSig, mode, key, spanNs } = resolveRequest(opts);
    const known = this.notArchived.get(key);

    const existing = this.entries.get(traceId);
    const sameIdentity = !!existing && identityEqual(existing.identityKey, identityKey);

    if (existing && sameIdentity) {
      existing.wanted = opts;
      const failure = existing.failure;

      if (known) {
        if (failure?.notArchived) {
          // Sticky: window drift, bins and raw/binned flips don't change the
          // verdict. A new span does: fall through and ask once more.
          if (!spanChanged(failure.spanNs, opts.window)) return;
        } else if (existing.controller) {
          // A fetch is in flight; its answer settles it.
          return;
        } else {
          // Another trace or the Data Insight Tool learned it first: adopt the
          // verdict instead of sending our own 404.
          existing.fetchSig = fetchSig;
          existing.failure = notArchivedFailure(known, spanNs);
          existing.data = { ...existing.data, status: 'error', error: { ...known } };
          this.publish();
          return;
        }
      }

      if (fetchSigEqual(existing.fetchSig, fetchSig) && covers(existing, opts.window)) {
        if (existing.data.status !== 'ready') {
          existing.data = { ...existing.data, status: 'ready', error: undefined };
          this.publish();
        }
        return;
      }

      // Transient failure: wait out the backoff regardless of window drift.
      if (failure && !failure.notArchived && this.now() < failure.retryAtMs) return;

      // Already requested this window under the same fetch signature (in
      // flight or completed). Don't refire — the render → publish → render loop
      // would pile up requests. A failed entry with nothing in flight got past
      // the gates above, so it's due for a retry: skip the dedup for it, or a
      // trace whose window never moves could never retry.
      const dueRetry = !!failure && !existing.controller;
      if (
        !dueRetry &&
        fetchSigEqual(existing.fetchSig, fetchSig) &&
        recentlyRequested(existing, opts.window)
      ) {
        return;
      }
    } else if (known) {
      // New trace (or new identity) for a pair already known not to be
      // archived: show that straight away, no fetch.
      existing?.controller?.abort();
      this.entries.set(traceId, {
        identityKey,
        fetchSig,
        data: {
          status: 'error',
          mean: [],
          band: [],
          coverFromNs: opts.window.fromNs,
          coverToNs: opts.window.toNs,
          mode: fetchSig.mode,
          archiver: '',
          decimated: false,
          error: { ...known },
        },
        requestedWindow: null,
        wanted: opts,
        controller: null,
        failure: notArchivedFailure(known, spanNs),
      });
      this.publish();
      return;
    }

    if (existing) existing.controller?.abort();

    const prevData = sameIdentity ? existing!.data : undefined;
    // Retrying a failed entry keeps showing the failure until the answer
    // arrives, so the status chip doesn't blink through 'loading'.
    const retrying = sameIdentity && !!existing!.failure;

    const controller = new AbortController();
    const entry: InternalEntry = {
      identityKey,
      fetchSig,
      data: retrying
        ? prevData!
        : {
            status: 'loading',
            // Keep last good buffer on screen while we refetch under the same
            // identity. Identity changes (pv / archiver) wipe to empty.
            mean: prevData?.mean ?? [],
            band: prevData?.band ?? [],
            coverFromNs: prevData?.coverFromNs ?? opts.window.fromNs,
            coverToNs: prevData?.coverToNs ?? opts.window.toNs,
            mode: fetchSig.mode,
            archiver: prevData?.archiver ?? '',
            decimated: prevData?.decimated ?? false,
          },
      requestedWindow: opts.window,
      wanted: opts,
      controller,
      failure: sameIdentity ? existing!.failure : null,
    };
    this.entries.set(traceId, entry);
    if (!retrying) this.publish();

    void this.runFetch(traceId, opts, fetchSig.mode, mode, controller);
  }

  private async runFetch(
    traceId: string,
    opts: RequestOpts,
    resolvedMode: 'raw' | 'binned',
    mode: FetchMode,
    controller: AbortController
  ): Promise<void> {
    const key = registryKey(opts.pv, opts.archiver);
    try {
      const dto = await this.fetchData(
        opts.pv,
        {
          fromNs: opts.window.fromNs,
          toNs: opts.window.toNs,
          archiver: opts.archiver,
          binning: mode.binning,
          maxPoints: mode.maxPoints,
        },
        controller.signal
      );

      const cur = this.entries.get(traceId);
      // Bail if the trace was released or superseded mid-flight.
      if (!cur || cur.controller !== controller) return;
      cur.data = dtoToData(dto, resolvedMode, opts.window);
      cur.controller = null;
      cur.failure = null;
      // The archiver has this pair after all (e.g. archiving started since).
      this.notArchived.delete(key);
      this.publish();
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      const cur = this.entries.get(traceId);
      if (!cur || cur.controller !== controller) return;
      const info = archiveErrorInfo(err);
      const spanNs = opts.window.toNs - opts.window.fromNs;
      if (isNotArchivedError(info)) {
        cur.failure = notArchivedFailure(info, spanNs);
        this.setNotArchived(key, info);
      } else {
        const attempts = (cur.failure && !cur.failure.notArchived ? cur.failure.attempts : 0) + 1;
        cur.failure = {
          ...info,
          notArchived: false,
          attempts,
          retryAtMs: this.now() + retryDelayMs(attempts),
          spanNs,
        };
      }
      cur.data = { ...cur.data, status: 'error', error: info };
      cur.controller = null;
      this.publish();
    }
  }

  // True when the registry changed (the caller publishes).
  private setNotArchived(key: string, info: ArchiveErrorInfo): boolean {
    if (this.notArchived.has(key)) return false;
    this.notArchived.set(key, { code: info.code, detail: info.detail });
    return true;
  }

  private publish(): void {
    const next = new Map<string, ArchiveEntry>();
    for (const [id, entry] of this.entries) next.set(id, entry.data);
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export const archiveStore = new ArchiveStore();
