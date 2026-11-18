// Singleton store for live PV samples from Canopy/Hare.
//
// Mirrors `archiveStore`: per-trace external store, `useSyncExternalStore`-
// compatible. The connection (reconnect with capped backoff, ping/pong
// liveness, resubscribe on reconnect) is the SDK's `HarePVService`; this store
// keeps what is trace-specific on top of it: per-trace retention, the numeric
// buffers the charts draw, the Vole backfill, and ref-stable snapshots. PV
// monitors are refcounted so two traces watching the same PV share one Hare
// subscription.

import {
  AlarmSeverity,
  HarePVService,
  toWsUrl,
  type CanopyConnection,
  type PVData,
  type WebSocketFactory,
  type WireAlarmSeverity,
} from '@slaclab/canopy-client';
import { canopyConnection } from '../api/connection';
import { errorInfo } from '../api/errorInfo';
import { toWireSeverity } from '../api/severity';
import { msToNs, nsToMs } from '../api/time';
import { fetchBackfill, subscribeVoleBuffer } from '../api/vole';
import type { SampleDTO } from '../api/types';

export interface LivePoint {
  time: number;
  value: number;
  // Alarm severity reported alongside this sample. Retained per-point so the
  // Data Insight Tool can show live-sample severity, not just the PV's latest.
  severity: WireAlarmSeverity;
}

export type LiveStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface LiveError {
  code: string;
  message: string;
}

export interface LiveEntry {
  pv: string;
  // Socket-level connection state (shared across all entries).
  status: LiveStatus;
  // PV-level connection (Hare's PVValue.connected). True only after an update
  // for this PV has been received reporting connected=true, with a severity
  // other than DISCONNECTED.
  connected: boolean;
  // Last alarm severity reported while the PV was connected.
  severity: WireAlarmSeverity | null;
  latest: PVData | null;
  // Last surfaced connection/protocol error, if any. Cleared on a clean
  // (re)connect. Distinct from a stale buffer: the chart can keep rendering
  // `points` while showing the error.
  error: LiveError | null;
  // Numeric time series. Non-numeric values still update `latest` for status
  // display but don't enter this buffer.
  points: readonly LivePoint[];
  // Recorded disconnects (ms, ascending): one per outage, at the time the
  // disconnect was seen (never before the last point + 1 ms), so the held
  // value draws up to the outage and the chart draws a gap there. A socket
  // outage that the reconnect's Vole backfill covers is removed again (see
  // "outage breaks" below). Kept apart from `points` because other consumers
  // read the samples as plain numbers. Absent = none.
  breaks?: readonly number[];
  // Where the line resumes after a break: one per break the PV has since
  // reported connected after, ascending. Drawing only, never a sample (see
  // `LiveResume`). Absent = none.
  resumes?: readonly LiveResume[];
}

/**
 * When a PV reported connected again after a break, and with what value: the
 * chart resumes the line there instead of leaving it blank until the next
 * change (an unchanged replay adds no sample). Not a sample: it never enters
 * `points`, so read-outs, statistics, counts and exports never see it.
 */
export interface LiveResume {
  // The break it follows (a value in `breaks`).
  after: number;
  // The client time the first connected update with a value after the break
  // arrived (ms), at least `after + 1`.
  time: number;
  // The value that update carried: the replay's, or the new one if it changed.
  // A later sample stamped before the break replaces it, while no sample
  // lands after the break.
  value: number;
}

// Live retention bounds. The default applies to a curve whose time range is
// unknown; the maximum is the longest retention the trace settings accept and
// caps every automatic retention.
export const LIVE_RETENTION_DEFAULT_MS = 5 * 60_000;
export const LIVE_RETENTION_MAX_S = 1800;
export const LIVE_RETENTION_MAX_MS = LIVE_RETENTION_MAX_S * 1000;

/**
 * The live retention a curve should have. An explicit value wins as is.
 * Otherwise retention is automatic and non-decreasing for the curve's life:
 * max(previous, derived from the time range span), capped at
 * LIVE_RETENTION_MAX_MS. `previousMs` is the curve's current retention
 * (`LiveStore.retentionOf`), undefined for a newly added curve, so only an
 * explicit value or a re-add lowers it. A missing span derives the default.
 */
export function resolveLiveRetentionMs(
  explicitMs: number | undefined,
  previousMs: number | undefined,
  rangeSpanMs: number | undefined
): number {
  if (explicitMs !== undefined) return explicitMs;
  const derived =
    rangeSpanMs !== undefined && Number.isFinite(rangeSpanMs) && rangeSpanMs > 0
      ? rangeSpanMs
      : LIVE_RETENTION_DEFAULT_MS;
  return Math.min(Math.max(previousMs ?? 0, derived), LIVE_RETENTION_MAX_MS);
}

export interface LiveStoreOptions {
  // How to reach Hare. Default: the app's shared connection.
  connection?: CanopyConnection;
  // Injectable for tests. Default: the global WebSocket.
  webSocketFactory?: WebSocketFactory;
}

const HARE_WS_PATH = '/hare/v1/ws/pvs';

// HarePVService reports a null wire value as 0, with this display value.
const NO_VALUE_DISPLAY = '---';

// Whether an update stands for a null value. An enum PV whose choice label at
// that index is literally '---' displays the same, so that case is a real
// value. (A null on such a PV still reads as that index: PVData can't tell
// them apart, slaclab/canopy-sdk-js#42.)
function isNullValue(data: PVData): boolean {
  if (data.displayValue !== NO_VALUE_DISPLAY) return false;
  return !(typeof data.value === 'number' && data.enumChoices?.[data.value] === NO_VALUE_DISPLAY);
}

// The error shown while the socket is down. The service's own connection errors
// (the socket couldn't be created; a terminal close such as a rejected key) say
// more, so they aren't replaced by it.
const WS_DISCONNECTED_CODE = 'ws_disconnected';
const SOCKET_ERROR_CODES = new Set(['ws_connect_failed', 'ws_terminal_close']);

const HARD_CAP_POINTS = 100_000;
// Eviction slack: defer the O(n) front-trim until the buffer holds noticeably
// more than the retention window calls for, then trim in one pass. Bounds the
// amortized cost per sample to O(1) instead of O(n)-per-sample.
const TRIM_SLACK_POINTS = 256;

interface PVState {
  // traceId -> retentionMs
  refs: Map<string, number>;
  points: LivePoint[];
  breaks: number[];
  // The breaks recorded on a socket drop that no backfill has settled yet
  // (`settleBreaks`). A subset of `breaks`.
  socketBreaks: Set<number>;
  // True from a socket (re)connect until the PV's first update on it.
  awaitingReport: boolean;
  // A covering backfill that came back before that first update. Applied
  // when the PV reports connected; dropped when it reports down.
  deferredCover: BackfillCover | null;
  // Published as `LiveEntry.resumes`, ascending.
  resumes: LiveResume[];
  // The newest break, until the PV's first connected update after it records
  // its resume (or the break goes). Null otherwise.
  resumeFor: number | null;
  latest: PVData | null;
  connected: boolean;
  severity: WireAlarmSeverity | null;
  // Ends the Hare subscription; called when the last trace releases the PV.
  unsubscribe: (() => void) | null;
  // Monotonic revision bumped whenever any published field of this PV changes.
  // `entryFor()` reuses the cached LiveEntry when the rev is unchanged so
  // downstream shallow-equality / React.memo checks hold across frames.
  rev: number;
  // In-flight backfill controller — aborted on release or superseded request.
  backfillController: AbortController | null;
}

// What a covering backfill settles: the socket breaks recorded before it was
// requested, and the start of the window it covers.
interface BackfillCover {
  fromMs: number;
  breaks: readonly number[];
}

interface TraceRef {
  pv: string;
  retentionMs: number;
}

type Listener = () => void;

export class LiveStore {
  private readonly options: LiveStoreOptions;
  // Built on the first watch(): resolving the WebSocket URL needs the page
  // location, which tests and other non-browser imports don't have.
  private service: HarePVService | null = null;
  // Whether we asked the service to stay connected. Cleared when the last
  // trace is released (the socket is closed then) and after a terminal close,
  // so the next watch() reconnects without cutting a pending backoff short.
  private connectRequested = false;
  private wsStatus: LiveStatus = 'idle';
  private wsError: LiveError | null = null;

  private pvs = new Map<string, PVState>();
  private byTrace = new Map<string, TraceRef>();
  // PVs we've asked Vole to buffer during their current watch.
  private voleSubscribed = new Set<string>();

  // Per-PV cached entry keyed by a signature of its published inputs. Lets
  // `rebuild()` reuse the prior LiveEntry object when nothing changed, so
  // downstream shallow-equality / React.memo checks hold across frames.
  private entryCache = new Map<string, { sig: string; entry: LiveEntry }>();

  private snapshot: ReadonlyMap<string, LiveEntry> = new Map();
  // True when `snapshot` is behind `pvs`/`wsStatus`. `getSnapshot` rebuilds
  // lazily on read; listener notification is coalesced into a microtask so a
  // burst of WS frames triggers at most one React render per tick.
  private dirty = false;
  private notifyScheduled = false;
  private listeners = new Set<Listener>();

  constructor(options: LiveStoreOptions = {}) {
    this.options = options;
  }

  getSnapshot = (): ReadonlyMap<string, LiveEntry> => {
    if (this.dirty) this.rebuild();
    return this.snapshot;
  };

  // Single-trace snapshot for consumers that watch exactly one trace (e.g. the
  // Data Insight Tool). Returns the ref-stable `LiveEntry` from the rebuilt
  // snapshot, so a `useSyncExternalStore` reading only this entry re-renders on
  // that trace's samples alone, not on every store notification.
  getEntrySnapshot = (traceId: string): LiveEntry | undefined => {
    if (this.dirty) this.rebuild();
    return this.snapshot.get(traceId);
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Watch `pv` on behalf of `traceId` with the given retention. Idempotent:
   * calling with identical args is a no-op. A different retention on the same
   * pv is updated in place: the buffer is kept, no subscription is sent, and a
   * lower retention trims the buffer at once. A different pv retargets the
   * trace's reference.
   */
  watch(traceId: string, pv: string, retentionMs: number): void {
    const prev = this.byTrace.get(traceId);
    if (prev && prev.pv === pv) {
      if (prev.retentionMs === retentionMs) return;
      this.retain(traceId, prev, retentionMs);
      return;
    }
    if (prev) this.detach(traceId);

    this.byTrace.set(traceId, { pv, retentionMs });

    let state = this.pvs.get(pv);
    const isFirst = !state;
    if (!state) {
      state = {
        refs: new Map(),
        points: [],
        breaks: [],
        socketBreaks: new Set(),
        awaitingReport: false,
        deferredCover: null,
        resumes: [],
        resumeFor: null,
        latest: null,
        connected: false,
        severity: null,
        unsubscribe: null,
        rev: 0,
        backfillController: null,
      };
      this.pvs.set(pv, state);
    }
    state.refs.set(traceId, retentionMs);
    state.rev++;

    const service = this.ensureService();
    if (service) {
      // One Hare subscription per PV, however many traces watch it. Sent now
      // if the socket is open, otherwise on (re)connect.
      if (!state.unsubscribe) {
        state.unsubscribe = service.subscribe(pv, (data) => this.applyData(pv, data));
      }
      if (!this.connectRequested) {
        this.connectRequested = true;
        service.connect();
      }
      // On a socket that is already open; otherwise the (re)connect backfills.
      if (isFirst && this.wsStatus === 'connected') this.startBackfill(pv, state);
    }
    this.markDirty();
  }

  /** The retention `traceId` is watched with; undefined when it is not watched. */
  retentionOf(traceId: string): number | undefined {
    return this.byTrace.get(traceId)?.retentionMs;
  }

  private retain(traceId: string, ref: TraceRef, retentionMs: number): void {
    const lowered = retentionMs < ref.retentionMs;
    ref.retentionMs = retentionMs;
    const state = this.pvs.get(ref.pv);
    if (!state) return;
    state.refs.set(traceId, retentionMs);
    if (lowered) {
      const before = state.points.length;
      this.trim(state, true);
      if (state.points.length !== before) {
        state.rev++;
        this.markDirty();
      }
    }
  }

  private detach(traceId: string): boolean {
    const prev = this.byTrace.get(traceId);
    if (!prev) return false;
    this.byTrace.delete(traceId);
    const state = this.pvs.get(prev.pv);
    if (!state) return true;
    state.refs.delete(traceId);
    if (state.refs.size === 0) {
      state.backfillController?.abort();
      state.backfillController = null;
      this.pvs.delete(prev.pv);
      this.voleSubscribed.delete(prev.pv);
      state.unsubscribe?.();
    }
    return true;
  }

  release(traceId: string): void {
    if (!this.detach(traceId)) return;
    // Nothing left to watch: close the socket rather than keep reconnecting.
    // The next watch() opens a new one.
    if (this.byTrace.size === 0 && this.connectRequested) {
      this.connectRequested = false;
      this.service?.disconnect();
    }
    this.markDirty();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private ensureService(): HarePVService | null {
    if (this.service) return this.service;
    const { webSocketFactory } = this.options;
    if (!webSocketFactory && typeof WebSocket === 'undefined') return null;
    const conn = this.options.connection ?? canopyConnection;
    try {
      this.service = new HarePVService({
        url: toWsUrl(conn.baseUrl, HARE_WS_PATH),
        apiKey: conn.apiKey,
        fetchFn: conn.fetch,
        webSocketFactory,
        onStatusChange: (status) => this.handleStatus(status),
        onError: (error) => {
          // A terminal close stops the service until connect() is called again.
          if (error.code === 'ws_terminal_close') this.connectRequested = false;
          this.setError(error.code, error.message);
        },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.setError('ws_connect_failed', `Could not open live connection: ${detail}`);
      return null;
    }
    return this.service;
  }

  private handleStatus(status: LiveStatus): void {
    const wasConnected = this.wsStatus === 'connected';
    this.wsStatus = status;
    if (status === 'connected') {
      // A clean (re)connect clears any prior connection error.
      this.clearError();
      // Backfill on every (re)connect so the fetched window aligns with the
      // subscribe moment: no gap between backfill coverage and the first live
      // sample.
      if (!wasConnected) {
        for (const [pv, state] of this.pvs) {
          state.awaitingReport = true;
          this.startBackfill(pv, state);
        }
      }
    } else if (
      status === 'disconnected' &&
      this.connectRequested &&
      !SOCKET_ERROR_CODES.has(this.wsError?.code ?? '')
    ) {
      // The socket dropped, or never opened, while traces still watch. The
      // service reports only connect failures and terminal closes, so say it
      // here, under "Disconnected", until a clean reconnect clears it. Not on
      // our own close after the last release (connectRequested is false then).
      this.setError(WS_DISCONNECTED_CODE, 'Live connection error.');
    }
    this.markDirty();
  }

  private applyData(pv: string, data: PVData): void {
    const state = this.pvs.get(pv);
    // PV may have been released between subscribe and a stray late update.
    if (!state) return;
    const connected = data.connected && data.severity !== AlarmSeverity.DISCONNECTED;
    const socketUp = this.wsStatus === 'connected';
    // One break per outage: only the connected true -> false transition. A
    // dropped socket reaches here too, as a DISCONNECTED update per PV, after
    // `handleStatus` has seen the close (see "outage breaks").
    if (state.connected && !connected) this.recordBreak(state, !socketUp);
    if (socketUp && state.awaitingReport) {
      // The PV's first update since the socket came back.
      state.awaitingReport = false;
      const cover = state.deferredCover;
      state.deferredCover = null;
      if (!connected) {
        // Still down: it may have gone down at any time in the outage, as far
        // as anyone can tell, so its socket breaks stay.
        state.socketBreaks.clear();
      } else if (cover) {
        this.settleBreaks(state, cover.breaks, cover.fromMs);
      }
    }
    const value =
      typeof data.value === 'number' && Number.isFinite(data.value) && !isNullValue(data)
        ? data.value
        : null;
    // The first connected update with a value after a break (still kept, so
    // not covered) records where the line resumes: now, with that value. One
    // per break; an update with no value to draw leaves it to the next one.
    if (connected && value !== null && state.resumeFor !== null) {
      const after = state.resumeFor;
      state.resumeFor = null;
      state.resumes.push({ after, time: Math.max(Date.now(), after + 1), value });
    }
    state.latest = data;
    // A disconnected PV (or a dropped socket, which the service reports as a
    // DISCONNECTED update with the last value) keeps its last alarm severity
    // and adds no sample: its value is stale. A DISCONNECTED severity counts as
    // disconnected even if the update says connected: it's a connection state,
    // not an alarm, so it mustn't become an INVALID sample. A null value, which
    // the service reports as 0, adds no sample either. The chart never draws
    // past a break.
    state.connected = connected;
    if (connected) {
      // Only a level the SDK doesn't define is left without a wire name. It
      // reads as INVALID, as the SDK reads an unknown wire severity.
      const severity = toWireSeverity(data.severity) ?? 'INVALID';
      state.severity = severity;
      if (value !== null) {
        // Always the IOC's timestamp. After a reconnect Hare replays an
        // unchanged value with its original timestamp: an exact repeat, which
        // insertPoint drops. A value that changed meanwhile lands at its time.
        this.insertPoint(state, { time: data.timestamp, value, severity });
        this.followResume(state, data.timestamp, value);
      }
    }
    state.rev++;
    this.markDirty();
  }

  // ── outage breaks ──────────────────────────────────────────────────────
  //
  // A break is recorded on the PV's connected -> disconnected transition, at
  // the time it is seen (never before the last point + 1 ms), so the held
  // value draws up to the outage. Its cause decides whether it goes again:
  //
  // - Socket drop. ResilientSocket reports the close through `handleStatus`
  //   before HarePVService hands each PV a DISCONNECTED copy (and a reconnect
  //   reports 'connected' before Hare's first frame), so a transition seen
  //   while `wsStatus` is not 'connected' is the socket's. Canopy kept the PV
  //   meanwhile, so the reconnect's Vole backfill settles the break: dropped
  //   when the backfill covers it, kept when the backfill fails, is refused
  //   (`pv_not_buffered`) or doesn't cover it.
  // - PV disconnect, on an open socket: the IOC, or Hare's link to it, went
  //   away. That break always stays. Vole ingests the same Hare stream and
  //   skips its `connected: false` frames, so its data can't show the PV kept
  //   updating through an outage seen here: what it holds after the break is
  //   the PV's own later updates, which land after the break as they are.
  // - A PV whose first update after a reconnect says it is down: it may have
  //   gone down at any time in the outage, so its socket breaks stay too. A
  //   cover that comes back before that first update waits for it.
  //
  // "Covers": the backfill asks for [from, now], `from` being the newest
  // point's ms clamped to the retention window. It covers that window when it
  // resolves and its first sample falls in or before `from`'s millisecond.
  // That sample is either the newest point itself (at its full-ns stamp) or,
  // with `align=last`, Vole's last sample before `from` pinned at `from`.
  // Either way Vole's buffer reached back to `from`, and a buffer is kept
  // from Vole's subscribe until it is dropped. An empty response, or one
  // whose first sample is later (a buffer started since), proves nothing. A
  // cover drops the socket breaks recorded before the request, at or after
  // `from`; a break before `from` (an outage longer than the retention
  // window) stays. Whatever its result, a backfill settles those breaks: the
  // ones it doesn't drop stay for good. Vole's answer can't show a buffer
  // that was dropped and created again since, if the PV has not changed.
  //
  // Resumes: an unchanged replay adds no sample, so a kept break alone would
  // leave a slow PV's line blank until its next change. The first connected
  // update with a value after a break therefore records a `LiveResume`: its
  // receipt time (at least the break + 1 ms) and its value. A later sample
  // stamped before the break updates that value while none lands after it.
  // The chart resumes the line there (traceGaps `withLiveResumes`) until a
  // real sample takes over. It is never a sample, and it goes with its break.

  // `socket`: recorded because the socket dropped, not the PV.
  private recordBreak(state: PVState, socket: boolean): void {
    const last = state.points.at(-1);
    if (!last) return;
    const at = Math.max(last.time + 1, Date.now());
    const prev = state.breaks.at(-1);
    if (prev !== undefined && prev >= at) {
      // An open break already ends the line there (same millisecond, or a
      // clock stepped back): it stands for this outage too, and can't go if
      // this one is the PV's. A resume it had is void: the PV is down again.
      if (!socket) state.socketBreaks.delete(prev);
      dropResume(state, prev);
      state.resumeFor = prev;
      return;
    }
    state.breaks.push(at);
    if (socket) state.socketBreaks.add(at);
    state.resumeFor = at;
  }

  // A sample stamped at or before the newest break is still the PV's newest
  // reading while nothing lands after the break: the line resumes with it,
  // not with the value the resume was recorded with.
  private followResume(state: PVState, time: number, value: number): void {
    const last = state.resumes.length - 1;
    const resume = state.resumes[last];
    if (!resume || resume.after !== state.breaks.at(-1) || time > resume.after) return;
    const newest = state.points.at(-1);
    if (newest && newest.time > resume.after) return;
    if (resume.value !== value) state.resumes[last] = { ...resume, value };
  }

  // Settle the socket breaks `breaks` (those recorded before a backfill was
  // requested): with `coverFromMs`, the ones at or after it are dropped, with
  // their resumes. The rest stay for good.
  private settleBreaks(
    state: PVState,
    breaks: readonly number[],
    coverFromMs: number | null
  ): void {
    let dropped = false;
    for (const at of breaks) {
      // Already settled (or trimmed).
      if (!state.socketBreaks.delete(at)) continue;
      if (coverFromMs === null || at < coverFromMs) continue;
      const i = state.breaks.indexOf(at);
      if (i >= 0) {
        state.breaks.splice(i, 1);
        dropResume(state, at);
        if (state.resumeFor === at) state.resumeFor = null;
        dropped = true;
      }
    }
    if (dropped) {
      state.rev++;
      this.markDirty();
    }
  }

  private insertPoint(state: PVState, point: LivePoint): void {
    const points = state.points;
    const last = points[points.length - 1];
    if (!last || point.time > last.time) {
      points.push(point);
    } else {
      // Out of order (clock skew or step): insert in place so the trace keeps
      // updating. Skip only an exact repeat, e.g. Hare's reconnect re-send.
      let i = lowerBound(points, point.time);
      for (; i < points.length && points[i].time === point.time; i++) {
        if (points[i].value === point.value) return;
      }
      points.splice(i, 0, point);
    }
    this.trim(state);
  }

  // `force` trims to the window at once, without the slack (a lowered retention).
  private trim(state: PVState, force = false): void {
    // Use the longest retention requested by any subscriber so each gets at
    // least its window. The hard cap is a memory floor for stuck or absurd
    // retentions.
    //
    // Front-splicing is O(n), so we don't do it on every sample. We let the
    // buffer overshoot the window by up to TRIM_SLACK_POINTS, then evict in a
    // single pass. This amortizes eviction to O(1) per sample while never
    // exposing more than `slack` stale points to consumers.
    const retention = maxRetention(state);
    const points = state.points;
    if (retention > 0) {
      const cutoff = Date.now() - retention;
      // Only scan once enough stale points have accumulated. The newest point
      // is always within the window, so a quick check of the slack-th point
      // tells us whether a trim is even worth attempting.
      const slackIdx = TRIM_SLACK_POINTS;
      if (force || (points.length > slackIdx && points[slackIdx].time < cutoff)) {
        let drop = 0;
        while (drop < points.length && points[drop].time < cutoff) drop++;
        if (drop > 0) points.splice(0, drop);
      }
    }
    if (points.length > HARD_CAP_POINTS) {
      points.splice(0, points.length - HARD_CAP_POINTS);
    }
    // Breaks before the oldest retained point have nothing left to separate.
    const breaks = state.breaks;
    if (breaks.length > 0 && points.length > 0 && breaks[0] < points[0].time) {
      let drop = 0;
      while (drop < breaks.length && breaks[drop] < points[0].time) {
        state.socketBreaks.delete(breaks[drop]);
        if (state.resumeFor === breaks[drop]) state.resumeFor = null;
        drop++;
      }
      breaks.splice(0, drop);
      // Their resumes go with them (they are sorted the same way).
      const first = breaks.length > 0 ? breaks[0] : Infinity;
      let gone = 0;
      while (gone < state.resumes.length && state.resumes[gone].after < first) gone++;
      if (gone > 0) state.resumes.splice(0, gone);
    }
  }

  private setError(code: string, message: string): void {
    const prev = this.wsError;
    if (prev && prev.code === code && prev.message === message) return;
    this.wsError = { code, message };
    this.markDirty();
  }

  private clearError(): void {
    if (!this.wsError) return;
    this.wsError = null;
    this.markDirty();
  }

  // Mark the snapshot stale and coalesce listener notification into a single
  // microtask. A burst of WS frames thus produces one React render per tick
  // instead of one per frame. `getSnapshot` rebuilds lazily, so synchronous
  // reads between frames still see fresh data.
  private markDirty(): void {
    this.dirty = true;
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      if (this.dirty) this.rebuild();
      for (const listener of this.listeners) listener();
    });
  }

  private rebuild(): void {
    const next = new Map<string, LiveEntry>();
    for (const [traceId, ref] of this.byTrace) {
      const state = this.pvs.get(ref.pv);
      if (!state) continue;
      next.set(traceId, this.entryFor(ref.pv, state));
    }
    // Drop cache slots for PVs no longer watched.
    if (this.entryCache.size > this.pvs.size) {
      for (const pv of this.entryCache.keys()) {
        if (!this.pvs.has(pv)) this.entryCache.delete(pv);
      }
    }
    this.snapshot = next;
    this.dirty = false;
  }

  // Build (or reuse) the LiveEntry for a PV. Cached by a signature of the PV's
  // `rev` plus the socket-level status/error, so an entry whose inputs are
  // unchanged returns the same object reference.
  private entryFor(pv: string, state: PVState): LiveEntry {
    const errKey = this.wsError ? `${this.wsError.code}:${this.wsError.message}` : '';
    const sig = `${state.rev}|${this.wsStatus}|${errKey}`;
    const cached = this.entryCache.get(pv);
    if (cached && cached.sig === sig) return cached.entry;
    const entry: LiveEntry = {
      pv,
      status: this.wsStatus,
      connected: state.connected,
      severity: state.severity,
      latest: state.latest,
      error: this.wsError,
      // Shared array — consumers must treat as read-only. Multiple traces on
      // the same PV legitimately see the same buffer.
      points: state.points,
      breaks: state.breaks,
      resumes: state.resumes,
    };
    this.entryCache.set(pv, { sig, entry });
    return entry;
  }

  // ── backfill ───────────────────────────────────────────────────────────

  private startBackfill(pv: string, state: PVState): void {
    state.backfillController?.abort();
    const controller = new AbortController();
    state.backfillController = controller;

    // Fill from the newest point, but never past the retention window.
    const last = state.points[state.points.length - 1];
    const fromMs = Math.max(last ? last.time : -Infinity, Date.now() - maxRetention(state));
    const fromNs = msToNs(fromMs);
    // The socket breaks this backfill settles (see "outage breaks"). This one
    // supersedes any earlier cover still waiting.
    const breaks = [...state.socketBreaks];
    state.deferredCover = null;

    fetchBackfill(pv, fromNs, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        const current = this.pvs.get(pv);
        if (!current || current.backfillController !== controller) return;
        current.backfillController = null;
        this.mergeBackfill(current, res.samples);
        // Compared in ms: `from` is the newest point's floored ms, and Vole
        // returns that same sample at its full-ns stamp, up to 1 ms later.
        const covers = res.samples.length > 0 && nsToMs(res.samples[0].tsNs) <= fromMs;
        if (covers && current.awaitingReport) {
          current.deferredCover = { fromMs, breaks };
        } else {
          this.settleBreaks(current, breaks, covers ? fromMs : null);
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if ((err as { name?: string }).name === 'AbortError') return;
        // A failed backfill covers nothing: the breaks it settles stay.
        const current = this.pvs.get(pv);
        if (current && current.backfillController === controller) {
          this.settleBreaks(current, breaks, null);
        }
        if (errorInfo(err).code === 'pv_not_buffered') {
          // Ask Vole to buffer it for the next backfill, once per watch.
          if (this.voleSubscribed.has(pv)) return;
          this.voleSubscribed.add(pv);
          subscribeVoleBuffer([pv], { signal: controller.signal }).catch((subErr) => {
            // Let a later 404 try again.
            this.voleSubscribed.delete(pv);
            if (controller.signal.aborted) return;
            console.warn('vole subscribe failed for', pv, subErr);
          });
          return;
        }
        console.warn('backfill failed for', pv, err);
      });
  }

  private mergeBackfill(state: PVState, samples: SampleDTO[]): void {
    const incoming: LivePoint[] = [];
    for (const s of samples) {
      if (typeof s.value !== 'number' || !Number.isFinite(s.value)) continue;
      incoming.push({ time: nsToMs(s.tsNs), value: s.value, severity: s.severity });
    }
    if (incoming.length === 0) return;

    // Merge only the tail that overlaps the backfill, not the whole buffer.
    const points = state.points;
    const start = lowerBound(points, incoming[0].time);
    const merged = mergeSorted(points.slice(start), incoming);
    if (merged.length === points.length - start) return;
    points.length = start;
    for (const p of merged) points.push(p);
    state.rev++;
    this.trim(state);
    this.markDirty();
  }
}

// Remove the resume that follows break `after`, if any.
function dropResume(state: PVState, after: number): void {
  const i = state.resumes.findIndex((r) => r.after === after);
  if (i >= 0) state.resumes.splice(i, 1);
}

// Longest retention requested by any trace on this PV.
function maxRetention(state: PVState): number {
  let max = 0;
  for (const r of state.refs.values()) if (r > max) max = r;
  return max;
}

// Index of the first point at or after `time`. `points` is time-sorted.
function lowerBound(points: readonly LivePoint[], time: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Merge two time-sorted point lists, keeping a sample in both (same time and
// value) once. Handles Hare's `initial` landing before or after the backfill.
export function mergeSorted(
  existing: readonly LivePoint[],
  incoming: readonly LivePoint[]
): LivePoint[] {
  const out: LivePoint[] = [];
  let i = 0;
  let j = 0;
  while (i < existing.length && j < incoming.length) {
    const a = existing[i];
    const b = incoming[j];
    if (a.time < b.time) {
      out.push(a);
      i++;
    } else if (b.time < a.time) {
      out.push(b);
      j++;
    } else {
      out.push(a);
      i++;
      if (a.value === b.value) j++;
    }
  }
  while (i < existing.length) out.push(existing[i++]);
  while (j < incoming.length) out.push(incoming[j++]);
  return out;
}

export const liveStore = new LiveStore();
