// Singleton WebSocket-backed store for live PV samples from Canopy/Hare.
//
// Mirrors `archiveStore`: per-trace external store, `useSyncExternalStore`-
// compatible. One shared WebSocket fans out to many traces; PV monitors are
// refcounted so two traces watching the same PV produce one outbound subscribe.

import { liveWsUrl } from '../api/hare';
import { nsToMs } from '../api/time';
import type { AlarmSeverity, PVValueDTO, WsFrame } from '../api/types';

export interface LivePoint {
  time: number;
  value: number;
}

export type LiveStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface LiveEntry {
  pv: string;
  // Socket-level connection state (shared across all entries).
  status: LiveStatus;
  // PV-level connection (Hare's PVValue.connected). True only after a frame
  // for this PV has been received reporting connected=true.
  connected: boolean;
  severity: AlarmSeverity | null;
  latest: PVValueDTO | null;
  // Numeric time series. Non-numeric values still update `latest` for status
  // display but don't enter this buffer.
  points: readonly LivePoint[];
}

const HARD_CAP_POINTS = 100_000;
// Capped backoff schedule. Reset on every successful open.
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

interface PVState {
  // traceId -> retentionMs
  refs: Map<string, number>;
  points: LivePoint[];
  latest: PVValueDTO | null;
  connected: boolean;
  severity: AlarmSeverity | null;
}

interface TraceRef {
  pv: string;
  retentionMs: number;
}

type Listener = () => void;

export class LiveStore {
  private ws: WebSocket | null = null;
  private wsStatus: LiveStatus = 'idle';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private pvs = new Map<string, PVState>();
  private byTrace = new Map<string, TraceRef>();

  private snapshot: ReadonlyMap<string, LiveEntry> = new Map();
  private listeners = new Set<Listener>();

  getSnapshot = (): ReadonlyMap<string, LiveEntry> => this.snapshot;

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
      state = { refs: new Map(), points: [], latest: null, connected: false, severity: null };
      this.pvs.set(pv, state);
    }
    state.refs.set(traceId, retentionMs);

    this.ensureConnected();
    if (isFirst) this.sendSubscribe([pv]);
    this.publish();
  }

  private detach(traceId: string): boolean {
    const prev = this.byTrace.get(traceId);
    if (!prev) return false;
    this.byTrace.delete(traceId);
    const state = this.pvs.get(prev.pv);
    if (!state) return true;
    state.refs.delete(traceId);
    if (state.refs.size === 0) {
      this.pvs.delete(prev.pv);
      this.sendUnsubscribe([prev.pv]);
    }
    return true;
  }

  release(traceId: string): void {
    if (this.detach(traceId)) this.publish();
  }

  /** Released for tests so we can assert post-disconnect state. */
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
    } catch {
      this.wsStatus = 'disconnected';
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.handleOpen();
    ws.onmessage = (ev) => this.handleMessage(ev);
    ws.onclose = () => this.handleClose();
    // onerror is followed by onclose; let close handle reconnect.
    ws.onerror = () => {};
  }

  private handleOpen(): void {
    this.wsStatus = 'connected';
    this.reconnectAttempt = 0;
    const pvs = [...this.pvs.keys()];
    if (pvs.length) this.sendSubscribe(pvs);
    this.publish();
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
    for (const state of this.pvs.values()) state.connected = false;
    this.publish();
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
      this.publish();
      return;
    }
    if (frame.type === 'error') {
      console.warn('hare ws error frame:', frame);
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
    if (typeof v.value === 'number' && Number.isFinite(v.value)) {
      state.points.push({ time: nsToMs(v.tsNs), value: v.value });
      this.trim(state);
    }
  }

  private trim(state: PVState): void {
    // Use the longest retention requested by any subscriber so each gets at
    // least its window. The hard cap is a memory floor for stuck or absurd
    // retentions.
    let maxRetention = 0;
    for (const r of state.refs.values()) if (r > maxRetention) maxRetention = r;
    if (maxRetention > 0) {
      const cutoff = Date.now() - maxRetention;
      let drop = 0;
      while (drop < state.points.length && state.points[drop].time < cutoff) drop++;
      if (drop > 0) state.points.splice(0, drop);
    }
    if (state.points.length > HARD_CAP_POINTS) {
      state.points.splice(0, state.points.length - HARD_CAP_POINTS);
    }
  }

  private publish(): void {
    const next = new Map<string, LiveEntry>();
    for (const [traceId, ref] of this.byTrace) {
      const state = this.pvs.get(ref.pv);
      if (!state) continue;
      next.set(traceId, {
        pv: ref.pv,
        status: this.wsStatus,
        connected: state.connected,
        severity: state.severity,
        latest: state.latest,
        // Shared array — consumers must treat as read-only. Multiple traces on
        // the same PV legitimately see the same buffer.
        points: state.points,
      });
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export const liveStore = new LiveStore();
