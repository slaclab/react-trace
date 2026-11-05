import { useCallback, useRef, useState } from 'react';
import type { TimeWindowNs } from '../api/time';

export interface AxisSnapshot {
  min?: number;
  max?: number;
  autoScale: boolean;
}

export interface ViewSnapshot {
  timeWindow: TimeWindowNs | null;
  axisRanges: Map<string, AxisSnapshot>;
  autoScroll: boolean;
}

interface PlotHistory {
  stack: ViewSnapshot[];
  cursor: number;
}

const MAX_ENTRIES = 50;
const COALESCE_MS = 300;

function snapshotsEqual(a: ViewSnapshot, b: ViewSnapshot): boolean {
  if (a.autoScroll !== b.autoScroll) return false;
  if ((a.timeWindow === null) !== (b.timeWindow === null)) return false;
  if (a.timeWindow && b.timeWindow) {
    if (a.timeWindow.fromNs !== b.timeWindow.fromNs) return false;
    if (a.timeWindow.toNs !== b.timeWindow.toNs) return false;
  }
  if (a.axisRanges.size !== b.axisRanges.size) return false;
  for (const [id, ar] of a.axisRanges) {
    const br = b.axisRanges.get(id);
    if (!br) return false;
    if (ar.min !== br.min || ar.max !== br.max || ar.autoScale !== br.autoScale) return false;
  }
  return true;
}

export interface ViewHistoryAPI {
  push(plotId: string, snapshot: ViewSnapshot): void;
  goBack(plotId: string): ViewSnapshot | null;
  goForward(plotId: string): ViewSnapshot | null;
  canGoBack(plotId: string): boolean;
  canGoForward(plotId: string): boolean;
  clear(plotId: string): void;
}

export function useViewHistory(): ViewHistoryAPI {
  const historyRef = useRef<Map<string, PlotHistory>>(new Map());
  const timerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingRef = useRef<Map<string, ViewSnapshot>>(new Map());

  const [nav, setNav] = useState<Map<string, { canBack: boolean; canForward: boolean }>>(
    () => new Map()
  );

  const updateNav = useCallback((plotId: string, h: PlotHistory) => {
    setNav((prev) => {
      const canBack = h.cursor > 0;
      const canForward = h.cursor < h.stack.length - 1;
      const old = prev.get(plotId);
      if (old && old.canBack === canBack && old.canForward === canForward) return prev;
      const next = new Map(prev);
      next.set(plotId, { canBack, canForward });
      return next;
    });
  }, []);

  const getOrCreate = useCallback((plotId: string): PlotHistory => {
    let h = historyRef.current.get(plotId);
    if (!h) {
      h = { stack: [], cursor: -1 };
      historyRef.current.set(plotId, h);
    }
    return h;
  }, []);

  const commitPending = useCallback(
    (plotId: string) => {
      const snapshot = pendingRef.current.get(plotId);
      pendingRef.current.delete(plotId);
      if (!snapshot) return;

      const h = getOrCreate(plotId);

      // Dedup: skip if identical to current entry.
      if (h.cursor >= 0 && snapshotsEqual(h.stack[h.cursor], snapshot)) return;

      // Truncate forward entries.
      h.stack.length = h.cursor + 1;
      h.stack.push(snapshot);

      // Cap size.
      if (h.stack.length > MAX_ENTRIES) {
        const excess = h.stack.length - MAX_ENTRIES;
        h.stack.splice(0, excess);
      }
      h.cursor = h.stack.length - 1;

      updateNav(plotId, h);
    },
    [getOrCreate, updateNav]
  );

  const push = useCallback(
    (plotId: string, snapshot: ViewSnapshot) => {
      pendingRef.current.set(plotId, snapshot);

      const existing = timerRef.current.get(plotId);
      if (existing !== undefined) clearTimeout(existing);

      timerRef.current.set(
        plotId,
        setTimeout(() => {
          timerRef.current.delete(plotId);
          commitPending(plotId);
        }, COALESCE_MS)
      );
    },
    [commitPending]
  );

  const goBack = useCallback(
    (plotId: string): ViewSnapshot | null => {
      // Cancel any pending coalesce — commit it first so "back" undoes the latest action.
      const timer = timerRef.current.get(plotId);
      if (timer !== undefined) {
        clearTimeout(timer);
        timerRef.current.delete(plotId);
        commitPending(plotId);
      }

      const h = historyRef.current.get(plotId);
      if (!h || h.cursor <= 0) return null;
      h.cursor -= 1;
      updateNav(plotId, h);
      return h.stack[h.cursor];
    },
    [commitPending, updateNav]
  );

  const goForward = useCallback(
    (plotId: string): ViewSnapshot | null => {
      // Flush pending coalesce (same as goBack) so a zoom right before forward
      // correctly truncates the forward stack instead of being silently dropped.
      const timer = timerRef.current.get(plotId);
      if (timer !== undefined) {
        clearTimeout(timer);
        timerRef.current.delete(plotId);
        commitPending(plotId);
      }

      const h = historyRef.current.get(plotId);
      if (!h || h.cursor >= h.stack.length - 1) return null;
      h.cursor += 1;
      updateNav(plotId, h);
      return h.stack[h.cursor];
    },
    [commitPending, updateNav]
  );

  const canGoBack = useCallback(
    (plotId: string): boolean => nav.get(plotId)?.canBack ?? false,
    [nav]
  );

  const canGoForward = useCallback(
    (plotId: string): boolean => nav.get(plotId)?.canForward ?? false,
    [nav]
  );

  const clear = useCallback((plotId: string) => {
    const timer = timerRef.current.get(plotId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timerRef.current.delete(plotId);
    }
    pendingRef.current.delete(plotId);
    historyRef.current.delete(plotId);
    setNav((prev) => {
      if (!prev.has(plotId)) return prev;
      const next = new Map(prev);
      next.delete(plotId);
      return next;
    });
  }, []);

  return { push, goBack, goForward, canGoBack, canGoForward, clear };
}
