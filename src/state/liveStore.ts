// Singleton WebSocket-backed store for live PV samples from Canopy/Hare.
//
// Mirrors `archiveStore`: per-trace external store, `useSyncExternalStore`-
// compatible. One shared WebSocket fans out to many traces; PV monitors are
// refcounted so two traces watching the same PV produce one outbound subscribe.

import { liveWsUrl } from '../api/hare';
import type { WireAlarmSeverity } from '@slaclab/canopy-client';
import { msToNs, nsToMs } from '../api/time';
import { fetchBackfill, subscribeVoleBuffer } from '../api/vole';
import { CanopyError } from '../api/client';
import type { PVValueDTO, SampleDTO, WsFrame } from '../api/types';

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
  // PV-level connection (Hare's PVValue.connected). True only after a frame
  // for this PV has been received reporting connected=true.
  connected: boolean;
  severity: WireAlarmSeverity | null;
  latest: PVValueDTO | null;
  // Last surfaced connection/protocol error, if any. Cleared on a clean
  // (re)connect. Distinct from a stale buffer: the chart can keep rendering
  // `points` while showing the error.
  error: LiveError | null;
  // Numeric time series. Non-numeric values still update `latest` for status
  // display but don't enter this buffer.
  points: readonly LivePoint[];
}

const HARD_CAP_POINTS = 100_000;
// Eviction slack: defer the O(n) front-trim until the buffer holds noticeably
// more than the retention window calls for, then trim in one pass. Bounds the
// amortized cost per sample to O(1) instead of O(n)-per-sample.
const TRIM_SLACK_POINTS = 256;
// Capped backoff schedule. Reset on every successful open.
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

interface PVState {
  // traceId -> retentionMs
  refs: Map<string, number>;
  points: LivePoint[];
  latest: PVValueDTO | null;
  connected: boolean;
  severity: WireAlarmSeverity | null;
  // Monotonic revision bumped whenever any published field of this PV changes.
  // `entryFor()` reuses the cached LiveEntry when the rev is unchanged so
  // downstream shallow-equality / React.memo checks hold across frames.
  rev: number;
  // In-flight backfill controller — aborted on release or superseded request.
  backfillController: AbortController | null;
}

interface TraceRef {
  pv: string;
  retentionMs: number;
}

type Listener = () => void;

export class LiveStore {
  private ws: WebSocket | null = null;
  private wsStatus: LiveStatus = 'idle';
  private wsError: LiveError | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
   * calling with identical args is a no-op. Calling with a different pv or
   * retention transparently retargets the trace's reference.
   */
  watch(traceId: string, pv: string, retentionMs: number): void {
    const prev = this.byTrace.get(traceId);
    if (prev && prev.pv === pv && prev.retentionMs === retentionMs) return;
    if (prev) this.detach(traceId);

    this.byTrace.set(traceId, { pv, retentionMs });

    let state = this.pvs.get(pv);
    const isFirst = !state;
    if (!state) {
      state = {
        refs: new Map(),
        points: [],
        latest: null,
        connected: false,
        severity: null,
        rev: 0,
        backfillController: null,
      };
      this.pvs.set(pv, state);
    }
    state.refs.set(traceId, retentionMs);
    state.rev++;

    this.ensureConnected();
    if (isFirst) {
      this.sendSubscribe([pv]);
      if (this.wsStatus === 'connected') this.startBackfill(pv, state);
    }
    this.markDirty();
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
      this.sendUnsubscribe([prev.pv]);
    }
    return true;
  }

  release(traceId: string): void {
    if (this.detach(traceId)) {
      if (this.pvs.size === 0) this.closeSocket();
      this.markDirty();
    }
  }

  private closeSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    if (this.ws) {
      // Closing a connecting socket fires `error`; don't surface it.
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.wsStatus = 'idle';
  }

  /** Exposed for tests so we can assert post-disconnect state. */
  forceDisconnect(): void {
    this.ws?.close();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private ensureConnected(): void {
    if (typeof WebSocket === 'undefined') return;
    if (this.ws || this.wsStatus === 'connecting') return;
    this.connect();
  }

  private connect(): void {
    if (typeof WebSocket === 'undefined') return;
    this.wsStatus = 'connecting';
    let ws: WebSocket;
    try {
      ws = new WebSocket(liveWsUrl());
    } catch (err) {
      this.wsStatus = 'disconnected';
      const detail = err instanceof Error ? err.message : String(err);
      this.setError('ws-connect-failed', `Could not open live connection: ${detail}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.handleOpen();
    ws.onmessage = (ev) => this.handleMessage(ev);
    ws.onclose = () => this.handleClose();
    // onerror is followed by onclose; let close handle reconnect. Record it so
    // the user sees something more useful than a silent disconnect.
    ws.onerror = () => this.setError('ws-error', 'Live connection error.');
  }

  private handleOpen(): void {
    this.wsStatus = 'connected';
    this.reconnectAttempt = 0;
    this.clearError();
    const pvs = [...this.pvs.keys()];
    if (pvs.length) this.sendSubscribe(pvs);
    // Backfill on every (re)connect so the fetched window aligns with the WS
    // subscribe moment — no gap between backfill coverage and first live sample.
    for (const [pv, state] of this.pvs) {
      this.startBackfill(pv, state);
    }
    this.markDirty();
  }

  private handleMessage(ev: MessageEvent): void {
    let frame: WsFrame;
    try {
      frame = JSON.parse(ev.data as string) as WsFrame;
    } catch {
      return;
    }
    this.applyFrame(frame);
  }

  private handleClose(): void {
    this.ws = null;
    this.wsStatus = 'disconnected';
    // Mark every PV pv-level disconnected; keep buffers visible until reconnect.
    for (const state of this.pvs.values()) {
      if (state.connected) {
        state.connected = false;
        state.rev++;
      }
    }
    this.markDirty();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.byTrace.size === 0) return;
    if (this.reconnectTimer) return;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private sendSubscribe(pvNames: string[]): void {
    this.sendIfOpen({ type: 'subscribe', pvNames });
  }

  private sendUnsubscribe(pvNames: string[]): void {
    this.sendIfOpen({ type: 'unsubscribe', pvNames });
  }

  private sendIfOpen(message: { type: string; pvNames: string[] }): void {
    if (!message.pvNames.length) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
    // Pre-open subscribes are covered by the re-subscribe in `handleOpen`.
  }

  private applyFrame(frame: WsFrame): void {
    if (frame.type === 'initial' || frame.type === 'diff') {
      for (const pv of Object.keys(frame.data)) {
        this.applyValue(pv, frame.data[pv]);
      }
      this.markDirty();
      return;
    }
    if (frame.type === 'error') {
      console.warn('hare ws error frame:', frame);
      this.setError(frame.code || 'ws-error', frame.message || 'Live stream error.');
    }
    // heartbeat / pong: ignored for now.
  }

  private applyValue(pv: string, v: PVValueDTO): void {
    const state = this.pvs.get(pv);
    // PV may have been released between subscribe and a stray late frame.
    if (!state) return;
    state.latest = v;
    state.connected = v.connected;
    state.severity = v.severity;
    state.rev++;
    if (typeof v.value === 'number' && Number.isFinite(v.value)) {
      const point = { time: nsToMs(v.tsNs), value: v.value, severity: v.severity };
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
  }

  private trim(state: PVState): void {
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
      if (points.length > slackIdx && points[slackIdx].time < cutoff) {
        let drop = 0;
        while (drop < points.length && points[drop].time < cutoff) drop++;
        if (drop > 0) points.splice(0, drop);
      }
    }
    if (points.length > HARD_CAP_POINTS) {
      points.splice(0, points.length - HARD_CAP_POINTS);
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

    fetchBackfill(pv, fromNs, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        const current = this.pvs.get(pv);
        if (!current || current.backfillController !== controller) return;
        current.backfillController = null;
        this.mergeBackfill(current, res.samples);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if ((err as { name?: string }).name === 'AbortError') return;
        if (err instanceof CanopyError && err.code === 'pv_not_buffered') {
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
