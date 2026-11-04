import type { PlotView } from '../plot/plotToggles';
import { withPlotView } from '../tools/trace/plotView';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type SetStateAction,
} from 'react';
import { createPortal } from 'react-dom';
import { Close, Login, ChevronUp } from '@carbon/icons-react';
import { Theme, ToastNotification } from '@carbon/react';
import { ErrorBoundary, useColorMode, useHostTheme } from '@slaclab/canopy-shell';
import { chartThemeFor } from '@slaclab/canopy-charts';
import type { FormulaSpec } from '@slaclab/canopy-client';
import type { Plot, PVTrace } from '../types';
import { DetachedWindow } from './DetachedWindow';
import { RangeControls } from '../tools/trace/plot/RangeControls';
import { DataInsightTool } from './DataInsightTool';
import {
  PlotArea,
  PlotWithStatistics,
  annotationMountProps,
  type AnnotationChannel,
} from './PlotArea';
import { capturePlotPng } from '../capturePlot';
import { useArchiveSeries, type ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import { useLiveSeries, type LiveSeriesResult } from '../hooks/useLiveSeries';
import { archiveStore } from '../state/archiveStore';
import {
  followingEndMs,
  isFollowing,
  axisEndMs,
  useAutoScrollTimers,
} from '../hooks/useAutoScrollTimers';
import { useFormulaSeries, type FormulaSeriesResult } from '../hooks/useFormulaSeries';
import type { TimeWindowNs } from '../api/time';
import { relativeRangeMs, resolveTimeWindow } from '../api/time';
import { useHostThemeId } from '../state/colorMode';
import { readLegacyPaletteId } from '../state/paletteStore';
import { getPalette, colorForIndex, paletteOf, DEFAULT_PALETTE_ID } from '../palettes';
import { withFilePalette } from '../io/paletteInference';
import { downloadBlob, downloadDataUrl, pickFile } from '../io/download';
import { serializeWorkspace, deserializeWorkspace } from '../io/serialize';
import { buildCsvFiles } from '../io/exportCsv';
import { safeFilename, timestamp } from '../io/filename';
import { makeId } from '../id';
import { resolveFormulaSpec } from '../formula';
import { capturePlots, type PngSource, type CapturedPlot } from '../io/exportPlotImage';
import { PostToElogModal } from './PostToElogModal';
import { useElogConfig } from '../hooks/useElogConfig';
import {
  INITIAL_PLOT_ID,
  buildInitialPlots,
  initialSelection,
  rangeSpanMs,
} from '../embed/initialPlots';
import { newPlot } from '../embed/plotConfig';
import { useTraceStateOut } from '../embed/stateOut';
import { WorkbenchLayout } from '../workbench/WorkbenchLayout';
import { useContextMenuWriters } from '../workbench/contextMenu/context';
import { TraceCursorContext, traceMenuWriters, type TraceMenuInput } from '../tools/trace/menu';
import { createSelectionStore, type SelectionStore } from '../workbench/selection';
import type { Selection } from '../workbench/types';
import { useStandardActionsOptions } from '../tools/standardActionsOptions';
import {
  traceHostState,
  useTraceCanvasActions,
  type TraceActionsOptions,
} from '../tools/trace/actions';
import { useTraceCapabilities } from '../tools/trace/capabilities';
import { PV_CURVE_ITEM_KIND, UnitLookups, plotHoldingCurve } from '../tools/trace/schema/curve';
import { FORMULA_CURVE_ITEM_KIND } from '../tools/trace/schema/formula';
import {
  useTraceDefinition,
  type TraceModel,
  type TraceState,
  type TraceUi,
} from '../tools/trace/tool';
import { DRAWING_ITEM_KIND } from '../annotations/host/workbench';
import { DEFAULT_TOOL_PREFS, type AnnotationToolPrefs } from '../annotations/tools';
import type { Annotation } from '../annotations/model';
import { withAnnotations } from '../tools/trace/drawing/plotDrawings';
import type { AnnotationMark, HistoryTag } from '../annotations/history';
import { UndoKeyListener } from '../annotations/host/UndoKeyListener';
import { popAnnotationHistory, withAnnotationHistory } from '../tools/trace/drawing/history';

type InsightProps = ComponentProps<typeof DataInsightTool>;

function sameWindows(
  a: InsightProps['windowByPlotId'],
  b: InsightProps['windowByPlotId']
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, w] of a) {
    const o = b.get(id);
    if (!o || o.fromNs !== w.fromNs || o.toNs !== w.toNs) return false;
  }
  return true;
}

// The DIT re-renders only when what it inspects changes: its plots, their
// windows (by value — TraceApp rebuilds the map every render) or the selected
// PV. Every callback TraceApp passes is a functional `setInsight` update, so a
// stale closure is equivalent to a fresh one and callback identity is ignored.
// Without this, every live frame re-rendered the DIT's Carbon overflow menu,
// whose popover layout effect reads computed styles on each render.
const InsightTool = memo(
  DataInsightTool,
  (prev, next) =>
    prev.selectedPv === next.selectedPv &&
    prev.detached === next.detached &&
    prev.plots.length === next.plots.length &&
    prev.plots.every((p, i) => p === next.plots[i]) &&
    sameWindows(prev.windowByPlotId, next.windowByPlotId)
);

/** Trace's tool state as the app holds it (the workbench writes it through `update`). */
interface TraceAppState {
  plots: Plot[];
  activePlotId: string;
  /** Each plot's annotation undo ring; advanced by `update`. */
  history: Map<string, Annotation[][]>;
  /** The last single-drawing write, so a drag coalesces into one undo step. */
  annotationMark?: AnnotationMark | null;
}

/** The selected drawing's id: an `item`-level selection of kind `annotation`, else null. */
function selectedAnnotationOf(selection: SelectionStore): string | null {
  const s = selection.get().selection;
  return s?.level === 'item' && s.kind === DRAWING_ITEM_KIND ? s.id : null;
}

/**
 * The opening selection: the first curve of the opening plot, else the
 * tool level. It fills Properties without switching the sidebar's tab.
 */
function openingSelection(plots: readonly Plot[]): Selection {
  const opening = initialSelection(plots);
  if (opening?.type !== 'trace') return null;
  const curve = plots[0]?.traces.find((t) => t.id === opening.id);
  if (!curve) return null;
  const kind = curve.kind === 'formula' ? FORMULA_CURVE_ITEM_KIND : PV_CURVE_ITEM_KIND;
  return { level: 'item', kind, id: curve.id };
}

/**
 * Picking a time range is an explicit reset, as it always was: a plot whose
 * `xAxis` the write replaced tracks "now" again (its panned window is dropped
 * by the effect in TraceApp).
 */
function withRangeReset(prev: TraceAppState, next: TraceAppState): TraceAppState {
  let changed = false;
  const plots = next.plots.map((p) => {
    const before = prev.plots.find((q) => q.id === p.id);
    if (!before || before.xAxis === p.xAxis || p.autoScroll !== false) return p;
    changed = true;
    return { ...p, autoScroll: true };
  });
  return changed ? { ...next, plots } : next;
}

/** Trailing debounce from the view window to the fetch window. */
const FETCH_DEBOUNCE_MS = 400;

const NO_ARCHIVE: ReadonlyMap<string, ArchiveSeriesResult> = new Map();
const NO_LIVE: ReadonlyMap<string, LiveSeriesResult> = new Map();
const NO_LIVE_MAP: Map<string, LiveSeriesResult> = new Map();
const NO_FORMULA: ReadonlyMap<string, FormulaSeriesResult> = new Map();

/** Registers Trace's right-click writers with the workbench's menu host. */
function TraceMenu({ input }: { input: TraceMenuInput }) {
  useContextMenuWriters(traceMenuWriters(input));
  return null;
}

/** Registers Trace's actions in the workbench's actions bar from inside the canvas. */
function TraceCanvasActions({ options }: { options: TraceActionsOptions }) {
  useTraceCanvasActions(options);
  return null;
}

/**
 * The root of a detached window: the Carbon theme zone, which is also the
 * host-theme anchor of that window's document. Rendered inside the
 * DetachedWindow portal, so the anchor lives in the popup.
 */
function DetachedRoot({
  style,
  children,
}: {
  style: React.CSSProperties;
  children: React.ReactNode;
}) {
  const { colorMode, carbonTheme } = useColorMode();
  const { anchorRef, anchorProps } = useHostTheme<HTMLDivElement>(
    useHostThemeId() ?? colorMode,
    colorMode
  );
  return (
    <Theme ref={anchorRef} {...anchorProps} theme={carbonTheme} style={style}>
      {children}
    </Theme>
  );
}

export function TraceApp() {
  // Opening state comes from the page query (the CANOPY workspace names PVs
  // and a range); without one Trace opens a single empty plot.
  const [initial] = useState(() => {
    // A fresh tab (no `plot=`) opens in the legacy per-user palette when it
    // names a valid one; the key is only read, never written.
    const seeded = buildInitialPlots(
      window.location.search,
      getPalette(readLegacyPaletteId() ?? DEFAULT_PALETTE_ID)
    );
    return { plots: seeded, selection: openingSelection(seeded) };
  });
  // The plots and the active plot are one record: the workbench's single
  // writer (`update`) transforms both at once.
  const [tool, setTool] = useState<TraceAppState>(() => ({
    plots: initial.plots,
    activePlotId: INITIAL_PLOT_ID,
    history: new Map(),
  }));
  const { plots, activePlotId } = tool;
  const setPlots = useCallback((next: SetStateAction<Plot[]>) => {
    setTool((s) => ({ ...s, plots: typeof next === 'function' ? next(s.plots) : next }));
  }, []);
  const setActivePlotId = useCallback((id: string) => {
    setTool((s) => (s.activePlotId === id ? s : { ...s, activePlotId: id }));
  }, []);
  // The in-flight unit lookups of every curve. Ids repeat across workspaces,
  // so a workspace load aborts them all, and so does unmounting.
  const [unitLookups] = useState(() => new UnitLookups());
  useEffect(() => () => unitLookups.abortAll(), [unitLookups]);
  const update = useCallback((fn: (state: TraceState) => TraceState, tag?: HistoryTag) => {
    // Read once outside the updater, so a StrictMode double call records one
    // undo step.
    const nowMs = Date.now();
    // Trace's transforms keep the plot array shape; `readonly` is the schema's view.
    setTool((s) => withAnnotationHistory(s, withRangeReset(s, fn(s) as TraceAppState), tag, nowMs));
  }, []);
  // Undo the newest drawing edit of `plotId`; not an undo step itself.
  const undoAnnotations = useCallback(
    (plotId: string) => update((s) => popAnnotationHistory(s as TraceAppState, plotId), 'undo'),
    [update]
  );
  // One drawing gesture on `plotId`: a single
  // `update()`, so the history records it as one undo step.
  const commitAnnotations = useCallback(
    (plotId: string, fn: (list: Annotation[]) => Annotation[]) =>
      update((s) => ({
        ...s,
        plots: s.plots.map((p) =>
          p.id === plotId ? withAnnotations(p, fn(p.annotations ?? [])) : p
        ),
      })),
    [update]
  );
  // The workbench selection: the Outline, Properties and the footer share it.
  const [selection] = useState<SelectionStore>(() =>
    createSelectionStore({ initial: initial.selection })
  );
  // The drawing channel. All session-only: no Plot field.
  // Hide-all per plot, handed to the workbench as `ui`. The record is memoized
  // on the set and a stable setter, so the panes re-render only when a plot's
  // hide state flips, never per live sample.
  const [annotationsHidden, setAnnotationsHiddenSet] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const setAnnotationsHidden = useCallback((plotId: string, on: boolean) => {
    setAnnotationsHiddenSet((prev) => {
      if (prev.has(plotId) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(plotId);
      else next.delete(plotId);
      return next;
    });
  }, []);
  const ui = useMemo<TraceUi>(
    () => ({ annotationsHidden, setAnnotationsHidden }),
    [annotationsHidden, setAnnotationsHidden]
  );
  // Each plot's drawing-tool prefs; gesture state stays overlay-local. A patch replaces only that plot's entry.
  const [annotationPrefs, setAnnotationPrefsMap] = useState<
    ReadonlyMap<string, AnnotationToolPrefs>
  >(() => new Map());
  const setAnnotationPrefs = useCallback((plotId: string, patch: Partial<AnnotationToolPrefs>) => {
    setAnnotationPrefsMap((prev) => {
      const next = new Map(prev);
      next.set(plotId, { ...DEFAULT_TOOL_PREFS, ...prev.get(plotId), ...patch });
      return next;
    });
  }, []);
  // The selected drawing, derived from the workbench selection; a drawing
  // click selects it on the same store the Outline reads.
  const getSelectedAnnotation = useCallback(() => selectedAnnotationOf(selection), [selection]);
  const selectedAnnotationId = useSyncExternalStore(
    selection.subscribe,
    getSelectedAnnotation,
    getSelectedAnnotation
  );
  // A drawing clicked in a plot that is not the active one (a grid cell, the
  // fullscreen or a detached mount) activates that plot and is queued:
  // activation resets the selection (`useResetOnChange` in
  // `useTraceDefinition`), so the select is applied by an effect declared after
  // it. The comparison reads the committed active plot, not any
  // activation already requested in this event: a grid cell activates in its
  // capture phase, before the overlay's select.
  const committedActivePlotId = useRef(activePlotId);
  useEffect(() => {
    committedActivePlotId.current = activePlotId;
  }, [activePlotId]);
  const pendingSelection = useRef<{ plotId: string; id: string } | null>(null);
  const onSelectAnnotation = useCallback(
    (plotId: string, id: string | null) => {
      if (id !== null && plotId !== committedActivePlotId.current) {
        pendingSelection.current = { plotId, id };
        setActivePlotId(plotId);
        return;
      }
      // A select (or `null`, back to the tool level) on the active plot
      // supersedes any queued one.
      pendingSelection.current = null;
      selection.select(id === null ? null : { level: 'item', kind: DRAWING_ITEM_KIND, id }, 'user');
    },
    [selection, setActivePlotId]
  );
  const [viewMode, setViewMode] = useState<'tabs' | 'grid'>('tabs');
  const [poppedOutPlot, setPoppedOutPlot] = useState<string | null>(null);
  // Plots detached into their own browser windows. Their charts render there
  // via a portal; the main window shows a reattach placeholder in their place.
  const [detachedPlotIds, setDetachedPlotIds] = useState<string[]>([]);
  // What the browser last refused to open as a pop-up (a plot title or "Data
  // Insight"), shown in a toast. DetachedWindow reattaches it on its own.
  const [blockedPopup, setBlockedPopup] = useState<string | null>(null);
  // Data Insight Tool: a dockable panel that can be minimized or popped out into
  // its own window. `pv` is the trace id whose PV is being inspected.
  const [insight, setInsight] = useState<{
    open: boolean;
    minimized: boolean;
    detached: boolean;
    pv?: string;
  }>({ open: false, minimized: false, detached: false });
  const { colorMode, setColorMode } = useColorMode();
  const elogConfig = useElogConfig();
  const capabilities = useTraceCapabilities();
  // E-Log post dialog. `captured` holds the plot PNGs snapshotted at open time
  // (data URLs), so editing in the dialog works against a stable image set.
  const [elogModal, setElogModal] = useState<{ open: boolean; captured: CapturedPlot[] }>({
    open: false,
    captured: [],
  });
  // Success/error toast shown after an E-Log post attempt.
  const [elogToast, setElogToast] = useState<{
    kind: 'success' | 'error';
    title: string;
    subtitle?: string;
  } | null>(null);
  // The visible window each plot's gestures wrote (the view window owns the
  // visible range). The chart shows it at once; a plot absent from
  // it shows its relative range against "now".
  const [viewWindowByPlot, setViewWindowByPlot] = useState<Map<string, TimeWindowNs>>(
    () => new Map()
  );
  // `viewWindowByPlot` after a purely trailing 400 ms debounce:
  // the archive requests, the statistics and the Data Insight Tool follow it,
  // so a burst of pan/zoom frames costs one fetch, not one per frame.
  const [fetchWindowByPlot, setFetchWindowByPlot] = useState<Map<string, TimeWindowNs>>(
    () => new Map()
  );
  const fetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (fetchTimerRef.current !== null) clearTimeout(fetchTimerRef.current);
    fetchTimerRef.current = setTimeout(() => {
      fetchTimerRef.current = null;
      setFetchWindowByPlot((prev) =>
        sameWindows(prev, viewWindowByPlot) ? prev : viewWindowByPlot
      );
    }, FETCH_DEBOUNCE_MS);
    return () => {
      if (fetchTimerRef.current !== null) clearTimeout(fetchTimerRef.current);
      fetchTimerRef.current = null;
    };
  }, [viewWindowByPlot]);

  // Per-plot "now". A following plot's anchor advances once per its refresh
  // interval; any other plot's anchor holds, which freezes its window. While
  // the embedding host hides Trace (and nothing is detached) every anchor
  // holds, so live re-renders neither slide a window nor refetch.
  const anyDetached = detachedPlotIds.length > 0 || (insight.open && insight.detached);
  const clock = useAutoScrollTimers(plots, viewWindowByPlot, anyDetached);

  // Embedded: report plot 0's PVs and range to the host so a reload keeps them.
  useTraceStateOut(plots);

  const activePlot = plots.find((p) => p.id === activePlotId) ?? plots[0];

  const allTraces = plots.flatMap((p) => p.traces);

  // Each plot's stats window: the debounced fetch window, else its relative
  // range at the plot's anchor. The archive and formula requests,
  // `statsWindowNs` and the Data Insight Tool read it. What the chart shows
  // (`displayWindowByPlotId`, below) also follows live samples past the anchor.
  const statsWindowByPlotId = new Map<string, TimeWindowNs>();
  for (const p of plots) {
    statsWindowByPlotId.set(
      p.id,
      fetchWindowByPlot.get(p.id) ?? resolveTimeWindow(p.xAxis, clock.nowFor(p.id)).window
    );
  }

  // The fetch window per trace is its plot's stats window. The time range is
  // plot-level — traces don't carry their own.
  const windowByTrace = new Map<string, TimeWindowNs>();
  // Each trace inherits its plot's default archiver unless it sets its own.
  const plotArchiverByTrace = new Map<string, string | undefined>();
  // Resolved Formula Engine spec per formula trace (bindings mapped to PV names); null when
  // the formula isn't ready to evaluate (empty expression or an unbound variable).
  const formulaSpecByTrace = new Map<string, FormulaSpec | null>();
  // The plot's range span per live trace: an automatic (undefined) retention
  // resolves from it, so a -1h plot keeps min(span, MAX) of live samples.
  const liveSpanMsByTrace = new Map<string, number>();
  for (const plot of plots) {
    const win = statsWindowByPlotId.get(plot.id)!;
    for (const trace of plot.traces) {
      if (trace.useArchive) windowByTrace.set(trace.id, win);
      if (trace.useLive) liveSpanMsByTrace.set(trace.id, rangeSpanMs(plot.xAxis));
      plotArchiverByTrace.set(trace.id, plot.archiver);
      if (trace.kind === 'formula') {
        windowByTrace.set(trace.id, win);
        formulaSpecByTrace.set(trace.id, resolveFormulaSpec(trace, plot.traces));
      }
    }
  }

  const archiveResults = useArchiveSeries(allTraces, plotArchiverByTrace, windowByTrace);
  // Live data subscriptions are owned at the app level so detached / popped-out
  // / grid views all share one WebSocket. The hook handles add/remove of
  // subscriptions when traces toggle their `useLive` flag.
  const liveResults = useLiveSeries(allTraces, liveSpanMsByTrace);
  const formulaResults = useFormulaSeries(allTraces, formulaSpecByTrace, windowByTrace);

  // The one window-write path, called only by gesture handlers.
  const handleViewWindowChange = (
    plotId: string,
    window: TimeWindowNs,
    opts?: { follow?: boolean }
  ) => {
    setViewWindowByPlot((prev) => {
      const cur = prev.get(plotId);
      if (cur && cur.fromNs === window.fromNs && cur.toNs === window.toNs) return prev;
      const next = new Map(prev);
      next.set(plotId, window);
      return next;
    });
    // A follow-live stretch frame records the display window only; its one
    // relative write happens on mouseup.
    if (opts?.follow) return;
    // The first manual frame on a following plot freezes it where its axis
    // ends, so no tick or live batch slides the axis under the gesture.
    const plot = plots.find((p) => p.id === plotId);
    if (plot && isFollowing(plot, viewWindowByPlot)) freezeAtDisplayedEnd(plot);
    // A manual pan/zoom takes over the window, so stop tracking "now". Picking a
    // time range re-enables it (`withRangeReset`). Written only when it changes,
    // so a burst of frames is one `plots` identity change.
    setPlots((prev) =>
      prev.some((p) => p.id === plotId && p.autoScroll !== false)
        ? prev.map((p) => (p.id === plotId ? { ...p, autoScroll: false } : p))
        : prev
    );
  };

  // Write a plot's x-axis (All, a follow-live stretch, a range chip) through
  // `update()`: the new `xAxis` identity re-enables autoscroll
  // (`withRangeReset`) and the effect below drops the plot's view and fetch
  // windows.
  const handleApplyXAxis = (plotId: string, xAxis: Plot['xAxis']) => {
    update((s) => ({
      ...s,
      plots: s.plots.map((p) => (p.id === plotId ? { ...p, xAxis } : p)),
    }));
  };

  // The last relative range ("-1h", "-40m") each plot showed, session-only:
  // "Now" returns to it after a go-to wrote a custom range.
  const lastRelativeSpan = useRef(new Map<string, string>());
  // Read at click time by every mount's Now chip.
  const lastRelativeSpanFor = useCallback(
    (plotId: string) => lastRelativeSpan.current.get(plotId),
    []
  );

  // Split the flat result maps per plot. Memoized on (plots, archiveResults,
  // liveResults, formulaResults): live/formula data drives frequent re-renders
  // via useSyncExternalStore, and rebuilding these maps every render would churn
  // the props passed into PlotArea and the workbench model. The hooks return
  // stable references when their data is unchanged, so this memo holds across
  // frames that don't touch the underlying series.
  const { archiveResultsByPlot, liveResultsByPlot, formulaResultsByPlot } = useMemo(() => {
    const archive = new Map<string, Map<string, ArchiveSeriesResult>>();
    const live = new Map<string, Map<string, LiveSeriesResult>>();
    const formula = new Map<string, Map<string, FormulaSeriesResult>>();
    for (const plot of plots) {
      const a = new Map<string, ArchiveSeriesResult>();
      const l = new Map<string, LiveSeriesResult>();
      const f = new Map<string, FormulaSeriesResult>();
      for (const trace of plot.traces) {
        const ar = archiveResults.get(trace.id);
        if (ar) a.set(trace.id, ar);
        const lr = liveResults.get(trace.id);
        if (lr) l.set(trace.id, lr);
        const fr = formulaResults.get(trace.id);
        if (fr) f.set(trace.id, fr);
      }
      archive.set(plot.id, a);
      live.set(plot.id, l);
      formula.set(plot.id, f);
    }
    return {
      archiveResultsByPlot: archive,
      liveResultsByPlot: live,
      formulaResultsByPlot: formula,
    };
  }, [plots, archiveResults, liveResults, formulaResults]);

  // Where each plot's time axis ends (see axisEndMs): its anchor, or for a
  // following plot the newest live sample past it. The chart draws to this,
  // and stopping Autoscroll or a pan freezes the plot here, so both agree.
  const axisEndFor = (plotId: string): number => {
    const plot = plots.find((p) => p.id === plotId);
    const anchorMs = clock.nowFor(plotId);
    if (!plot) return anchorMs;
    const live = liveResultsByPlot.get(plotId) ?? NO_LIVE_MAP;
    return axisEndMs(plot, anchorMs, isFollowing(plot, viewWindowByPlot), live);
  };
  const followingFor = (plotId: string): boolean => {
    const plot = plots.find((p) => p.id === plotId);
    return plot !== undefined && isFollowing(plot, viewWindowByPlot);
  };

  // Each plot's display window, what its chart shows: the gesture-written
  // window at once, else the relative range ending at its axis end. Mounts
  // take `viewWindowNs` from it.
  const displayWindowByPlotId = new Map<string, TimeWindowNs>();
  for (const p of plots) {
    displayWindowByPlotId.set(
      p.id,
      viewWindowByPlot.get(p.id) ?? resolveTimeWindow(p.xAxis, axisEndFor(p.id)).window
    );
  }

  // When a following plot stops following, pin its anchor where its axis ends
  // right now so freezing doesn't pull the axis back: at its axis end (it may
  // be ahead of the anchor), or later, since a following axis also scrolls on
  // animation frames to within a pixel of the current time (useFollowNow).
  const freezeAtDisplayedEnd = useCallback(
    (plot: Plot) => {
      const live = liveResultsByPlot.get(plot.id) ?? NO_LIVE_MAP;
      const endMs = followingEndMs(plot, clock.nowFor(plot.id), live);
      clock.resync([plot.id], Math.max(Date.now(), endMs));
    },
    [clock, liveResultsByPlot]
  );

  // A plot resumes following when its time range is picked again (a new
  // `xAxis`, which `withRangeReset` pairs with autoscroll on) or Autoscroll is
  // turned back on, even after a pan: its panned viewport and debounced fetch
  // window are dropped and its anchor moves to the current time. A plot that
  // stops following through the Autoscroll toggle freezes where its axis
  // ends. A new plot (added or imported) is anchored at the current time.
  const lastSeen = useRef(
    new Map<string, { xAxis: Plot['xAxis']; autoScroll: boolean; following: boolean }>()
  );
  useEffect(() => {
    for (const p of plots) {
      if (relativeRangeMs(p.xAxis.timeRange) !== null) {
        lastRelativeSpan.current.set(p.id, p.xAxis.timeRange);
      }
    }
    const seen = lastSeen.current;
    const resumed: Plot[] = [];
    const added: string[] = [];
    for (const p of plots) {
      const before = seen.get(p.id);
      if (before === undefined) {
        if (seen.size > 0) added.push(p.id);
        continue;
      }
      const autoScroll = p.autoScroll !== false;
      if (before.xAxis !== p.xAxis || (autoScroll && !before.autoScroll)) resumed.push(p);
      else if (!autoScroll && before.following && !viewWindowByPlot.has(p.id)) {
        freezeAtDisplayedEnd(p);
      }
    }
    lastSeen.current = new Map(
      plots.map((p) => [
        p.id,
        {
          xAxis: p.xAxis,
          autoScroll: p.autoScroll !== false,
          following: isFollowing(p, viewWindowByPlot),
        },
      ])
    );
    if (added.length > 0 || resumed.length > 0) {
      clock.resync([...added, ...resumed.map((p) => p.id)]);
    }
    if (resumed.length === 0) return;
    // A pending debounce would re-copy the dropped window; cancel it. Dropping
    // the entry below changes `viewWindowByPlot`, which re-arms the timer for
    // any other plot's pending window.
    if (fetchTimerRef.current !== null) {
      clearTimeout(fetchTimerRef.current);
      fetchTimerRef.current = null;
    }
    const drop = (prev: Map<string, TimeWindowNs>) => {
      if (!resumed.some((p) => prev.has(p.id))) return prev;
      const next = new Map(prev);
      for (const p of resumed) next.delete(p.id);
      return next;
    };
    // A transition the workbench's state write made (a range pick, the
    // Autoscroll toggle) has no event handler here to drop the windows from.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- acts once per transition (lastSeen)
    setViewWindowByPlot(drop);
    setFetchWindowByPlot(drop);
    // Runs on every render that may change what it compares; `lastSeen` makes
    // each transition act once.
  }, [plots, viewWindowByPlot, clock, freezeAtDisplayedEnd]);

  // The range chips of the fullscreen header and a detached title bar, bound
  // to that plot's xAxis writer.
  const rangeControlsFor = (plot: Plot) => (
    <RangeControls
      xAxis={plot.xAxis}
      viewWindowNs={displayWindowByPlotId.get(plot.id)}
      results={{
        archive: archiveResultsByPlot.get(plot.id),
        live: liveResultsByPlot.get(plot.id),
        formula: formulaResultsByPlot.get(plot.id),
      }}
      visibleTraceIds={plot.traces.filter((t) => t.visible).map((t) => t.id)}
      getLastRelativeSpan={() => lastRelativeSpanFor(plot.id)}
      onApplyXAxis={(x) => handleApplyXAxis(plot.id, x)}
    />
  );

  // Live ECharts instances per plot, for capturing PNGs to post to the e-log.
  // A plot can be mounted twice (e.g. grid cell + fullscreen overlay); we keep
  // whichever instance most recently registered and only clear on a matching
  // unregister so a stale unmount can't wipe a live instance.
  const chartInstancesRef = useRef(new Map<string, PngSource>());
  const handleChartInstance = useCallback(
    (plotId: string, instance: PngSource, active: boolean) => {
      const map = chartInstancesRef.current;
      if (active) {
        map.set(plotId, instance);
      } else if (map.get(plotId) === instance) {
        map.delete(plotId);
      }
    },
    []
  );

  // ── Plot operations ─────────────────────────────────────────────────────────

  const addPlot = () => {
    const id = makeId('plot');
    const plot = newPlot(id, plots.length);
    setTool((s) => ({ ...s, plots: [...s.plots, plot], activePlotId: id }));
  };

  const removePlot = (plotId: string) => {
    if (plots.length === 1) return;
    setTool((s) => {
      const remaining = s.plots.filter((p) => p.id !== plotId);
      const activeId = s.activePlotId === plotId ? remaining[0].id : s.activePlotId;
      const history = new Map(s.history);
      history.delete(plotId);
      const annotationMark = s.annotationMark?.plotId === plotId ? null : s.annotationMark;
      return { ...s, plots: remaining, activePlotId: activeId, history, annotationMark };
    });
    if (poppedOutPlot === plotId) setPoppedOutPlot(null);
    setDetachedPlotIds((prev) => prev.filter((id) => id !== plotId));
  };

  const detachPlot = (plotId: string) => {
    setDetachedPlotIds((prev) => (prev.includes(plotId) ? prev : [...prev, plotId]));
    // A detached plot shouldn't also be in the fullscreen overlay.
    if (poppedOutPlot === plotId) setPoppedOutPlot(null);
  };

  const reattachPlot = (plotId: string) => {
    setDetachedPlotIds((prev) => prev.filter((id) => id !== plotId));
  };

  // Escape closes the fullscreen overlay. The listener is on window, which a
  // keydown reaches after document: a Carbon modal opened on top (e.g. Post to
  // E-Log) handles Escape on document and calls preventDefault, and so does a
  // plot's keymap when Escape cancels a drawing, so that keypress does only that.
  useEffect(() => {
    if (!poppedOutPlot) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setPoppedOutPlot(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [poppedOutPlot]);

  // Plot-scoped axis update: direct axis pan/zoom in PlotArea targets a specific
  // plot (grid cells and popouts aren't necessarily the active plot), so route
  // by the plot id rather than assuming activePlotId.
  const updateAxisInPlot = (
    plotId: string,
    axisId: string,
    updates: Partial<Plot['axes'][number]>
  ) => {
    setPlots((prev) =>
      prev.map((p) =>
        p.id === plotId
          ? {
              ...p,
              axes: p.axes.map((a) => (a.id === axisId ? { ...a, ...updates } : a)),
            }
          : p
      )
    );
  };

  // A plot's view settings from the strip (tooltip, drag mode), routed by plot
  // id like the axis writes above.
  const setPlotView = (plotId: string, patch: Partial<PlotView>) => {
    setPlots((prev) => prev.map((p) => (p.id === plotId ? withPlotView(p, patch) : p)));
  };

  // Derive a formula curve from an existing PV trace (the "transform" entry
  // point, the curve's Create formula action). Non-destructive: the source
  // curve is untouched; a new formula is seeded with it bound to {x1} and an
  // identity expression the user then edits, and is selected.
  const createFormulaFromTrace = (sourceTraceId: string) => {
    const plot = plotHoldingCurve(tool, sourceTraceId);
    const source = plot?.traces.find((t) => t.id === sourceTraceId);
    if (!plot || !source) return;
    const id = makeId('formula');
    const formula: PVTrace = {
      id,
      kind: 'formula',
      pvName: '',
      displayName: `f(${source.pvName || source.displayName || 'curve'})`,
      color: colorForIndex(paletteOf(plot), plot.traces.length),
      visible: true,
      axisId: source.axisId,
      useLive: false,
      useArchive: false,
      expression: '{x1}',
      bindings: { x1: sourceTraceId },
      lineWidth: 2,
      lineType: 'direct',
      lineStyle: 'solid',
      showSymbol: false,
      symbolShape: 'circle',
      symbolSize: 10,
      data: [],
    };
    setPlots((prev) =>
      prev.map((p) => (p.id === plot.id ? { ...p, traces: [...p.traces, formula] } : p))
    );
    selection.select({ level: 'item', kind: FORMULA_CURVE_ITEM_KIND, id }, 'user');
  };

  // ── Action handlers ─────────────────────────────────────────────────────────

  const handleSave = () => {
    const json = serializeWorkspace({ theme: colorMode, plots });
    // Same local-time YYYYMMDD_HHMMSS stamp as the PNG export.
    downloadBlob(`trace-${timestamp()}.trc.json`, 'application/json', json);
  };

  const handleImport = async () => {
    const file = await pickFile('.trc,.trc.json,.json,.xml,.stp');
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.xml') || lower.endsWith('.stp')) {
      alert(`Import: ${lower.split('.').pop()?.toUpperCase()} files are not supported yet.`);
      return;
    }
    const text = await file.text();
    let result;
    try {
      result = deserializeWorkspace(text);
    } catch (err) {
      alert(`Failed to import: ${(err as Error).message}`);
      return;
    }
    // A file that fails to parse leaves the open workspace, and its lookups, alone.
    unitLookups.abortAll();
    // Formula curves import intact in every mode: embedded, the host relays
    // the Formula Engine's validate and evaluate POSTs.
    // A `.trc.json` plot opens in the palette it states, else the one its curve
    // colours imply; a legacy `.trc` opens in the default palette.
    const importedPlots =
      result.source === 'native' ? result.plots.map(withFilePalette) : result.plots;
    // A newly opened workspace starts with empty undo rings.
    setTool((s) => ({
      plots: importedPlots,
      activePlotId: importedPlots.length > 0 ? importedPlots[0].id : s.activePlotId,
      history: new Map(),
      annotationMark: null,
    }));
    if (result.theme) setColorMode(result.theme);
    if (result.warnings.length > 0) {
      console.warn('Import warnings:', result.warnings);
      alert(`Imported with ${result.warnings.length} warning(s):\n\n${result.warnings.join('\n')}`);
    }
  };

  const handleExport = () => {
    const files = buildCsvFiles(plots, archiveResultsByPlot, formulaResultsByPlot);
    if (files.length === 0) {
      alert('No data to export. Toggle archive on a trace or add a formula, then wait for data.');
      return;
    }
    for (const f of files) {
      downloadBlob(f.filename, 'text/csv', f.csv);
    }
  };

  // Plot snapshots staged for printing. Non-null while the print sheet is
  // rendered; the effect below opens the print dialog and clears it after.
  const [printShots, setPrintShots] = useState<
    { plotId: string; title: string; dataUrl: string }[] | null
  >(null);

  // Snapshot what's on screen, for print and PNG export: the fullscreen copy
  // if a plot is popped out, the active plot in tab view, or every plot in grid
  // view. When a plot is fullscreen, that copy is captured rather than the
  // in-window one hidden behind it (both share a data-plot-id). Detached plots
  // live in another window, so capture returns null and they're skipped.
  const captureOnScreenPlots = async () => {
    const targets = poppedOutPlot
      ? plots.filter((p) => p.id === poppedOutPlot)
      : viewMode === 'tabs'
        ? [activePlot]
        : plots;
    const urls = await Promise.all(
      targets.map((p) =>
        capturePlotPng(p, colorMode, p.id === poppedOutPlot, annotationsHidden.has(p.id))
      )
    );
    return targets.flatMap((p, i) => {
      const dataUrl = urls[i];
      return dataUrl ? [{ plotId: p.id, title: p.title, dataUrl }] : [];
    });
  };

  // Export plots as PNG (one file each, mirroring the CSV export), captured
  // exactly as print does. Filenames share one timestamp so a grid export
  // reads as a single batch.
  const handleExportImage = async () => {
    const stamp = timestamp();
    const shots = await captureOnScreenPlots();
    if (shots.length === 0) {
      alert('No plot is ready to export yet. Wait for the chart to render and try again.');
      return;
    }
    for (const s of shots) {
      void downloadDataUrl(`${safeFilename(s.title)}_${stamp}.png`, s.dataUrl).catch(() => {
        alert(`Failed to export "${s.title}".`);
      });
    }
  };

  const handlePrint = async () => {
    const shots = await captureOnScreenPlots();
    if (shots.length === 0) {
      // Nothing capturable (e.g. everything detached): fall back to the
      // browser's default full-page print.
      window.print();
      return;
    }
    setPrintShots(shots);
  };

  useEffect(() => {
    if (!printShots) return;
    document.body.classList.add('printing-chart');
    let cancelled = false;
    // Give the sheet's images a chance to decode before the blocking print
    // dialog opens. Both decode() and rAF can stall on hidden pages, so race
    // against a short timer to guarantee print fires regardless.
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('.print-sheet img'));
    const decoded = Promise.allSettled(imgs.map((img) => img.decode()));
    const timeout = new Promise((resolve) => setTimeout(resolve, 500));
    Promise.race([decoded, timeout]).then(() => {
      if (cancelled) return;
      window.print();
      setPrintShots(null);
    });
    return () => {
      cancelled = true;
      document.body.classList.remove('printing-chart');
    };
  }, [printShots]);

  // Capture context-aware plots (active plot in tabs view, all plots in grid)
  // and open the e-log post dialog. Background matches the current chart theme.
  const openElogPost = useCallback(async () => {
    if (!elogConfig?.enabled) return;
    const targetPlots = viewMode === 'grid' ? plots : [activePlot];
    const bg = chartThemeFor(colorMode).bg;
    const captured = await capturePlots(
      targetPlots.map((p) => ({
        id: p.id,
        title: p.title,
        instance: chartInstancesRef.current.get(p.id),
      })),
      bg
    );
    setElogModal({ open: true, captured });
  }, [elogConfig?.enabled, viewMode, plots, activePlot, colorMode]);

  const buildElogConfigFile = useCallback((): File => {
    const json = serializeWorkspace({ theme: colorMode, plots });
    return new File([json], 'trace_config.json', { type: 'application/json' });
  }, [colorMode, plots]);

  const handleRefreshArchive = () => {
    archiveStore.refetchAll();
  };

  // ── Data Insight Tool ─────────────────────────────────────────────────────────

  const openInsight = (traceId?: string) => {
    const pv = traceId ?? activePlot.traces.find((t) => t.pvName)?.id;
    setInsight((prev) => ({ ...prev, open: true, minimized: false, pv: pv ?? prev.pv }));
  };

  // The DIT inspects every visible plot in grid view (so any plot's PVs are
  // reachable), or just the active plot in tab view.
  const insightPlots = viewMode === 'grid' ? plots : [activePlot];
  // Keep the selected PV valid for the inspectable set; fall back to its first PV.
  const insightTraces = insightPlots.flatMap((p) => p.traces);
  const insightPv =
    (insight.pv && insightTraces.some((t) => t.id === insight.pv)
      ? insight.pv
      : insightTraces.find((t) => t.pvName)?.id) ?? '';

  // ── Workbench ───────────────────────────────────────────────────────────────

  // Each plot's last cursor time inside the plot ("Copy value at cursor").
  const [cursorTimes] = useState(() => new Map<string, number>());
  const recordCursor = useCallback(
    (plotId: string, t: number) => void cursorTimes.set(plotId, t),
    [cursorTimes]
  );

  // The model: what the schemas read beyond the state — the palette new curves
  // follow, each plot's chart-option input (Code tab, row status dots), and
  // the two curve actions that are not state transforms, and the unit lookups.
  const chartTheme = chartThemeFor(colorMode);
  const model: TraceModel = {
    palette: paletteOf(activePlot),
    fragmentInput: (plot) => ({
      plot,
      archiveResults: archiveResultsByPlot.get(plot.id) ?? NO_ARCHIVE,
      liveResults: liveResultsByPlot.get(plot.id) ?? NO_LIVE,
      formulaResults: formulaResultsByPlot.get(plot.id) ?? NO_FORMULA,
      theme: chartTheme,
    }),
    inspect: (traceId) => openInsight(traceId),
    createFormula: (traceId) => createFormulaFromTrace(traceId),
    unitLookups,
  };
  const definition = useTraceDefinition({ state: tool, model, update, selection });
  // The queued drawing select, applied once its plot is active. Declared after
  // `useTraceDefinition`, whose activation reset runs first in the same commit.
  useEffect(() => {
    const pending = pendingSelection.current;
    if (pending === null || pending.plotId !== activePlotId) return;
    pendingSelection.current = null;
    selection.select({ level: 'item', kind: DRAWING_ITEM_KIND, id: pending.id }, 'user');
  }, [activePlotId, selection]);

  // Trace's actions bar: every former toolbar button and shortcut, each
  // shortcut bound by the workbench from its action (no table of Trace's own).
  const standardOptions = useStandardActionsOptions(colorMode);
  const actionOptions: TraceActionsOptions = {
    handlers: {
      refreshArchive: handleRefreshArchive,
      dataInsight: () => openInsight(),
      postElog: () => void openElogPost(),
      save: handleSave,
      print: () => void handlePrint(),
      import: () => void handleImport(),
      exportCsv: handleExport,
      exportPng: () => void handleExportImage(),
    },
    capabilities,
    ...standardOptions,
    // Under the host bar only: the tile bar's "Plots as grid" toggle, pressed = grid.
    viewMode: {
      grid: viewMode === 'grid',
      toggle: () => setViewMode((m) => (m === 'grid' ? 'tabs' : 'grid')),
    },
  };
  // The drawing channel: PlotArea slices it per tab and grid mount, the
  // fullscreen and detached mounts below take the same slice.
  const annotationChannel: AnnotationChannel = {
    annotationsHiddenPlotIds: ui.annotationsHidden,
    annotationPrefsByPlot: annotationPrefs,
    onAnnotationPrefs: setAnnotationPrefs,
    selectedAnnotationId,
    onSelectAnnotation,
    onCommitAnnotations: commitAnnotations,
    onAnnotationsHidden: setAnnotationsHidden,
    onPlotView: setPlotView,
  };
  return (
    <div className="trace-app">
      {/* The workbench: actions bar on top, the sidebar (Layers + Properties)
          beside the plot canvas, which takes all the remaining width. */}
      <WorkbenchLayout
        definition={definition}
        state={tool}
        model={model}
        ui={ui}
        update={update}
        capabilities={capabilities}
        selection={selection}
        archiver={activePlot.archiver}
        toolId="trace"
        hostState={traceHostState(plots)}
      >
        <TraceCanvasActions options={actionOptions} />
        <TraceMenu
          input={{
            state: tool,
            archiveResultsByPlot,
            liveResultsByPlot,
            formulaResultsByPlot,
            cursorOf: (id) => cursorTimes.get(id),
          }}
        />
        <UndoKeyListener onUndo={() => undoAnnotations(poppedOutPlot ?? activePlotId)} />
        <div className="plot-and-insight">
          <div className="plot-and-insight__plot">
            <TraceCursorContext.Provider value={recordCursor}>
              <ErrorBoundary resetKeys={[activePlotId, viewMode]}>
                <PlotArea
                  plots={plots}
                  activePlotId={activePlotId}
                  viewMode={viewMode}
                  archiveResultsByPlot={archiveResultsByPlot}
                  liveResultsByPlot={liveResultsByPlot}
                  formulaResultsByPlot={formulaResultsByPlot}
                  onSetActivePlot={setActivePlotId}
                  onAddPlot={addPlot}
                  onRemovePlot={removePlot}
                  onSetViewMode={setViewMode}
                  onPopOutPlot={setPoppedOutPlot}
                  detachedPlotIds={detachedPlotIds}
                  onDetachPlot={detachPlot}
                  onReattachPlot={reattachPlot}
                  onViewWindowChange={handleViewWindowChange}
                  displayWindowByPlotId={displayWindowByPlotId}
                  axisEndFor={axisEndFor}
                  followingFor={followingFor}
                  onUpdateAxis={updateAxisInPlot}
                  onApplyXAxis={handleApplyXAxis}
                  lastRelativeSpanFor={lastRelativeSpanFor}
                  onChartInstance={handleChartInstance}
                  statsWindowByPlotId={statsWindowByPlotId}
                  hostBar={standardOptions.hostBar}
                  {...annotationChannel}
                />
              </ErrorBoundary>
            </TraceCursorContext.Provider>
          </div>
          {insight.open && !insight.detached && insight.minimized && (
            <div className="insight-minbar">
              <span className="insight-minbar__title">Data Insight</span>
              <button
                className="insight-tool__btn"
                title="Restore"
                onClick={() => setInsight((p) => ({ ...p, minimized: false }))}
              >
                <ChevronUp size={16} />
              </button>
              <button
                className="insight-tool__btn"
                title="Close"
                onClick={() => setInsight((p) => ({ ...p, open: false }))}
              >
                <Close size={16} />
              </button>
            </div>
          )}
          {insight.open && !insight.detached && !insight.minimized && (
            <div className="insight-dock">
              <ErrorBoundary resetKeys={[insightPv]}>
                <InsightTool
                  plots={insightPlots}
                  windowByPlotId={statsWindowByPlotId}
                  selectedPv={insightPv}
                  onSelectPv={(id) => setInsight((p) => ({ ...p, pv: id }))}
                  onClose={() => setInsight((p) => ({ ...p, open: false }))}
                  onMinimize={() => setInsight((p) => ({ ...p, minimized: true }))}
                  onDetach={() => setInsight((p) => ({ ...p, detached: true }))}
                />
              </ErrorBoundary>
            </div>
          )}
        </div>
      </WorkbenchLayout>

      {/* Fullscreen modal */}
      {poppedOutPlot &&
        (() => {
          const plot = plots.find((p) => p.id === poppedOutPlot);
          if (!plot) return null;
          return (
            <div
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.8)',
                zIndex: 50,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 32,
              }}
            >
              <div
                style={{
                  background: 'var(--cds-background)',
                  border: '1px solid var(--cds-border-subtle)',
                  borderRadius: 8,
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  color: 'var(--cds-text-primary)',
                }}
              >
                <div
                  style={{
                    height: 48,
                    background: 'var(--cds-layer)',
                    borderBottom: '1px solid var(--cds-border-subtle)',
                    borderRadius: '8px 8px 0 0',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0 16px',
                    flexShrink: 0,
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 500 }}>{plot.title}</span>
                  <div
                    data-range-site="fullscreen"
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    {rangeControlsFor(plot)}
                    <button
                      onClick={() => setPoppedOutPlot(null)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--cds-text-secondary)',
                        cursor: 'pointer',
                        padding: 4,
                        display: 'flex',
                        alignItems: 'center',
                      }}
                    >
                      <Close size={20} />
                    </button>
                  </div>
                </div>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <PlotWithStatistics
                    plot={plot}
                    fullscreen
                    archiveResults={archiveResultsByPlot.get(plot.id) ?? new Map()}
                    liveResults={liveResultsByPlot.get(plot.id) ?? new Map()}
                    formulaResults={formulaResultsByPlot.get(plot.id) ?? new Map()}
                    // Wired like the detached mount: fullscreen gestures go through
                    // the one window-write path.
                    onViewWindowChange={(w, opts) => handleViewWindowChange(plot.id, w, opts)}
                    viewWindowNs={displayWindowByPlotId.get(plot.id)}
                    endMs={axisEndFor(plot.id)}
                    following={followingFor(plot.id)}
                    statsWindowNs={statsWindowByPlotId.get(plot.id)}
                    onUpdateAxis={(id, u) => updateAxisInPlot(plot.id, id, u)}
                    onApplyXAxis={(x) => handleApplyXAxis(plot.id, x)}
                    // eslint-disable-next-line react-hooks/refs -- ref is written on mount/unmount, not during render
                    onChartInstance={(inst, active) => handleChartInstance(plot.id, inst, active)}
                    {...annotationMountProps(plot.id, annotationChannel)}
                  />
                </div>
              </div>
            </div>
          );
        })()}

      {/* Notice for a detach the browser blocked (DetachedWindow onBlocked). */}
      {blockedPopup &&
        createPortal(
          <div
            style={{ position: 'fixed', top: 56, right: 16, zIndex: 9999 }}
            role="status"
            aria-live="polite"
          >
            <ToastNotification
              kind="warning"
              title="Pop-up blocked"
              subtitle={`${blockedPopup} couldn't open in a new window. Allow pop-ups for this site in your browser, then try again.`}
              timeout={0}
              onClose={() => {
                setBlockedPopup(null);
                return true;
              }}
            />
          </div>,
          document.body
        )}

      {/* Detached plots — each renders into its own browser window via portal. */}
      {detachedPlotIds.map((id) => {
        const plot = plots.find((p) => p.id === id);
        if (!plot) return null;
        return (
          <DetachedWindow
            key={id}
            name={`trace-plot-${id}`}
            title={`${plot.title} — Trace`}
            onBlocked={() => setBlockedPopup(plot.title || 'This plot')}
            onClose={() => reattachPlot(id)}
          >
            <DetachedRoot
              style={{
                height: '100vh',
                background: 'var(--cds-background)',
                color: 'var(--cds-text-primary)',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <UndoKeyListener onUndo={() => undoAnnotations(plot.id)} />
              <div
                style={{
                  height: 40,
                  flexShrink: 0,
                  background: 'var(--cds-layer)',
                  borderBottom: '1px solid var(--cds-border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0 12px',
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 500 }}>{plot.title}</span>
                <div
                  data-range-site="detached"
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  {rangeControlsFor(plot)}
                  <button
                    onClick={() => reattachPlot(id)}
                    title="Reattach to main window"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      background: 'none',
                      border: '1px solid var(--cds-border-subtle)',
                      borderRadius: 2,
                      color: 'var(--cds-text-primary)',
                      cursor: 'pointer',
                      padding: '4px 8px',
                      fontSize: 12,
                    }}
                  >
                    <Login size={14} />
                    Reattach
                  </button>
                </div>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <PlotWithStatistics
                  plot={plot}
                  archiveResults={archiveResultsByPlot.get(plot.id) ?? new Map()}
                  liveResults={liveResultsByPlot.get(plot.id) ?? new Map()}
                  formulaResults={formulaResultsByPlot.get(plot.id) ?? new Map()}
                  onViewWindowChange={(w, opts) => handleViewWindowChange(plot.id, w, opts)}
                  viewWindowNs={displayWindowByPlotId.get(plot.id)}
                  endMs={axisEndFor(plot.id)}
                  following={followingFor(plot.id)}
                  statsWindowNs={statsWindowByPlotId.get(plot.id)}
                  onUpdateAxis={(id, u) => updateAxisInPlot(plot.id, id, u)}
                  onApplyXAxis={(x) => handleApplyXAxis(plot.id, x)}
                  onChartInstance={(inst, active) => handleChartInstance(plot.id, inst, active)}
                  {...annotationMountProps(plot.id, annotationChannel)}
                />
              </div>
            </DetachedRoot>
          </DetachedWindow>
        );
      })}

      {/* Data Insight Tool detached into its own window */}
      {insight.open && insight.detached && (
        <DetachedWindow
          name="data-insight"
          title="Data Insight Tool"
          width={720}
          height={560}
          onBlocked={() => setBlockedPopup('Data Insight')}
          onClose={() => setInsight((p) => ({ ...p, detached: false }))}
        >
          <DetachedRoot
            style={{
              height: '100vh',
              background: 'var(--cds-background)',
              color: 'var(--cds-text-primary)',
            }}
          >
            <InsightTool
              plots={insightPlots}
              windowByPlotId={statsWindowByPlotId}
              selectedPv={insightPv}
              detached
              onSelectPv={(id) => setInsight((p) => ({ ...p, pv: id }))}
              onClose={() => setInsight((p) => ({ ...p, open: false, detached: false }))}
              onReattach={() => setInsight((p) => ({ ...p, detached: false }))}
            />
          </DetachedRoot>
        </DetachedWindow>
      )}

      {/* Sheet shown only by the @media print rules while printing-chart is
          set on <body>; see handlePrint. Portaled under <body> so it escapes
          the app shell's fixed-height/overflow layout and can flow across
          printed pages. Tiled into columns matching the on-screen grid
          (--print-cols from the plot count). */}
      {printShots &&
        createPortal(
          <div
            className="print-sheet"
            style={{
              ['--print-cols' as string]: Math.ceil(Math.sqrt(printShots.length)),
              // Rows the grid wraps to; image height is capped at a per-row
              // share of the page so a multi-row grid fits on one page.
              ['--print-rows' as string]: Math.ceil(
                printShots.length / Math.ceil(Math.sqrt(printShots.length))
              ),
            }}
          >
            {printShots.map((shot) => (
              <figure key={shot.plotId} className="print-sheet__plot">
                <figcaption>{shot.title}</figcaption>
                <img src={shot.dataUrl} alt={shot.title} />
              </figure>
            ))}
          </div>,
          document.body
        )}

      {elogConfig?.enabled && (
        <PostToElogModal
          open={elogModal.open}
          captured={elogModal.captured}
          defaultLogbookIds={elogConfig.defaultLogbookIds}
          buildConfigFile={buildElogConfigFile}
          onClose={() => setElogModal((p) => ({ ...p, open: false }))}
          onPosted={(entry) =>
            setElogToast({
              kind: 'success',
              title: 'Posted to E-Log',
              subtitle: `Entry ${entry.id} created`,
            })
          }
          onPostFailed={(message) =>
            setElogToast({ kind: 'error', title: 'E-Log post failed', subtitle: message })
          }
        />
      )}

      {elogToast &&
        createPortal(
          <div
            style={{ position: 'fixed', top: 56, right: 16, zIndex: 9999 }}
            role="status"
            aria-live="polite"
          >
            <ToastNotification
              kind={elogToast.kind}
              title={elogToast.title}
              subtitle={elogToast.subtitle}
              timeout={elogToast.kind === 'success' ? 5000 : 0}
              onClose={() => {
                setElogToast(null);
                return true;
              }}
            />
          </div>,
          document.body
        )}
    </div>
  );
}
