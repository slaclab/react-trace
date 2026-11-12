// The correlation tab's Formula Engine `table` subscription: one subscription
// at a time over the instance's SDK `FormulaEngineService`, the frame the plot
// draws, and the health line.
//
// Subscribed = (not embedded, or the host has sent visible:true at least
// once) and not hidden for more than 10 s. A hidden-mounted instance thus
// never subscribes until it is shown, standalone subscribes at once.
//
// Each subscribe mints a subscription id (a counter); the SDK callbacks carry
// it, and only the newest id counts — for health and for the plot. The SDK
// keeps a subscription across reconnects, so the id is stable per subscribe.
//
// A spec change (role, trigger, N, lookback) is applied 300 ms after the last
// edit: the old subscription's unsubscribe and the new subscribe run in the
// same synchronous block, so the SDK sends `unsubscribe` then `subscribe`
// back to back and the Formula Engine hands the lingering store's columns to the new eval.
// The plot keeps the old frame, with its own column→PV map, until the new
// id's first result.
//
// A non-retryable error ends the subscription: the controller unsubscribes it
// (the server keeps polling after one, and the SDK would re-send it on every
// reconnect). Only Retry or a spec change subscribes again. A retryable error
// (the Formula Engine's seed wait) never ends it.
//
// Pause is client-side: nothing is sent. Frames keep arriving and the newest
// is kept; the drawn frame stays frozen and Resume shows the newest at once.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  FormulaEngineService,
  type FormulaResultDTO,
  type FormulaSpec,
  type FormulaEngineConnectionStatus,
  type FormulaEngineError,
  type FormulaEngineServiceOptions,
  type FormulaEngineSubscribeOptions,
  type TableResultDTO,
} from '@slaclab/canopy-client';
import { isEmbedded } from '../../embed/embedded';
import {
  getEverVisible,
  getSnapshot as getBridgeSnapshot,
  subscribe as subscribeBridge,
  subscribeEverVisible,
} from '../../embed/bridge';
import {
  healthLine,
  initialHealth,
  reduceHealth,
  type HealthEvent,
  type HealthLine,
  type HealthPVSource,
  type HealthState,
} from './health';
import type { CorrelationState } from './query';
import { buildTableSpec, type TableSpec, type TableSpecResult } from './spec';
import { rowsPerSecond } from './stats';
import { formulaEngineServiceOptions } from '../shared/canopyServices';
import { type PvModel } from '../shared/pvTracker';

/** Spec edits settle this long before the subscription is swapped. */
export const SPEC_DEBOUNCE_MS = 300;
/** Hidden longer than this: the subscription is released. */
export const HIDDEN_LONG_MS = 10_000;
/** The health line is re-evaluated this often. */
export const HEALTH_TICK_MS = 1000;

/** What the controller needs of the SDK `FormulaEngineService`. */
export interface FormulaEngineTableService {
  readonly status: FormulaEngineConnectionStatus;
  connect(): void;
  dispose(): void;
  subscribe(spec: FormulaSpec, opts: FormulaEngineSubscribeOptions): () => void;
}

export type FormulaEngineFactory = (
  options: FormulaEngineServiceOptions
) => FormulaEngineTableService;

export const defaultFormulaEngineFactory: FormulaEngineFactory = (options) =>
  new FormulaEngineService(options);

/** A result frame with the column→PV map of the spec it was subscribed with. */
export interface PlotFrame {
  id: number;
  table: TableResultDTO;
  columnPvs: Record<string, string>;
}

export interface TableSnapshot {
  health: HealthState;
  /** The frame the plot draws: frozen while paused. */
  frame: PlotFrame | null;
  /** The spec of the current subscription id; null before the first. */
  spec: TableSpec | null;
}

interface Active {
  id: number;
  key: string;
  unsubscribe: () => void;
}

/**
 * Framework-free owner of one tab's subscription. Inputs: `setSpec`,
 * `setWanted`, `setPaused`, `retry`, the Formula Engine service (`attach`/`detach`) and
 * its status (`setStatus`). Output: `getSnapshot`.
 */
export class TableController {
  private engine: FormulaEngineTableService | null = null;
  private health: HealthState = initialHealth();
  /** The applied spec (after the debounce); null for none. */
  private desired: TableSpec | null = null;
  private queued: { key: string | null; table: TableSpec | null } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wanted = false;
  private active: Active | null = null;
  /** Key of the desired spec while it is errored. */
  private erroredKey: string | null = null;
  private counter = 0;
  private current: TableSpec | null = null;
  private latest: PlotFrame | null = null;
  private shown: PlotFrame | null = null;
  private paused = false;
  private snapshot: TableSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.snapshot = this.build();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): TableSnapshot => this.snapshot;

  /** Use `engine` from now on; subscribes if wanted. */
  attach(engine: FormulaEngineTableService): void {
    this.engine = engine;
    this.dispatch({ type: 'service', status: engine.status });
    this.reconcile();
    this.emit();
  }

  isAttached(engine: FormulaEngineTableService): boolean {
    return this.engine === engine;
  }

  /** Release the subscription and forget the service (health is kept). */
  detach(): void {
    this.drop();
    this.engine = null;
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.queued = null;
    this.detach();
  }

  setStatus(status: FormulaEngineConnectionStatus): void {
    this.dispatch({ type: 'status', status });
    this.emit();
  }

  /** Follow the spec; `undecided` keeps what is there. Debounced. */
  setSpec(result: TableSpecResult): void {
    if (result.kind === 'undecided') return;
    const table = result.kind === 'ready' ? result.table : null;
    const key = table?.key ?? null;
    if (this.queued !== null && this.queued.key === key) {
      this.queued.table = table;
      return;
    }
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.queued = null;
    if (key === (this.desired?.key ?? null)) return;
    this.queued = { key, table };
    this.timer = setTimeout(() => {
      const next = this.queued;
      this.timer = undefined;
      this.queued = null;
      if (next !== null) this.apply(next.table);
    }, SPEC_DEBOUNCE_MS);
  }

  setWanted(wanted: boolean): void {
    if (wanted === this.wanted) return;
    this.wanted = wanted;
    this.reconcile();
    this.emit();
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (!paused) this.shown = this.latest ?? this.shown;
    this.emit();
  }

  /** Subscribe the errored spec again, as a new id. */
  retry(): void {
    if (this.health.sub !== 'errored') return;
    this.erroredKey = null;
    this.reconcile();
    this.emit();
  }

  private apply(table: TableSpec | null): void {
    this.desired = table;
    this.erroredKey = null;
    if (table === null) this.dispatch({ type: 'none' });
    this.reconcile();
    this.emit();
  }

  private target(): TableSpec | null {
    const desired = this.desired;
    if (!this.wanted || this.engine === null || desired === null) return null;
    return desired.key === this.erroredKey ? null : desired;
  }

  // Old unsubscribe first, then the new subscribe, in one synchronous block.
  private reconcile(): void {
    const target = this.target();
    if (this.active !== null && this.active.key !== target?.key) this.drop();
    if (target === null || this.active !== null || this.engine === null) return;
    const id = ++this.counter;
    this.current = target;
    this.dispatch({ type: 'subscribe', id });
    const unsubscribe = this.engine.subscribe(target.spec, {
      t0Ns: target.t0Ns,
      onResult: (data) => this.onResult(id, data),
      onError: (error) => this.onError(id, error),
    });
    this.active = { id, key: target.key, unsubscribe };
  }

  private drop(): void {
    const active = this.active;
    this.active = null;
    active?.unsubscribe();
  }

  private onResult(id: number, data: FormulaResultDTO): void {
    const table = data.table;
    if (table == null || id !== this.health.id || this.active?.id !== id) return;
    this.dispatch({ type: 'result', id, table, now: Date.now() });
    const spec = this.current;
    this.latest = { id, table, columnPvs: spec?.columnPvs ?? {} };
    if (!this.paused) this.shown = this.latest;
    this.emit();
  }

  private onError(id: number, error: FormulaEngineError): void {
    if (id !== this.health.id || this.active?.id !== id) return;
    this.dispatch({ type: 'error', id, error });
    if (!error.retryable) {
      this.erroredKey = this.active.key;
      this.drop();
    }
    this.emit();
  }

  private dispatch(event: HealthEvent): void {
    this.health = reduceHealth(this.health, event);
  }

  private build(): TableSnapshot {
    return { health: this.health, frame: this.shown, spec: this.current };
  }

  private emit(): void {
    const next = this.build();
    const prev = this.snapshot;
    if (next.health === prev.health && next.frame === prev.frame && next.spec === prev.spec) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

// ── React binding ─────────────────────────────────────────────────────────

export interface UseTableOptions {
  state: CorrelationState;
  model: PvModel;
  paused: boolean;
  /** The instance's Hare service: per-PV status for the health line. */
  hare: HealthPVSource;
  /** Builds the instance's Formula Engine service; the SDK's by default. */
  createFormulaEngine?: FormulaEngineFactory;
}

export interface TableView {
  /** The frame the plot draws, with its own column→PV map. */
  frame: PlotFrame | null;
  health: HealthLine;
  /** Re-subscribe after a non-retryable error. */
  retry: () => void;
}

/** True once the bridge allows subscribing, and while not hidden long. */
function useWanted(now: number): boolean {
  const bridge = useSyncExternalStore(subscribeBridge, getBridgeSnapshot);
  const everVisible = useSyncExternalStore(subscribeEverVisible, getEverVisible);
  const hiddenLong =
    !bridge.visible && bridge.hiddenAt !== undefined && now - bridge.hiddenAt > HIDDEN_LONG_MS;
  return (!isEmbedded() || everVisible) && !hiddenLong;
}

export function useTable({
  state,
  model,
  paused,
  hare,
  createFormulaEngine = defaultFormulaEngineFactory,
}: UseTableOptions): TableView {
  const [controller] = useState(() => new TableController());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), HEALTH_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    // Status changes of a service already replaced (StrictMode, a new
    // factory) must not reach the health state.
    const engine: FormulaEngineTableService = createFormulaEngine({
      ...formulaEngineServiceOptions(),
      onStatusChange: (status) => {
        if (controller.isAttached(engine)) controller.setStatus(status);
      },
    });
    controller.attach(engine);
    engine.connect();
    return () => {
      controller.detach();
      engine.dispose();
    };
  }, [controller, createFormulaEngine]);

  useEffect(() => () => controller.dispose(), [controller]);

  const spec = useMemo(() => buildTableSpec(state, model), [state, model]);
  useEffect(() => controller.setSpec(spec), [controller, spec]);

  const wanted = useWanted(now);
  useEffect(() => controller.setWanted(wanted), [controller, wanted]);
  useEffect(() => controller.setPaused(paused), [controller, paused]);

  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const health = healthLine(
    snapshot.health,
    {
      paused,
      trigger: snapshot.spec?.trigger ?? null,
      bindingPvs: snapshot.spec?.bindingPvs ?? {},
      pvs: hare,
      rowsPerS: snapshot.frame === null ? null : rowsPerSecond(snapshot.frame.table.tsNs),
    },
    now
  );
  return { frame: snapshot.frame, health, retry: () => controller.retry() };
}
