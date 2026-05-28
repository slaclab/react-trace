import { fetchData } from '../api/mole';
import { CanopyError } from '../api/client';
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
  error?: { code: string; detail: string };
}

// Identity that, when changed, forces a wipe + full refetch. Mode is included
// because crossing the raw/binned threshold means the cached samples are the
// wrong shape for the new view.
interface HardKey {
  pv: string;
  archiver: string | null; // null → backend default
  bins: number;
  mode: 'raw' | 'binned';
}

interface InternalEntry {
  hardKey: HardKey;
  data: ArchiveEntry;
  // Most recently requested window. We only fetch when a new request lands
  // outside this (with tolerance). The in-flight promise covers `requestedWindow`.
  requestedWindow: TimeWindowNs | null;
  controller: AbortController | null;
}

export interface RequestOpts {
  pv: string;
  archiver: string | undefined;
  bins?: number;
  window: TimeWindowNs;
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

// True when we've already issued a request for this window (in-flight, errored,
// or completed). Suppresses duplicate requests across renders even when the
// previous attempt errored — otherwise a 404 on a missing PV would loop. The
// user retries by changing PV / archiver / range, which moves the window or
// hardKey out of tolerance.
function recentlyRequested(entry: InternalEntry, win: TimeWindowNs): boolean {
  if (!entry.requestedWindow) return false;
  const tol = coverageTolerance(win);
  return (
    Math.abs(entry.requestedWindow.fromNs - win.fromNs) <= tol &&
    Math.abs(entry.requestedWindow.toNs - win.toNs) <= tol
  );
}

function hardKeyEqual(a: HardKey, b: HardKey): boolean {
  return a.pv === b.pv && a.archiver === b.archiver && a.bins === b.bins && a.mode === b.mode;
}

function dtoToData(dto: ArchiverDataDTO, hardKey: HardKey, window: TimeWindowNs): ArchiveEntry {
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
    mode: hardKey.mode,
    archiver: dto.archiver,
    decimated: false,
  };
}

// ── Store ────────────────────────────────────────────────────────────────────

type Listener = () => void;

class ArchiveStore {
  private entries = new Map<string, InternalEntry>();
  private snapshot: ReadonlyMap<string, ArchiveEntry> = new Map();
  private listeners = new Set<Listener>();

  getSnapshot = (): ReadonlyMap<string, ArchiveEntry> => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  release(traceId: string): void {
    const entry = this.entries.get(traceId);
    if (!entry) return;
    entry.controller?.abort();
    this.entries.delete(traceId);
    this.publish();
  }

  /**
   * Ask for the buffer for `traceId` to cover `window` under `(pv, archiver, bins)`.
   *
   * - Hard key change (pv/archiver/bins/mode) wipes the buffer and refetches.
   * - Otherwise, if the buffer already covers the window (with tolerance), no
   *   fetch is issued.
   * - Otherwise the buffer is kept on screen, status flips to 'loading', and
   *   a fetch is issued for the new window. In-flight fetches for an older
   *   window are aborted.
   */
  request(traceId: string, opts: RequestOpts): void {
    const windowMs = (opts.window.toNs - opts.window.fromNs) / 1_000_000;
    const mode = pickFetchMode(windowMs, opts.bins);
    const hardKey: HardKey = {
      pv: opts.pv,
      archiver: opts.archiver ?? null,
      bins: mode.maxPoints,
      mode: mode.binning === 'auto' ? 'binned' : 'raw',
    };

    const existing = this.entries.get(traceId);
    if (existing && hardKeyEqual(existing.hardKey, hardKey)) {
      // Already buffered: free render.
      if (covers(existing, opts.window)) {
        if (existing.data.status !== 'ready') {
          existing.data = { ...existing.data, status: 'ready', error: undefined };
          this.publish();
        }
        return;
      }
      // Already requested this window (in-flight, completed-but-not-covering,
      // or errored). Don't refire — the render → publish → render loop would
      // pile up requests, and an errored PV would 404 once per render.
      if (recentlyRequested(existing, opts.window)) return;
    }

    if (existing) existing.controller?.abort();

    const hardChanged = !existing || !hardKeyEqual(existing.hardKey, hardKey);
    const prevData = !hardChanged ? existing!.data : undefined;

    const controller = new AbortController();
    const entry: InternalEntry = {
      hardKey,
      data: {
        status: 'loading',
        // Keep last good buffer on screen while we refetch a different window
        // under the same hardKey. Hard-key changes wipe to empty.
        mean: prevData?.mean ?? [],
        band: prevData?.band ?? [],
        coverFromNs: prevData?.coverFromNs ?? opts.window.fromNs,
        coverToNs: prevData?.coverToNs ?? opts.window.toNs,
        mode: hardKey.mode,
        archiver: prevData?.archiver ?? '',
        decimated: prevData?.decimated ?? false,
      },
      requestedWindow: opts.window,
      controller,
    };
    this.entries.set(traceId, entry);
    this.publish();

    void this.runFetch(traceId, opts, hardKey, mode, controller);
  }

  private async runFetch(
    traceId: string,
    opts: RequestOpts,
    hardKey: HardKey,
    mode: FetchMode,
    controller: AbortController
  ): Promise<void> {
    try {
      const dto = await fetchData(
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
      cur.data = dtoToData(dto, hardKey, opts.window);
      cur.controller = null;
      this.publish();
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      const cur = this.entries.get(traceId);
      if (!cur || cur.controller !== controller) return;
      const code = err instanceof CanopyError ? err.code : 'unknown_error';
      const detail = err instanceof CanopyError ? err.detail : (err as Error).message;
      cur.data = {
        ...cur.data,
        status: 'error',
        error: { code, detail },
      };
      cur.controller = null;
      this.publish();
    }
  }

  private publish(): void {
    const next = new Map<string, ArchiveEntry>();
    for (const [id, entry] of this.entries) next.set(id, entry.data);
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export const archiveStore = new ArchiveStore();
