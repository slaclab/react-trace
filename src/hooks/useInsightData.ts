import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { fetchData, fetchMetadata } from '../api/mole';
import {
  archiveErrorInfo,
  archiveStore,
  isNotArchivedError,
  retryDelayMs,
} from '../state/archiveStore';
import { liveStore, type LivePoint } from '../state/liveStore';
import { msToNs } from '../api/time';
import type { AlarmSeverity, ArchiverDataDTO } from '../api/types';
import type { TimeWindowNs } from '../api/time';

export interface InsightRow {
  tsNs: number;
  value: number | string | boolean | null;
  severity: AlarmSeverity | '';
  source: 'Archive' | 'Live';
}

export interface InsightMeta {
  pv: string;
  units: string | null;
  description: string | null;
}

export type InsightStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface InsightData {
  rows: InsightRow[];
  meta: InsightMeta | null;
  status: InsightStatus;
  error?: string;
  // True when the archiver decimated the raw result (too many points for the
  // window). The table then shows representative rather than every sample.
  decimated: boolean;
  // True while a fetch is in flight, including background refetches that keep
  // `status` at 'ready' (stale-while-revalidate). Lets the UI disable Refresh
  // so it can't fire overlapping requests.
  refreshing: boolean;
  refetch: () => void;
  // Set when the rows are live samples only and why: Archive is off for the
  // trace, or the archiver doesn't have this PV.
  archiveNote?: string;
}

export interface InsightOptions {
  // Query the archiver. False for a trace with Archive off: the rows are its
  // live samples alone and neither /data nor /metadata is requested.
  // Defaults to true.
  archive?: boolean;
}

export const ARCHIVE_OFF_NOTE = 'Archive off, live samples only';
export const NOT_ARCHIVED_NOTE = 'Not in archiver, live samples only';

function toRows(data: ArchiverDataDTO): InsightRow[] {
  if (data.mode === 'raw') {
    return data.samples.map((s) => ({
      tsNs: s.tsNs,
      value: s.value,
      severity: s.severity,
      source: 'Archive' as const,
    }));
  }
  // Binned fallback — shouldn't occur without a binning param, but stay safe.
  return data.points.map((p) => ({
    tsNs: p.tsNs,
    value: p.mean,
    severity: p.severity,
    source: 'Archive' as const,
  }));
}

const EMPTY_POINTS: readonly LivePoint[] = [];
const NO_ROWS: InsightRow[] = [];

/**
 * Fold live-store samples in after the archive seam. Mirrors PlotArea's
 * `traceLineData`: archive feeds the past, live the present, so a live sample at
 * or before the last archive sample is dropped to avoid doubling up at the
 * boundary. Live samples are windowed to the plot's visible range and carry
 * their per-sample severity. Live points are in ms; archive rows are in ns.
 */
export function mergeLive(
  archiveRows: InsightRow[],
  livePoints: readonly LivePoint[],
  fromNs: number | undefined,
  toNs: number | undefined
): InsightRow[] {
  if (livePoints.length === 0) return archiveRows;
  const seamNs = archiveRows.length ? archiveRows[archiveRows.length - 1].tsNs : -Infinity;
  const lo = fromNs ?? -Infinity;
  const hi = toNs ?? Infinity;
  const liveRows: InsightRow[] = [];
  for (const p of livePoints) {
    const tsNs = msToNs(p.time);
    if (tsNs <= seamNs) continue; // de-dupe at the archive/live seam
    if (tsNs < lo || tsNs > hi) continue; // window filter
    liveRows.push({ tsNs, value: p.value, severity: p.severity, source: 'Live' });
  }
  return liveRows.length ? archiveRows.concat(liveRows) : archiveRows;
}

/**
 * Fetches raw archive samples (+ unit/description metadata) for a single PV over
 * a time window and merges the trace's live-store buffer in after the archive
 * seam — the data layer for the Data Insight Tool. Omits binning so the archiver
 * returns un-optimized samples (matching the Python DIT). Pass `traceId` to
 * include live samples for a `useLive` trace; archive-only traces omit it.
 *
 * The archiver is skipped entirely when `options.archive` is false, and for a
 * (pv, archiver) the archive store already knows isn't archived (learned by the
 * plot or by an earlier query here); the rows are then the live samples alone.
 * Refresh asks again. Other failures retry on the archive store's backoff
 * schedule rather than every time the window crosses a second.
 */
export function useInsightData(
  pv: string | undefined,
  archiver: string | undefined,
  window: TimeWindowNs | undefined,
  traceId?: string,
  options: InsightOptions = {}
): InsightData {
  const archiveEnabled = options.archive ?? true;
  const [archiveRows, setArchiveRows] = useState<InsightRow[]>(NO_ROWS);
  const [archiveMeta, setArchiveMeta] = useState<InsightMeta | null>(null);
  const [status, setStatus] = useState<InsightStatus>('idle');
  const [error, setError] = useState<string>();
  const [decimated, setDecimated] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // PV whose archive rows are currently loaded, used to suppress the loading
  // flash on background refetches (see below).
  const loadedPvRef = useRef<string | undefined>(undefined);
  // Refresh key of the last effect run; a different one means Refresh was
  // pressed, which bypasses the not-archived verdict and the backoff.
  const seenRefreshKeyRef = useRef(refreshKey);
  // Backoff after a failure other than not-archived, for one (pv, archiver).
  const backoffRef = useRef<{ key: string; attempts: number; retryAtMs: number } | null>(null);

  // Shared verdict that the archiver doesn't have this (pv, archiver). The
  // store hands back a stable object while it stands, so this re-renders only
  // when it's set or cleared (e.g. by the toolbar's archive refresh).
  const getNotArchived = useCallback(
    () => (pv ? archiveStore.getNotArchived(pv, archiver) : undefined),
    [pv, archiver]
  );
  const notArchived = useSyncExternalStore(archiveStore.subscribe, getNotArchived);

  const refetch = useCallback(() => {
    if (pv) archiveStore.forgetNotArchived(pv, archiver);
    setRefreshKey((k) => k + 1);
  }, [pv, archiver]);

  const fromNs = window?.fromNs;
  const toNs = window?.toNs;

  // Quantize the archive query to whole seconds. A relative range (e.g. "-1h")
  // re-resolves `nowNs()` every render, so raw fromNs/toNs jitter by ms each
  // frame; while live is streaming that would refetch the archive on every
  // re-render. Quantizing pins the query to second boundaries so it only
  // refetches when the window actually crosses one. The start rounds down and
  // the end rounds up, so the query fully covers the requested window: for
  // archive-only traces (no live buffer to fill the tail) rounding the end down
  // would drop up to 999ms at the edge. The live merge below still uses the raw
  // window.
  const fromSec = fromNs === undefined ? undefined : Math.floor(fromNs / 1e9);
  const toSec = toNs === undefined ? undefined : Math.ceil(toNs / 1e9);

  useEffect(() => {
    // Synchronous status/reset transitions before the async fetch are the
    // standard data-fetching pattern; the cascading-render guard doesn't apply.
    /* eslint-disable react-hooks/set-state-in-effect */
    const forced = seenRefreshKeyRef.current !== refreshKey;
    seenRefreshKeyRef.current = refreshKey;
    if (!pv || fromSec === undefined || toSec === undefined) {
      setStatus('idle');
      setArchiveRows(NO_ROWS);
      setArchiveMeta(null);
      setRefreshing(false);
      loadedPvRef.current = undefined;
      backoffRef.current = null;
      return;
    }

    // Archive off, or known not to be archived: live rows only, no request.
    // Checked before any loading/refreshing writes so nothing flickers.
    if (!archiveEnabled || (notArchived && !forced)) {
      setArchiveRows(NO_ROWS);
      setArchiveMeta(null);
      setDecimated(false);
      setError(undefined);
      setStatus('ready');
      setRefreshing(false);
      loadedPvRef.current = undefined;
      backoffRef.current = null;
      return;
    }

    const key = `${pv}\u0000${archiver ?? ''}`;
    if (backoffRef.current && backoffRef.current.key !== key) backoffRef.current = null;
    const backoff = backoffRef.current;
    // The last attempt failed: keep showing that error until the backoff
    // expires, however often the window crosses a second.
    if (backoff && !forced && Date.now() < backoff.retryAtMs) return;

    const controller = new AbortController();
    // Stale-while-revalidate: only flash the loading state on the first load for
    // a PV. Background refetches (second-boundary window slide, refresh) keep
    // the current rows visible so streaming doesn't flicker the toolbar, and a
    // retry after an error keeps the error until the answer arrives.
    if (loadedPvRef.current !== pv && !backoff) setStatus('loading');
    // `refreshing` tracks the in-flight fetch even when the loading flash is
    // suppressed, so the UI can disable Refresh and prevent overlapping requests.
    setRefreshing(true);
    if (!backoff) setError(undefined);
    /* eslint-enable react-hooks/set-state-in-effect */

    const queryFromNs = fromSec * 1e9;
    const queryToNs = toSec * 1e9;

    void (async () => {
      try {
        const [data, metadata] = await Promise.all([
          fetchData(pv, { fromNs: queryFromNs, toNs: queryToNs, archiver }, controller.signal),
          // Metadata is best-effort; a missing/erroring metadata endpoint
          // shouldn't fail the whole table.
          fetchMetadata(pv, archiver, controller.signal).catch(() => null),
        ]);
        if (controller.signal.aborted) return;
        backoffRef.current = null;
        setArchiveRows(toRows(data));
        setDecimated(data.mode === 'raw' ? data.decimated : false);
        setArchiveMeta({
          pv,
          units: metadata?.units ?? null,
          description: metadata?.description ?? null,
        });
        setError(undefined);
        loadedPvRef.current = pv;
        setStatus('ready');
        setRefreshing(false);
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError' || controller.signal.aborted) return;
        const info = archiveErrorInfo(err);
        if (isNotArchivedError(info)) {
          // Not an error for the table: show the live rows, and share the
          // verdict so neither this tool nor the plot asks again.
          backoffRef.current = null;
          setArchiveRows(NO_ROWS);
          setArchiveMeta(null);
          setDecimated(false);
          setError(undefined);
          loadedPvRef.current = undefined;
          setStatus('ready');
          setRefreshing(false);
          archiveStore.markNotArchived(pv, archiver, info);
          return;
        }
        const attempts = (backoff?.attempts ?? 0) + 1;
        backoffRef.current = { key, attempts, retryAtMs: Date.now() + retryDelayMs(attempts) };
        setError(info.detail);
        setStatus('error');
        setRefreshing(false);
      }
    })();

    return () => controller.abort();
  }, [pv, archiver, fromSec, toSec, refreshKey, archiveEnabled, notArchived]);

  // Read the trace's live buffer. Subscribing here only adds a store listener;
  // the actual PV watch/subscribe is owned by the app-level useLiveSeries, so a
  // trace with `useLive` off simply has no entry and contributes no live rows.
  // We read just this trace's entry (not the whole snapshot) so the panel
  // re-renders on the selected trace's samples alone, not on every live frame
  // from any trace. The store hands back a ref-stable entry per trace.
  const getEntry = useCallback(
    () => (traceId ? liveStore.getEntrySnapshot(traceId) : undefined),
    [traceId]
  );
  const liveEntry = useSyncExternalStore(liveStore.subscribe, getEntry);
  const ownLiveEntry = liveEntry && liveEntry.pv === pv ? liveEntry : undefined;
  const livePoints = ownLiveEntry ? ownLiveEntry.points : EMPTY_POINTS;

  const rows = useMemo(
    () => mergeLive(archiveRows, livePoints, fromNs, toNs),
    // `liveEntry` drives recompute: the store mutates the points array in place
    // but hands back a fresh entry object when a new sample lands, so depending
    // on it recomputes on each new sample while staying stable otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [archiveRows, liveEntry, fromNs, toNs]
  );

  const archiveNote = !pv
    ? undefined
    : !archiveEnabled
      ? ARCHIVE_OFF_NOTE
      : notArchived
        ? NOT_ARCHIVED_NOTE
        : undefined;
  // Without archive metadata, fall back to the live value's units so the
  // header and exports still have something (export needs a meta).
  const liveUnits = ownLiveEntry?.latest?.units ?? null;
  const meta = useMemo<InsightMeta | null>(() => {
    if (!pv) return null;
    if (archiveNote) return { pv, units: liveUnits, description: null };
    return archiveMeta;
  }, [pv, archiveNote, liveUnits, archiveMeta]);

  return { rows, meta, status, error, decimated, refreshing, refetch, archiveNote };
}
