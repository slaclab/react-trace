// The PV tracker of the context tools (Correlation, Waveform): the PVs in a
// tool's roles and their live metadata.
//
// Every PV in a role (X, each Y, the trigger PV) gets one listener on the
// instance's SDK `HarePVService`. Its kind is read only from connected
// snapshots (`PVData.valueKind`), never from a disconnected placeholder; its
// units are re-read from `getMeta()` on every listener call, because the Hare
// broker re-describes a PV on its first successful connect and pushes a second
// `initial` with the metadata, which the SDK stores in its meta cache.
//
// Rules:
//   - kind: the tracker's accepted kinds (a constructor parameter) are
//     accepted; any other kind is refused. Correlation accepts scalar and enum
//     (`CORRELATION_KINDS`), Waveform accepts waveform
//     (`WAVEFORM_KINDS`). A refusal whose PV is a waveform carries the reason
//     `waveform`, one whose PV is scalar or enum the reason `scalar`, so a tool
//     can offer the other tool instead of a dead end. A PV with no connected
//     snapshot after 3 s is "unverified" and plotted, and refused later if its
//     kind proves unaccepted.
//   - unit (Y only): decided once every Y has metadata or has passed the 3 s
//     timeout. The axis unit is the first non-empty unit in Y order; later Ys
//     with another non-empty unit are refused. With no unit at that point the
//     axis stays unset until the first non-empty unit arrives (in Y order
//     within one Hare frame), which sets it. Once set the axis is frozen: late
//     data refuses only its own PV. It unfreezes when no accepted Y carries it
//     any more, and the decision re-runs over the remaining Ys.
//   - refused PVs that came from the state (a query, a saved view, a default)
//     stay in their role, unplotted, so loading never mutates the state; only
//     a typed PV is refused inline and not added (see `probe`).
//
// Listeners live from add until the PV leaves its role or the instance
// unmounts: nothing here watches Pause or visibility.

import type { PVListener, ValueKind } from '@slaclab/canopy-client';

/** No metadata within this window: the PV is added as "unverified". */
export const METADATA_TIMEOUT_MS = 3000;

/** What the tracker needs of a PV service: listeners and the meta cache. */
export interface MetaPVService {
  subscribe(pvName: string, listener: PVListener): () => void;
  getMeta(pvName: string): { units: string | null } | undefined;
}

export type PvRole = 'x' | 'y' | 'trig';

/** The value kinds a tool plots. */
export type KindRule = readonly ValueKind[];

/** Correlation plots scalar and enum PVs (enum by index). */
export const CORRELATION_KINDS: KindRule = ['scalar', 'enum'];

/** Waveform plots array PVs. */
export const WAVEFORM_KINDS: KindRule = ['waveform'];

/**
 * The machine-readable reason of a kind refusal: what the refused PV is, so a
 * tool can point at the tool that plots it. Absent for kinds no tool plots.
 */
export type KindReason = 'waveform' | 'scalar';

/**
 * - pending: no connected snapshot yet, within the 3 s window
 * - ok: connected, of an accepted kind
 * - unverified: no connected snapshot within 3 s; plotted
 * - refused-kind / refused-unit: kept in its role, not plotted
 */
export type PvStatus = 'pending' | 'ok' | 'unverified' | 'refused-kind' | 'refused-unit';

export interface PvInfo {
  pv: string;
  status: PvStatus;
  /** The kind of the last connected snapshot; undefined until one arrives. */
  kind?: ValueKind;
  /** Units from the meta cache; '' when unknown. */
  units: string;
  /** The reason, for a refused PV. */
  message?: string;
  /** For a kind-refused PV, the machine-readable reason (see `KindReason`). */
  reason?: KindReason;
}

export interface PvModel {
  x: PvInfo | null;
  ys: PvInfo[];
  trig: PvInfo | null;
  /** The frozen Y axis unit; null while unset. */
  axisUnit: string | null;
  /**
   * Every current Y has metadata or has passed the timeout. A Formula Engine spec is
   * built only once this holds for its Ys.
   */
  decided: boolean;
}

export interface PvRoles {
  x: string;
  ys: string[];
  trig: string;
}

export type ProbeResult =
  | { ok: true; info: PvInfo }
  | { ok: false; message: string; reason?: KindReason };

export const EMPTY_PV_MODEL: PvModel = {
  x: null,
  ys: [],
  trig: null,
  axisUnit: null,
  decided: true,
};

/** Whether a PV in this state is drawn. */
export function isPlotted(info: PvInfo | null | undefined): boolean {
  return info?.status === 'ok' || info?.status === 'unverified';
}

export function kindMessage(pv: string, kind: ValueKind, rule: KindRule): string {
  return `${pv} is a ${kind} PV; only ${rule.join(' and ')} PVs can be plotted.`;
}

/** The reason of refusing a PV of `kind`; undefined when no tool plots it. */
export function kindReason(kind: ValueKind): KindReason | undefined {
  if (kind === 'waveform') return 'waveform';
  if (kind === 'scalar' || kind === 'enum') return 'scalar';
  return undefined;
}

export function unitMessage(pv: string, units: string, axis: string): string {
  return `${pv} is in ${units}; Y axis is ${axis}. Open a new correlation tab (+) for it.`;
}

interface Entry {
  unsubscribe: () => void;
  timer: number | undefined;
  timedOut: boolean;
  verified: boolean;
  kind?: ValueKind;
  units: string;
  waiters: Array<() => void>;
}

/**
 * Framework-free owner of one instance's PV listeners and the kind and unit
 * decision. `setRoles` follows the tool's state; `probe` checks a typed PV
 * before it is added.
 */
export class PvTracker {
  private readonly service: MetaPVService;
  private readonly kinds: KindRule;
  private readonly entries = new Map<string, Entry>();
  private readonly probes = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private roles: PvRoles = { x: '', ys: [], trig: '' };
  private axisUnit: string | null = null;
  private axisDecided = false;
  private model: PvModel = EMPTY_PV_MODEL;
  private scheduled = false;
  private disposed = false;

  constructor(service: MetaPVService, kinds: KindRule) {
    this.service = service;
    this.kinds = kinds;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getModel = (): PvModel => this.model;

  /** Follow the state's roles: listen to new PVs, release departed ones. */
  setRoles(roles: PvRoles): void {
    this.disposed = false;
    this.roles = { x: roles.x, ys: [...roles.ys], trig: roles.trig };
    for (const pv of this.roleNames()) this.probes.delete(pv);
    this.syncEntries();
    this.compute();
  }

  /**
   * Check a typed PV for `role` before it is added: resolves once it is
   * verified or the timeout passes. A refused PV is released at once; an
   * accepted one stays held until it appears in the roles (or `endProbe`).
   */
  probe(pv: string, role: PvRole): Promise<ProbeResult> {
    this.disposed = false;
    this.probes.add(pv);
    this.syncEntries();
    const entry = this.entries.get(pv) as Entry;
    return new Promise<ProbeResult>((resolve) => {
      const settle = () => {
        const result = this.judgeProbe(pv, role);
        if (!result.ok) this.endProbe(pv);
        resolve(result);
      };
      if (entry.verified || entry.timedOut) settle();
      else entry.waiters.push(settle);
    });
  }

  /** Drop a probe's hold on a PV (released unless it is in a role). */
  endProbe(pv: string): void {
    if (!this.probes.delete(pv)) return;
    this.syncEntries();
  }

  /** Release every listener; the tracker can be revived by `setRoles`. */
  dispose(): void {
    this.disposed = true;
    this.probes.clear();
    for (const [pv, entry] of this.entries) this.release(pv, entry);
    this.axisUnit = null;
    this.axisDecided = false;
  }

  private roleNames(): Set<string> {
    const names = new Set<string>();
    if (this.roles.x !== '') names.add(this.roles.x);
    for (const y of this.roles.ys) if (y !== '') names.add(y);
    if (this.roles.trig !== '') names.add(this.roles.trig);
    return names;
  }

  private syncEntries(): void {
    const wanted = this.roleNames();
    for (const pv of this.probes) wanted.add(pv);
    for (const [pv, entry] of this.entries) {
      if (!wanted.has(pv)) this.release(pv, entry);
    }
    for (const pv of wanted) {
      if (!this.entries.has(pv)) this.listen(pv);
    }
  }

  private listen(pv: string): void {
    const entry: Entry = {
      unsubscribe: () => {},
      timer: undefined,
      timedOut: false,
      verified: false,
      units: '',
      waiters: [],
    };
    this.entries.set(pv, entry);
    entry.timer = window.setTimeout(() => {
      entry.timer = undefined;
      entry.timedOut = true;
      this.settleWaiters(entry);
      this.compute();
    }, METADATA_TIMEOUT_MS);
    // The SDK calls back synchronously with a cached snapshot, so the entry
    // exists before subscribing.
    entry.unsubscribe = this.service.subscribe(pv, (data) => {
      if (this.entries.get(pv) !== entry) return;
      if (data.connected) {
        entry.verified = true;
        if (data.valueKind !== undefined) entry.kind = data.valueKind;
      }
      entry.units = this.service.getMeta(pv)?.units ?? '';
      this.settleWaiters(entry);
      this.schedule();
    });
  }

  private release(pv: string, entry: Entry): void {
    if (entry.timer !== undefined) window.clearTimeout(entry.timer);
    entry.waiters = [];
    this.entries.delete(pv);
    entry.unsubscribe();
  }

  private settleWaiters(entry: Entry): void {
    if (!entry.verified && !entry.timedOut) return;
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const settle of waiters) settle();
  }

  // Listener calls of one Hare frame arrive back to back; deciding after the
  // frame lets "Y order within one frame" hold whatever the frame's order.
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    void Promise.resolve().then(() => {
      this.scheduled = false;
      if (!this.disposed) this.compute();
    });
  }

  private kindInfo(pv: string): PvInfo {
    const entry = this.entries.get(pv);
    if (entry === undefined) return { pv, status: 'pending', units: '' };
    const { kind, units } = entry;
    if (entry.verified) {
      if (kind !== undefined && !this.kinds.includes(kind)) {
        const info: PvInfo = {
          pv,
          status: 'refused-kind',
          kind,
          units,
          message: kindMessage(pv, kind, this.kinds),
        };
        const reason = kindReason(kind);
        if (reason !== undefined) info.reason = reason;
        return info;
      }
      return { pv, status: 'ok', kind, units };
    }
    return { pv, status: entry.timedOut ? 'unverified' : 'pending', kind, units };
  }

  private judgeProbe(pv: string, role: PvRole): ProbeResult {
    const info = this.kindInfo(pv);
    if (info.status === 'refused-kind') {
      const message = info.message as string;
      return info.reason === undefined
        ? { ok: false, message }
        : { ok: false, message, reason: info.reason };
    }
    const axis = this.axisUnit;
    if (
      role === 'y' &&
      this.axisDecided &&
      axis !== null &&
      info.units !== '' &&
      info.units !== axis
    ) {
      return { ok: false, message: unitMessage(pv, info.units, axis) };
    }
    return { ok: true, info };
  }

  private compute(): void {
    const ys = this.roles.ys.filter((y) => y !== '');
    const infos = ys.map((y) => this.kindInfo(y));
    const decided = infos.every((i) => i.status !== 'pending');
    if (decided) this.axisDecided = true;

    if (this.axisDecided) {
      const candidates = infos.filter((i) => i.status !== 'refused-kind');
      if (this.axisUnit !== null && !candidates.some((i) => i.units === this.axisUnit)) {
        this.axisUnit = null;
      }
      if (this.axisUnit === null) {
        this.axisUnit = candidates.find((i) => i.units !== '')?.units ?? null;
      }
      const axis = this.axisUnit;
      if (axis !== null) {
        for (const info of candidates) {
          if (info.units !== '' && info.units !== axis) {
            info.status = 'refused-unit';
            info.message = unitMessage(info.pv, info.units, axis);
          }
        }
      }
    }

    this.model = {
      x: this.roles.x === '' ? null : this.kindInfo(this.roles.x),
      ys: infos,
      trig: this.roles.trig === '' ? null : this.kindInfo(this.roles.trig),
      axisUnit: this.axisUnit,
      decided,
    };
    for (const listener of this.listeners) listener();
  }
}
