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
// `evaluate` is injected so the policy can be tested without the network, and
// errors are duck-typed on `{ code, detail, status }` rather than tied to one
// error class.

export interface FormulaErrorInfo {
  code: string;
  detail: string;
  status?: number;
}

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

interface Internal {
  spec: FormulaSpecDTO;
  identity: string;
  data: FormulaEntry;
  // Window of the in-flight (or most recent) evaluation.
  requested: TimeWindowNs | null;
  controller: AbortController | null;
}

type Listener = () => void;

export class FormulaStore {
  private readonly deps: FormulaStoreDeps;
  private entries = new Map<string, Internal>();
  private snapshot: ReadonlyMap<string, FormulaEntry> = new Map();
  private listeners = new Set<Listener>();

  constructor(deps: FormulaStoreDeps) {
    this.deps = deps;
  }

  getSnapshot = (): ReadonlyMap<string, FormulaEntry> => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // Ask for trace `id` to show `req.spec` over `req.window`. Calling it again
  // with the same inputs is a no-op that doesn't publish.
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
        requested: null,
        controller: null,
      };
      this.entries.set(id, entry);
      this.start(id, entry, req.window);
      this.publish();
      return;
    }
    if (!this.shouldEvaluate(existing, req.window)) return;
    // Same identity: the current points stay up until the new answer lands.
    this.start(id, existing, req.window);
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

  // Re-evaluate whenever this trace's own window moves (one trace's change
  // never touches another's request).
  private shouldEvaluate(entry: Internal, win: TimeWindowNs): boolean {
    const prev = entry.requested;
    return !prev || prev.fromNs !== win.fromNs || prev.toNs !== win.toNs;
  }

  private start(id: string, entry: Internal, win: TimeWindowNs): void {
    entry.controller?.abort();
    const controller = new AbortController();
    entry.controller = controller;
    entry.requested = win;
    let pending: Promise<FormulaResultDTO>;
    try {
      pending = this.deps.evaluate(entry.spec, win.fromNs, win.toNs, controller.signal);
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      (res) => {
        if (!this.owns(id, entry, controller)) return;
        entry.controller = null;
        entry.data = {
          identity: entry.identity,
          status: 'ready',
          points: toPoints(res),
          decimated: !!res.timeseries?.decimated,
        };
        this.publish();
      },
      (err: unknown) => {
        if (!this.owns(id, entry, controller) || isAbort(err)) return;
        entry.controller = null;
        // Points survive only because the identity is unchanged: they are the
        // last good result for this same spec.
        entry.data = { ...entry.data, status: 'error', error: formulaErrorInfo(err) };
        this.publish();
      }
    );
  }

  // The settling request is still the current one for a live entry.
  private owns(id: string, entry: Internal, controller: AbortController): boolean {
    return this.entries.get(id) === entry && entry.controller === controller;
  }

  private drop(entry: Internal): void {
    entry.controller?.abort();
    entry.controller = null;
  }

  private publish(): void {
    const next = new Map<string, FormulaEntry>();
    for (const [id, entry] of this.entries) next.set(id, entry.data);
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
