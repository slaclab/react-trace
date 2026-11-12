// The Waveform data path's owner. One
// controller per page owns the page's one `HarePVService` and every PV
// listener the tool holds, ingests each frame into its curve's ring at Hare
// rate, and publishes what the canvas draws.
//
// Listeners: one per role PV (Live, the Reference PV, the X source), held only
// while the page is wanted and — for Live and Reference — the curve is Visible.
// Hiding a curve releases its listener and drops its ring; showing it starts a
// fresh ring (a new reset epoch), so a snapshot taken before carries no entry
// for it ("not in snapshot"). A reconnect (connected false → true) resets
// the ring too. A disconnected copy is never ingested, so a PV reference keeps
// its last frame while disconnected.
//
// Two rates: ingest at Hare rate, every frame into the ring (the ring
// never drops one); publish at most once per animation frame, only when a frame
// arrived since the last publish, and only while the page is visible. `hz`
// only lengthens the interval between publishes (hz = 10, Hare's cadence, is
// "off"). While the page is hidden frames keep being ingested and nothing is
// published — no timer fallback; becoming visible publishes once at once.
// Pause freezes the published frames. A reference change forces one publish
// that bypasses `hz` and Pause (paused, the live frames stay frozen), so the
// Snapshot click re-zeroes Δ at once.
//
// Frames are published at full range and pre-Δ (the ring mean when Average >
// 1): element range, Δ and decimation are applied downstream by the option
// builder. `captureSnapshot` returns, for `edit.setSnapshot`, every visible
// drawable live curve's last published frame; the controller never holds the
// snapshot — it reads it from state.
//
// Outputs, each emitted only on change: `frames` for the
// canvas (a new object per publish) and `model` for the properties panel
// (re-derived on every input, emitted only when it differs structurally, so a
// stream of same-shaped frames re-renders no sidebar).

import { HarePVService, type PVData, type PVListener } from '@slaclab/canopy-client';
import { hareServiceOptions } from '../shared/canopyServices';
import type { SnapshotInput } from './edit';
import { CurveBuffers, FrameRing, RollingWindow, ringCapacity, type RollingFrame } from './frames';
import {
  deriveWaveformModel,
  sameData,
  type WaveformModel,
  type WaveformPvMeta,
  type WaveformRingSummary,
} from './model';
import type { WaveformCurveFrames, WaveformPlotFrames } from './plotOption';
import { MAX_HZ, defaultWaveformState, type WaveformState } from './query';

/** No metadata within this window: the axis unit is decided with what arrived. */
export const WAVEFORM_META_TIMEOUT_MS = 3000;

/** What the controller needs of a PV service: listeners and the meta cache. */
export interface WaveformPVService {
  subscribe(pvName: string, listener: PVListener): () => void;
  getMeta(pvName: string): { units: string | null } | undefined;
}

/** What the controller publishes for the canvas. */
export interface WaveformFrames extends WaveformPlotFrames {
  /** When this was published (the controller's clock, ms); null before the first publish. */
  time: number | null;
}

export interface WaveformControllerOptions {
  /** The PV service; by default the controller creates, connects and owns a `HarePVService`. */
  service?: WaveformPVService;
  /** Clock, ms since the epoch (ring epochs and snapshot times compare on it). */
  now?: () => number;
  /** Animation-frame scheduling; `requestAnimationFrame` by default. */
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (handle: number) => void;
  /** Timers, for the metadata timeout only. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** The page is visible at construction (default true). */
  visible?: boolean;
  /** The page is wanted at construction (default true). */
  wanted?: boolean;
}

export const EMPTY_WAVEFORM_FRAMES: WaveformFrames = {
  live: {},
  reference: null,
  x: null,
  time: null,
};

function rollingSecondsOf(state: WaveformState): number | null {
  return state.reference?.kind === 'rolling' ? state.reference.seconds : null;
}

interface Entry {
  unsubscribe: () => void;
  ring: FrameRing;
  /** The live curve's rolling window while the reference is rolling. */
  rolling?: RollingWindow;
  /** The listener has reported at least once. */
  reported: boolean;
  connected: boolean;
  /** Connected at least once since the listener started (a later connect is a reconnect). */
  everConnected: boolean;
  numeric: boolean;
}

function refPvOf(state: WaveformState): string {
  return state.reference?.kind === 'pv' ? state.reference.pv : '';
}

/** Whether two references differ (a new snapshot object counts as a change). */
function referenceChanged(a: WaveformState['reference'], b: WaveformState['reference']): boolean {
  if (a === b) return false;
  if (a === null || b === null) return true;
  if (a.kind === 'pv' && b.kind === 'pv') return a.pv !== b.pv;
  if (a.kind === 'snapshot' && b.kind === 'snapshot') {
    return a.frames !== b.frames || a.time !== b.time;
  }
  if (a.kind === 'rolling' && b.kind === 'rolling') return a.seconds !== b.seconds;
  return true;
}

function isNumericValue(value: unknown): boolean {
  return Array.isArray(value) && (value.length === 0 || typeof value[0] !== 'string');
}

/**
 * Framework-free owner of the Waveform data path. Inputs: `setState`,
 * `setPageWanted`, `setVisible`, `setPaused`. Outputs: `getFrames` /
 * `subscribeFrames` and `getModel` / `subscribeModel`.
 */
export class WaveformController {
  private readonly service: WaveformPVService;
  private readonly owned: HarePVService | null;
  private readonly now: () => number;
  private readonly requestFrame: (cb: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private state: WaveformState = defaultWaveformState();
  private pageWanted: boolean;
  private visible: boolean;
  private paused = false;
  private disposed = false;

  private readonly entries = new Map<string, Entry>();
  private readonly buffers = new Map<string, CurveBuffers>();
  /** The averaging buffers' arrays: reused per publish, so a snapshot copies them. */
  private readonly averaged = new WeakSet<Float64Array>();
  private readonly meta: Record<string, WaveformPvMeta | undefined> = {};
  private metaTimedOut = false;
  private metaTimer: unknown = undefined;
  /** The live and reference PVs the metadata decision last covered, in order. */
  private metaKey = '';

  /** A frame was ingested since the last publish. */
  private dirty = false;
  /** A reference change waits for its forced publish (the page was hidden). */
  private forcePending = false;
  private frameHandle: number | null = null;
  private lastPublish = -Infinity;

  private frames: WaveformFrames = EMPTY_WAVEFORM_FRAMES;
  private model: WaveformModel;
  private readonly frameListeners = new Set<() => void>();
  private readonly modelListeners = new Set<() => void>();

  constructor(options: WaveformControllerOptions = {}) {
    if (options.service !== undefined) {
      this.service = options.service;
      this.owned = null;
    } else {
      const hare = new HarePVService(hareServiceOptions());
      hare.connect();
      this.service = hare;
      this.owned = hare;
    }
    this.now = options.now ?? (() => Date.now());
    this.requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = options.cancelFrame ?? ((h) => cancelAnimationFrame(h));
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer =
      options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.visible = options.visible ?? true;
    this.pageWanted = options.wanted ?? true;
    this.model = this.derive();
  }

  // ── Outputs ──────────────────────────────────────────────────────────────

  subscribeFrames = (listener: () => void): (() => void) => {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  };

  getFrames = (): WaveformFrames => this.frames;

  subscribeModel = (listener: () => void): (() => void) => {
    this.modelListeners.add(listener);
    return () => {
      this.modelListeners.delete(listener);
    };
  };

  getModel = (): WaveformModel => this.model;

  /** The PV service the controller listens on (for the health line). */
  get pvService(): WaveformPVService {
    return this.service;
  }

  // ── Inputs ───────────────────────────────────────────────────────────────

  /** Follow the tool state: listeners, ring capacities, the metadata decision. */
  setState(state: WaveformState): void {
    const prev = this.state;
    this.state = state;
    this.disposed = false;
    this.sync();
    this.syncMetaTimer();
    this.updateModel();
    if (referenceChanged(prev.reference, state.reference)) this.forcePublish();
  }

  /** The page is wanted (embedded: the host allows streaming). False releases every listener. */
  setPageWanted(wanted: boolean): void {
    if (wanted === this.pageWanted) return;
    this.pageWanted = wanted;
    this.sync();
    this.updateModel();
  }

  /** The page is visible. Hidden publishes nothing; becoming visible publishes once at once. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (!visible) {
      this.cancelScheduled();
      return;
    }
    if (this.forcePending) {
      this.forcePublish();
      return;
    }
    if (this.dirty && !this.paused) {
      this.cancelScheduled();
      this.publish(false);
    }
  }

  /** Pause freezes the published frames; ingest continues. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.cancelScheduled();
    else this.schedule();
  }

  /**
   * Snapshot → reference: every visible drawable live curve's last
   * published pre-Δ frame at full range, for `edit.setSnapshot`. Drawability is
   * judged with Δ off, so a curve missing from an earlier snapshot is taken.
   * A ring frame is kept by identity (a stored frame is never mutated, even
   * after the ring drops it); an averaged frame lives in a reused buffer and is
   * copied. Null when no curve has a published frame.
   *
   * With a rolling reference in place this freezes it instead:
   * each curve's rolling mean and σ, copied out of the reused window buffers,
   * with the window it came from.
   */
  captureSnapshot(): SnapshotInput | null {
    const judged = deriveWaveformModel({
      state: { ...this.state, delta: false },
      rings: this.summaries(),
      meta: this.meta,
      metaTimedOut: this.metaTimedOut,
      rolling: this.rollingCounts(),
    });
    const seconds = rollingSecondsOf(this.state);
    const out: Record<string, Float64Array> = {};
    const spread: Record<string, Float64Array> = {};
    let n = 0;
    for (const row of judged.live) {
      if (!row.drawable) continue;
      if (seconds !== null) {
        const stats = this.entries.get(row.pv)?.rolling?.stats(this.now()) ?? null;
        if (stats === null) continue;
        out[row.pv] = Float64Array.from(stats.mean);
        spread[row.pv] = Float64Array.from(stats.std);
        n++;
        continue;
      }
      const published = this.frames.live[row.pv];
      if (published === undefined) continue;
      const frame = published.frame;
      out[row.pv] = this.averaged.has(frame) ? Float64Array.from(frame) : frame;
      n++;
    }
    if (n === 0) return null;
    const time = this.now();
    return seconds === null
      ? { frames: out, time }
      : { frames: out, time, spread, rolling: seconds };
  }

  /** Release every listener and pending callback. `setState` revives the controller. */
  dispose(): void {
    this.disposed = true;
    this.cancelScheduled();
    if (this.metaTimer !== undefined) {
      this.clearTimer(this.metaTimer);
      this.metaTimer = undefined;
    }
    for (const [pv, entry] of this.entries) this.release(pv, entry);
    this.owned?.disconnect();
  }

  // ── Listeners ────────────────────────────────────────────────────────────

  /** The PVs to listen to now, each with its ring capacity. */
  private wantedPvs(): Map<string, number> {
    const out = new Map<string, number>();
    if (!this.pageWanted || this.disposed) return out;
    const s = this.state;
    const liveCap = ringCapacity(s.persist, s.avg);
    for (const pv of s.pvs) if (pv !== '' && s.hidden[pv] !== true) out.set(pv, liveCap);
    const ref = refPvOf(s);
    if (ref !== '' && s.hidden[ref] !== true && !out.has(ref)) out.set(ref, 1);
    if (s.xs !== '' && !out.has(s.xs)) out.set(s.xs, 1);
    return out;
  }

  private sync(): void {
    const wanted = this.wantedPvs();
    for (const [pv, entry] of this.entries) {
      if (!wanted.has(pv)) this.release(pv, entry);
    }
    if (wanted.size > 0) this.owned?.connect();
    for (const [pv, cap] of wanted) {
      const entry = this.entries.get(pv);
      if (entry === undefined) this.listen(pv, cap);
      else entry.ring.setCapacity(cap);
    }
    for (const pv of [...this.buffers.keys()]) if (!wanted.has(pv)) this.buffers.delete(pv);
    this.syncRolling();
  }

  /** Live entries keep a rolling window exactly while the reference is rolling. */
  private syncRolling(): void {
    const seconds = rollingSecondsOf(this.state);
    const live = new Set(this.state.pvs);
    for (const [pv, entry] of this.entries) {
      if (seconds === null || !live.has(pv)) {
        delete entry.rolling;
        continue;
      }
      if (entry.rolling === undefined) {
        const window = new RollingWindow(seconds);
        // Seeded with the frames the ring already holds, so a window turned
        // on over a running curve does not start from nothing.
        const frames = entry.ring.last(entry.ring.size);
        const stamps = entry.ring.arrivals(entry.ring.size);
        frames.forEach((frame, i) => window.push(frame, stamps[i]));
        entry.rolling = window;
      } else entry.rolling.setSeconds(seconds);
    }
  }

  /** Per live PV, the frames inside its rolling window now (for the model). */
  private rollingCounts(): Record<string, number> | undefined {
    if (rollingSecondsOf(this.state) === null) return undefined;
    const now = this.now();
    const out: Record<string, number> = {};
    for (const pv of this.state.pvs) {
      out[pv] = this.entries.get(pv)?.rolling?.stats(now)?.frames ?? 0;
    }
    return out;
  }

  private listen(pv: string, capacity: number): void {
    const entry: Entry = {
      unsubscribe: () => {},
      ring: new FrameRing(capacity, this.now()),
      reported: false,
      connected: false,
      everConnected: false,
      numeric: true,
    };
    // The SDK calls back synchronously with a cached snapshot, so the entry
    // exists before subscribing.
    this.entries.set(pv, entry);
    entry.unsubscribe = this.service.subscribe(pv, (data) => {
      if (this.entries.get(pv) !== entry) return;
      this.ingest(pv, entry, data);
    });
  }

  private release(pv: string, entry: Entry): void {
    this.entries.delete(pv);
    entry.ring.setWanted(false, this.now());
    entry.unsubscribe();
  }

  private ingest(pv: string, entry: Entry, data: PVData): void {
    const at = this.now();
    entry.reported = true;
    const meta = this.service.getMeta(pv);
    if (meta !== undefined) {
      const egu = meta.units ?? '';
      if (this.meta[pv]?.egu !== egu) this.meta[pv] = { egu };
    }
    if (!data.connected) {
      entry.connected = false;
    } else {
      if (entry.everConnected && !entry.connected) {
        entry.ring.reconnect(at);
        entry.rolling?.reset();
      }
      entry.connected = true;
      entry.everConnected = true;
      const value = data.value;
      if (Array.isArray(value)) {
        entry.numeric = isNumericValue(value);
        const frame = entry.ring.push(value, at);
        if (frame !== null) entry.rolling?.push(frame, at);
        this.dirty = true;
        this.schedule();
      }
    }
    this.updateModel();
  }

  // ── Metadata timeout ────────────────────────────────────────────────

  private syncMetaTimer(): void {
    const s = this.state;
    const ref = refPvOf(s);
    const order = ref === '' ? s.pvs : [...s.pvs, ref];
    const key = order.join('\n');
    if (key === this.metaKey) return;
    this.metaKey = key;
    if (order.every((pv) => this.meta[pv] !== undefined)) return;
    // A PV whose metadata has not arrived: give it the window afresh.
    if (this.metaTimer !== undefined) this.clearTimer(this.metaTimer);
    this.metaTimedOut = false;
    this.metaTimer = this.setTimer(() => {
      this.metaTimer = undefined;
      this.metaTimedOut = true;
      this.updateModel();
    }, WAVEFORM_META_TIMEOUT_MS);
  }

  // ── Model ────────────────────────────────────────────────────────────────

  private summaries(): Record<string, WaveformRingSummary> {
    const out: Record<string, WaveformRingSummary> = {};
    for (const [pv, entry] of this.entries) {
      if (!entry.reported) continue;
      out[pv] = {
        connected: entry.connected,
        length: entry.ring.frameLength,
        resetEpoch: entry.ring.resetEpoch,
        arrival: entry.ring.latestArrival(),
        numeric: entry.numeric,
      };
    }
    return out;
  }

  private derive(): WaveformModel {
    const rolling = this.rollingCounts();
    return deriveWaveformModel({
      state: this.state,
      rings: this.summaries(),
      meta: this.meta,
      metaTimedOut: this.metaTimedOut,
      ...(rolling !== undefined ? { rolling } : {}),
    });
  }

  private updateModel(): void {
    const next = this.derive();
    if (sameData(next, this.model)) return;
    this.model = next;
    for (const listener of this.modelListeners) listener();
  }

  // ── Publish ──────────────────────────────────────────────────────────────

  /** The shortest interval between publishes; `hz` at Hare's cadence is no cap. */
  private minInterval(): number {
    const hz = this.state.hz;
    return hz >= MAX_HZ || !(hz > 0) ? 0 : 1000 / hz;
  }

  private schedule(): void {
    if (!this.dirty || this.paused || !this.visible || this.disposed) return;
    if (this.frameHandle !== null) return;
    this.frameHandle = this.requestFrame(this.onFrame);
  }

  private cancelScheduled(): void {
    if (this.frameHandle === null) return;
    this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
  }

  private onFrame = (): void => {
    this.frameHandle = null;
    if (!this.dirty || this.paused || !this.visible || this.disposed) return;
    if (this.now() - this.lastPublish < this.minInterval()) {
      // `hz` lengthens the interval: look again next animation frame.
      this.frameHandle = this.requestFrame(this.onFrame);
      return;
    }
    this.publish(false);
  };

  /** One publish past `hz` and Pause (a reference change); deferred while hidden. */
  private forcePublish(): void {
    if (!this.visible || this.disposed) {
      this.forcePending = true;
      return;
    }
    this.forcePending = false;
    this.cancelScheduled();
    this.publish(this.paused);
  }

  /** Publish the rings' current frames; `frozen` keeps the live and X frames as last published. */
  private publish(frozen: boolean): void {
    const s = this.state;
    let live: Record<string, WaveformCurveFrames | undefined>;
    let x: Float64Array | null;
    if (frozen) {
      live = this.frames.live;
      x = this.frames.x;
    } else {
      live = {};
      for (const pv of s.pvs) {
        const curve = this.curveFrames(pv);
        if (curve !== null) live[pv] = curve;
      }
      x = s.xs === '' ? null : (this.entries.get(s.xs)?.ring.latest() ?? null);
      this.dirty = false;
    }
    const ref = refPvOf(s);
    const reference = ref === '' ? null : (this.entries.get(ref)?.ring.latest() ?? null);
    const time = this.now();
    this.lastPublish = time;
    // The rolling statistics are as of this publish (a frozen publish under
    // Pause republishes the window as it stands; ingest keeps feeding it).
    const rolling = this.rollingFrames(time);
    this.frames =
      rolling === undefined ? { live, reference, x, time } : { live, reference, x, time, rolling };
    for (const listener of this.frameListeners) listener();
  }

  /** Per live PV, its rolling window's statistics as of `at`; absent without a rolling reference. */
  private rollingFrames(at: number): Record<string, RollingFrame | undefined> | undefined {
    if (rollingSecondsOf(this.state) === null) return undefined;
    const out: Record<string, RollingFrame | undefined> = {};
    for (const pv of this.state.pvs) {
      const stats = this.entries.get(pv)?.rolling?.stats(at) ?? null;
      if (stats !== null) out[pv] = stats;
    }
    return out;
  }

  private curveFrames(pv: string): WaveformCurveFrames | null {
    const ring = this.entries.get(pv)?.ring;
    const latest = ring?.latest() ?? null;
    if (ring === undefined || latest === null) return null;
    const s = this.state;
    let frame = latest;
    if (s.avg > 1) {
      let buf = this.buffers.get(pv);
      if (buf === undefined) {
        buf = new CurveBuffers();
        this.buffers.set(pv, buf);
      }
      const mean = buf.average(ring.last(s.avg));
      if (mean !== null) {
        this.averaged.add(mean);
        frame = mean;
      }
    }
    if (s.persist <= 1) return { frame };
    const held = ring.last(s.persist);
    return { frame, trails: held.slice(0, held.length - 1) };
  }
}
