import { fetchData as defaultFetchData } from '../api/mole';
import type { AlarmSeverity, ArchiverDataDTO, BinnedPointDTO, SampleDTO } from '../api/types';
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

// A window that tracks "now" refetches its newest part at most this often,
// however fast it advances (every live batch, or a smoothly scrolling strip
// tool). With Live on, the live buffer already covers those last seconds.
export const DRIFT_MIN_INTERVAL_MS = 2_000;
// A tail fetch re-reads this much of the buffered window, so samples the
// archiver writes late (after the previous fetch) aren't lost.
export const TAIL_OVERLAP_MS = 10_000;
// Bins are sized for the window they were fetched for. Zooming into a binned
// buffer shows fewer and fewer of them, so once the window is shorter than
// this share of the fetched span (bins at most 2x too coarse), refetch it.
export const ZOOM_REFETCH_RATIO = 0.5;

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

// `severity` is per sample (raw) or per bin (binned). PlotArea breaks the line
// at INVALID points. Mole currently reports every bin as NO_ALARM.
export interface ArchivePlotPoint {
  time: number;
  value: number;
  severity: AlarmSeverity;
}

export interface ArchiveBandPoint {
  time: number;
  min: number;
  max: number;
  severity: AlarmSeverity;
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
  // Transient only: retried at this wall-clock time (ms), by a timer or by
  // the first request() after it.
  retryAtMs: number;
  // Span of the request that failed. A different span (a new time range or a
  // zoom) retries a not-archived entry once.
  spanNs: number;
  // Transient only: this failure came from asking again, after a span change,
  // about a pair with a not-archived verdict. It's newer than the verdict, so
  // the entry keeps retrying instead of adopting it.
  revalidating: boolean;
}

interface InternalEntry {
  identityKey: IdentityKey;
  fetchSig: FetchSig;
  data: ArchiveEntry;
  // Most recently *issued* window. We only fetch when a new request lands
  // outside this (with tolerance). The in-flight promise covers `requestedWindow`.
  // Null for an entry created already knowing the PV isn't archived, and when
  // the window comes back inside the buffer after a fetch for another window:
  // one in flight that wouldn't cover it is cancelled, a failed one's backoff
  // is dropped.
  requestedWindow: TimeWindowNs | null;
  // Most recent request, issued or not, and when it was asked for (wall clock,
  // ms). `refetchAll()` re-issues this one so a manual refresh uses the current
  // window, not one from before a long sticky or backoff stretch. Retries and
  // catch-ups re-issue it later than `wantedAtMs`.
  wanted: RequestOpts;
  wantedAtMs: number;
  // The in-flight request's window followed "now", judged when it was asked
  // for (see forwardSlide).
  requestedFollowedNow: boolean;
  controller: AbortController | null;
  failure: Failure | null;
  // Signature of the fetch the buffer came from. Set once a fetch under this
  // identity succeeds, so `data.cover*` is real coverage: an archived PV with
  // no samples in the window is covered and empty, one never loaded is null.
  // `fetchSig` moves to a new request as soon as it's issued while the buffer
  // stays on screen, so only a buffer with the same signature counts as cover.
  coverSig: FetchSig | null;
  // Pending retry of `wanted` after a transient failure (see scheduleRetry).
  retryTimer: ReturnType<typeof setTimeout> | null;
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

// How far a window tracking "now" may drift: DRIFT_MIN_INTERVAL_MS, or 1% of
// the span if that's longer.
function driftSlack(win: TimeWindowNs): number {
  return Math.max(coverageTolerance(win), DRIFT_MIN_INTERVAL_MS * 1_000_000);
}

// `win` ended at "now" (`atNs`, when it was asked for), within the slack
// either way: a live window. One ending further in the future doesn't count.
function followsNow(win: TimeWindowNs, atNs: number): boolean {
  return Math.abs(win.toNs - atNs) <= driftSlack(win);
}

// The buffer was fetched under the current signature: a binned buffer kept on
// screen while a raw fetch is pending (or the reverse) doesn't count.
function bufferMatches(entry: InternalEntry): boolean {
  return !!entry.coverSig && fetchSigEqual(entry.coverSig, entry.fetchSig);
}

function covers(entry: InternalEntry, win: TimeWindowNs, nowNs: number): boolean {
  if (!bufferMatches(entry)) return false;
  const cover = { fromNs: entry.data.coverFromNs, toNs: entry.data.coverToNs };
  return coverDraws(cover, entry.fetchSig.mode, win, nowNs);
}

// Whether a buffer fetched in `mode` and covering `cover` can draw `win`.
function coverDraws(
  cover: TimeWindowNs,
  mode: 'raw' | 'binned',
  win: TimeWindowNs,
  nowNs: number
): boolean {
  // Zoomed into a binned buffer: the bins are too coarse for this window. (A
  // binned buffer covers exactly the window its bins were fetched for.)
  if (
    mode === 'binned' &&
    win.toNs - win.fromNs < (cover.toNs - cover.fromNs) * ZOOM_REFETCH_RATIO
  ) {
    return false;
  }
  const tol = coverageTolerance(win);
  if (cover.fromNs > win.fromNs + tol) return false;
  if (cover.toNs >= win.toNs - tol) return true;
  // A window tracking "now" can be behind by up to DRIFT_MIN_INTERVAL_MS
  // before it's worth asking the archiver for the newest part. Historical
  // windows (panned into the past) keep the plain tolerance.
  const slack = driftSlack(win);
  return win.toNs >= nowNs - slack && cover.toNs >= win.toNs - slack;
}

// When the buffer covers the start of `win` and only the end is new (a window
// sliding forward with "now"), the range to fetch: the new part plus
// TAIL_OVERLAP_MS of what's buffered. Null when a full fetch is needed: binned
// mode (bins are relative to the whole window), a decimated buffer (a sparse
// tail would mix densities), a buffer fetched under another signature, after
// a failure, or when the gap is over half the span.
function tailRange(entry: InternalEntry, win: TimeWindowNs): TimeWindowNs | null {
  if (
    !bufferMatches(entry) ||
    entry.failure ||
    entry.fetchSig.mode !== 'raw' ||
    entry.data.decimated
  ) {
    return null;
  }
  const { coverFromNs, coverToNs } = entry.data;
  if (coverFromNs > win.fromNs + coverageTolerance(win)) return null;
  if (win.toNs <= coverToNs) return null;
  if (win.toNs - coverToNs > (win.toNs - win.fromNs) / 2) return null;
  return {
    fromNs: Math.max(win.fromNs, coverToNs - TAIL_OVERLAP_MS * 1_000_000),
    toNs: win.toNs,
  };
}

// `win` is `prev` moved forward at the same span, and either still overlaps it
// or both follow "now" (the same live window, further along because the
// archiver is slower than the span). Let the in-flight request for `prev`
// finish instead of aborting it: aborting on every small advance could starve
// the archive at short spans (a new request every few tens of ms, each
// cancelled before the archiver answers). Any other jump forward is a new
// request, so its window isn't left showing the old one's data meanwhile.
function forwardSlide(
  prev: TimeWindowNs,
  prevFollowedNow: boolean,
  win: TimeWindowNs,
  winFollowsNow: boolean
): boolean {
  return (
    win.toNs >= prev.toNs &&
    win.fromNs >= prev.fromNs - coverageTolerance(win) &&
    !spanChanged(prev.toNs - prev.fromNs, win) &&
    (win.fromNs < prev.toNs || (prevFollowedNow && winFollowsNow))
  );
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
    revalidating: false,
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
      if (typeof s.value === 'number') {
        mean.push({ time: nsToMs(s.tsNs), value: s.value, severity: s.severity });
      }
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
    mean.push({ time: t, value: p.mean, severity: p.severity });
    band.push({ time: t, min: p.min, max: p.max, severity: p.severity });
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

// Merge a tail fetch into the buffer: keep buffered points before the tail
// (from the window start on), then the fetched samples. Coverage becomes
// [window start, window end].
function spliceTail(
  prev: ArchiveEntry,
  dto: ArchiverDataDTO,
  tail: TimeWindowNs,
  window: TimeWindowNs
): ArchiveEntry {
  if (dto.mode !== 'raw') return dtoToData(dto, 'binned', window);
  const fromMs = nsToMs(window.fromNs);
  const tailFromMs = nsToMs(tail.fromNs);
  const mean: ArchivePlotPoint[] = [];
  for (const p of prev.mean) {
    if (p.time >= tailFromMs) break;
    if (p.time >= fromMs) mean.push(p);
  }
  for (const s of dto.samples as SampleDTO[]) {
    if (typeof s.value !== 'number') continue;
    const time = nsToMs(s.tsNs);
    if (time >= tailFromMs) mean.push({ time, value: s.value, severity: s.severity });
  }
  return {
    status: 'ready',
    mean,
    band: [],
    coverFromNs: Math.max(prev.coverFromNs, window.fromNs),
    coverToNs: window.toNs,
    mode: 'raw',
    archiver: dto.archiver,
    decimated: prev.decimated || dto.decimated,
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
    this.clearRetry(entry);
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
      this.clearRetry(entry);

      const opts = entry.wanted;
      const { fetchSig, mode } = resolveRequest(opts);
      const controller = new AbortController();
      entry.fetchSig = fetchSig;
      entry.requestedWindow = opts.window;
      entry.requestedFollowedNow = followsNow(opts.window, entry.wantedAtMs * 1_000_000);
      entry.controller = controller;
      entry.failure = null;
      entry.data = { ...entry.data, status: 'loading', error: undefined };

      void this.runFetch(traceId, opts, fetchSig.mode, mode, controller, null);
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
   *   a zoom), or after `refetchAll()` / `forgetNotArchived()`. If asking
   *   again fails some other way (a 503, a timeout), it backs off and retries
   *   until the archiver answers.
   * - Same identity, same fetch signature, buffer already covers the window:
   *   free render, no fetch. A window tracking "now" counts as covered until
   *   it's DRIFT_MIN_INTERVAL_MS (or 1% of the span, if longer) ahead. A zoom
   *   into a binned buffer past ZOOM_REFETCH_RATIO isn't covered: it refetches
   *   with the coarse buffer still on screen and status 'ready'. Coming back
   *   inside the buffer (zooming back out, panning back) cancels a fetch still
   *   in flight for a window that doesn't cover this one. A buffer kept on
   *   screen while a fetch under another signature is pending (binned ↔ raw)
   *   covers nothing; a window inside the pending one waits for its answer.
   * - Window slid forward past the buffer (raw mode): fetch only the new tail
   *   (plus TAIL_OVERLAP_MS) and splice it in, keeping status 'ready'. If that
   *   would take the buffer past the raw point budget, the whole window is
   *   fetched again instead and the archiver decimates it. An
   *   in-flight fetch isn't aborted for a forward slide that still overlaps
   *   it, or when both windows follow "now"; once it lands, the rest of the
   *   latest window is fetched. A jump forward past it aborts it.
   * - Last fetch failed for another reason: no fetch until its backoff expires.
   *   Then a timer retries the latest request, so a window that never moves
   *   retries too.
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
    this.requestAt(traceId, opts, this.now());
  }

  // `request()` for a window asked for at `askedAtMs`. A retry or catch-up
  // re-issues the latest window later than that, and passes its original time
  // so a live window still counts as following "now".
  private requestAt(traceId: string, opts: RequestOpts, askedAtMs: number): void {
    const { identityKey, fetchSig, mode, key, spanNs } = resolveRequest(opts);
    const known = this.notArchived.get(key);

    const existing = this.entries.get(traceId);
    const sameIdentity = !!existing && identityEqual(existing.identityKey, identityKey);

    if (existing && sameIdentity) {
      existing.wanted = opts;
      existing.wantedAtMs = askedAtMs;
      const failure = existing.failure;

      if (known) {
        if (failure?.notArchived) {
          // Sticky: window drift, bins and raw/binned flips don't change the
          // verdict. A new span does: fall through and ask once more.
          if (!spanChanged(failure.spanNs, opts.window)) return;
        } else if (existing.controller) {
          // A fetch is in flight; its answer settles it.
          return;
        } else if (!failure?.revalidating) {
          // Another trace or the Data Insight Tool learned it first: adopt the
          // verdict instead of sending our own 404.
          this.clearRetry(existing);
          existing.fetchSig = fetchSig;
          existing.failure = notArchivedFailure(known, spanNs);
          existing.data = { ...existing.data, status: 'error', error: { ...known } };
          this.publish();
          return;
        }
        // Otherwise this entry asked again after the verdict and got a
        // transient failure, which is newer: back off and retry below.
      }

      const sameSig = fetchSigEqual(existing.fetchSig, fetchSig);
      const nowNs = this.now() * 1_000_000;
      if (sameSig && covers(existing, opts.window, nowNs)) {
        // Back on the buffer, so the transient failure is behind us: drop its
        // backoff, or it would hold up the next uncovered window. A failed
        // re-ask after a verdict stays, so the verdict isn't adopted over it.
        if (failure && !failure.revalidating) {
          this.clearRetry(existing);
          existing.failure = null;
          // Forget the window that failed too, or asking for it again would be
          // taken for a request already answered. A retry still in flight
          // keeps its window: the check below needs it.
          if (!existing.controller) existing.requestedWindow = null;
        }
        // Back inside the buffer (zoomed back out, or panned back) before the
        // fetch for the window in between answered. Its answer would replace
        // the buffer on screen, so cancel it unless it covers this window too,
        // and forget its window so asking for it again fetches.
        if (
          existing.controller &&
          existing.requestedWindow &&
          !coverDraws(existing.requestedWindow, fetchSig.mode, opts.window, nowNs)
        ) {
          existing.controller.abort();
          existing.controller = null;
          existing.requestedWindow = null;
        }
        if (existing.data.status !== 'ready') {
          existing.data = { ...existing.data, status: 'ready', error: undefined };
          this.publish();
        }
        return;
      }

      // Transient failure: wait out the backoff regardless of window drift.
      if (failure && !failure.notArchived && this.now() < failure.retryAtMs) return;

      // A fetch is in flight and the window only slid forward from it, or its
      // answer will draw this window too (a zoom into it while the buffer on
      // screen is from another signature): let it land. Its answer re-asks for
      // the latest window.
      if (
        sameSig &&
        existing.controller &&
        existing.requestedWindow &&
        (forwardSlide(
          existing.requestedWindow,
          existing.requestedFollowedNow,
          opts.window,
          followsNow(opts.window, askedAtMs * 1_000_000)
        ) ||
          coverDraws(existing.requestedWindow, fetchSig.mode, opts.window, nowNs))
      ) {
        return;
      }

      // Already requested this window under the same fetch signature (in
      // flight or completed). Don't refire — the render → publish → render loop
      // would pile up requests. A failed entry with nothing in flight got past
      // the gates above, so it's due for a retry: skip the dedup for it, or a
      // trace whose window never moves could never retry.
      const dueRetry = !!failure && !existing.controller;
      if (!dueRetry && sameSig && recentlyRequested(existing, opts.window)) return;
    } else if (known) {
      // New trace (or new identity) for a pair already known not to be
      // archived: show that straight away, no fetch.
      if (existing) {
        existing.controller?.abort();
        this.clearRetry(existing);
      }
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
        wantedAtMs: askedAtMs,
        requestedFollowedNow: false,
        controller: null,
        failure: notArchivedFailure(known, spanNs),
        coverSig: null,
        retryTimer: null,
      });
      this.publish();
      return;
    }

    if (existing) {
      existing.controller?.abort();
      this.clearRetry(existing);
    }

    const prevData = sameIdentity ? existing!.data : undefined;
    const sigUnchanged = sameIdentity && fetchSigEqual(existing!.fetchSig, fetchSig);
    // Keep the current status while the request is in flight when it's a
    // retry of a failed entry (show the failure until the answer arrives) or a
    // background refresh of a loaded one (the window moved). Either way the
    // status chip doesn't blink through 'loading'.
    const keepShowing =
      sameIdentity && (!!existing!.failure || (sigUnchanged && existing!.data.status === 'ready'));
    // Only the newest part is missing: fetch just that.
    const tail = sigUnchanged ? tailRange(existing!, opts.window) : null;

    const controller = new AbortController();
    const entry: InternalEntry = {
      identityKey,
      fetchSig,
      data: keepShowing
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
      wantedAtMs: askedAtMs,
      requestedFollowedNow: followsNow(opts.window, askedAtMs * 1_000_000),
      controller,
      failure: sameIdentity ? existing!.failure : null,
      coverSig: sameIdentity ? existing!.coverSig : null,
      retryTimer: null,
    };
    this.entries.set(traceId, entry);
    if (!keepShowing) this.publish();

    void this.runFetch(traceId, opts, fetchSig.mode, mode, controller, tail);
  }

  private async runFetch(
    traceId: string,
    opts: RequestOpts,
    resolvedMode: 'raw' | 'binned',
    mode: FetchMode,
    controller: AbortController,
    // Set for a tail-only fetch; the result is spliced into the buffer.
    tail: TimeWindowNs | null
  ): Promise<void> {
    const key = registryKey(opts.pv, opts.archiver);
    const range = tail ?? opts.window;
    try {
      const dto = await this.fetchData(
        opts.pv,
        {
          fromNs: range.fromNs,
          toNs: range.toNs,
          archiver: opts.archiver,
          binning: mode.binning,
          maxPoints: mode.maxPoints,
        },
        controller.signal
      );

      const cur = this.entries.get(traceId);
      // Bail if the trace was released or superseded mid-flight.
      if (!cur || cur.controller !== controller) return;
      // The archiver has this pair after all (e.g. archiving started since).
      const forgot = this.notArchived.delete(key);
      const data = tail
        ? spliceTail(cur.data, dto, tail, opts.window)
        : dtoToData(dto, resolvedMode, opts.window);
      if (tail && data.mean.length > mode.maxPoints) {
        // The tail would take the buffer past the raw point budget (the PV
        // got busier since the last full fetch). Fetch the whole window
        // instead, which the archiver decimates; the current buffer stays on
        // screen meanwhile. It's the same window, asked for at the same time,
        // so `requestedWindow` and `requestedFollowedNow` stand.
        const full = new AbortController();
        cur.controller = full;
        if (forgot) this.publish();
        void this.runFetch(traceId, opts, resolvedMode, mode, full, null);
        return;
      }
      cur.data = data;
      cur.controller = null;
      cur.failure = null;
      cur.coverSig = cur.fetchSig;
      this.publish();
      // The window may have moved on while this was in flight (a forward
      // slide doesn't abort it). One that then stays put gets no other
      // request(), so fetch whatever of the latest window is still missing.
      this.requestAt(traceId, cur.wanted, cur.wantedAtMs);
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
        // The failure this request was issued with.
        const prev = cur.failure;
        const attempts = (prev && !prev.notArchived ? prev.attempts : 0) + 1;
        cur.failure = {
          ...info,
          notArchived: false,
          attempts,
          retryAtMs: this.now() + retryDelayMs(attempts),
          spanNs,
          revalidating: !!prev && (prev.notArchived || prev.revalidating),
        };
      }
      cur.data = { ...cur.data, status: 'error', error: info };
      cur.controller = null;
      this.scheduleRetry(traceId, cur);
      this.publish();
    }
  }

  // After a transient failure, retry the latest request once the backoff
  // expires. A window that never moves (a fixed range, or one panned into the
  // past) gets no other request() to retry it.
  private scheduleRetry(traceId: string, entry: InternalEntry): void {
    this.clearRetry(entry);
    const failure = entry.failure;
    if (!failure || failure.notArchived) return;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      // Released, refreshed, or answered since.
      if (this.entries.get(traceId) !== entry || entry.failure !== failure || entry.controller) {
        return;
      }
      // Early by the injected clock: wait out the rest.
      if (this.now() < failure.retryAtMs) this.scheduleRetry(traceId, entry);
      else this.requestAt(traceId, entry.wanted, entry.wantedAtMs);
    }, failure.retryAtMs - this.now());
  }

  private clearRetry(entry: InternalEntry): void {
    if (entry.retryTimer === null) return;
    clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
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
