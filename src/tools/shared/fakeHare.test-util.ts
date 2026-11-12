// A faked SDK `HarePVService` for the context tools' tests. It keeps the
// SDK's semantics the PV tracker relies on (`HarePVService.ts`): a new listener gets the
// cached snapshot at once; an `initial` frame first stores the meta of every
// subscribed PV, then applies its values in the frame's order, one listener
// call per PV; `units` on a snapshot come from the meta cache; the last
// unsubscribe of a PV drops its snapshot and meta.

import {
  DISCONNECTED_PV,
  type PVData,
  type PVListener,
  type ValueKind,
} from '@slaclab/canopy-client';

export interface FakeValue {
  connected?: boolean;
  valueKind?: ValueKind;
  value?: PVData['value'];
}

export class FakeHare {
  private readonly listeners = new Map<string, Set<PVListener>>();
  private readonly snapshots = new Map<string, PVData>();
  private readonly metas = new Map<string, { units: string | null }>();
  /** Every subscribe/unsubscribe, for assertions. */
  readonly log: string[] = [];

  subscribe(pvName: string, listener: PVListener): () => void {
    let set = this.listeners.get(pvName);
    if (!set) {
      set = new Set();
      this.listeners.set(pvName, set);
      this.log.push(`+${pvName}`);
    }
    set.add(listener);
    const snapshot = this.snapshots.get(pvName);
    if (snapshot) listener(snapshot);
    return () => {
      const subs = this.listeners.get(pvName);
      if (!subs) return;
      subs.delete(listener);
      if (subs.size === 0) {
        this.listeners.delete(pvName);
        this.snapshots.delete(pvName);
        this.metas.delete(pvName);
        this.log.push(`-${pvName}`);
      }
    };
  }

  getMeta(pvName: string): { units: string | null } | undefined {
    return this.metas.get(pvName);
  }

  getSnapshot(pvName: string): PVData | undefined {
    return this.snapshots.get(pvName);
  }

  /** PVs with at least one listener. */
  subscribed(): string[] {
    return [...this.listeners.keys()].sort();
  }

  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  /** An `initial` frame: meta first, then values in the given order. */
  initial(frame: Array<[pv: string, units: string | null, value: FakeValue]>): void {
    for (const [pv, units] of frame) {
      if (this.listeners.has(pv)) this.metas.set(pv, { units });
    }
    for (const [pv, , value] of frame) this.apply(pv, value);
  }

  /** A `diff` frame: values only. */
  diff(frame: Array<[pv: string, value: FakeValue]>): void {
    for (const [pv, value] of frame) this.apply(pv, value);
  }

  private apply(pv: string, value: FakeValue): void {
    const subs = this.listeners.get(pv);
    if (!subs) return;
    const data: PVData = {
      ...DISCONNECTED_PV,
      value: value.value ?? 0,
      connected: value.connected !== false,
      units: this.metas.get(pv)?.units ?? '',
      valueKind: value.valueKind ?? 'scalar',
    };
    this.snapshots.set(pv, data);
    for (const listener of subs) listener(data);
  }
}

/** A disconnected placeholder, as Hare sends for an unreachable PV. */
export const DOWN: FakeValue = { connected: false, valueKind: 'scalar' };
export const SCALAR: FakeValue = { connected: true, valueKind: 'scalar', value: 1 };
export const ENUM: FakeValue = { connected: true, valueKind: 'enum', value: 1 };
export const WAVEFORM: FakeValue = { connected: true, valueKind: 'waveform', value: [1, 2] };
export const STRING: FakeValue = { connected: true, valueKind: 'string', value: 'on' };
