import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Panel,
  Group as PanelGroup,
  Separator as PanelResizeHandle,
  usePanelRef,
} from 'react-resizable-panels';
import { Close, Login, ChevronUp } from '@carbon/icons-react';
import { Header, HeaderName, HeaderGlobalBar, Theme, ToastNotification } from '@carbon/react';
import type { Plot, PVTrace, Axis } from '../types';
import { LeftPanel } from './LeftPanel';
import { DetachedWindow } from './DetachedWindow';
import { DataInsightTool } from './DataInsightTool';
import { PlotArea, SinglePlot } from './PlotArea';
import { capturePlotPng } from '../capturePlot';
import { RightPanel } from './RightPanel';
import { Toolbar } from './Toolbar';
import { useArchiveSeries, type ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import { useLiveSeries, type LiveSeriesResult } from '../hooks/useLiveSeries';
import { archiveStore } from '../state/archiveStore';
import { axisEndMs, isFollowing, useAutoScrollTimers } from '../hooks/useAutoScrollTimers';
import { useFormulaSeries, type FormulaSeriesResult } from '../hooks/useFormulaSeries';
import type { TimeWindowNs } from '../api/time';
import { resolveTimeWindow } from '../api/time';
import { fetchMetadata } from '@slaclab/canopy-client';
import { useCanopyConnection } from '@slaclab/canopy-react';
import { setColorMode, useColorMode } from '../state/themeStore';
import { usePaletteId } from '../state/paletteStore';
import { getPalette, colorForIndex } from '../palettes';
import { downloadBlob, downloadDataUrl, pickFile } from '../io/download';
import {
  serializeWorkspace,
  deserializeWorkspace,
  deserializeConfigData,
  type DeserializeResult,
} from '../io/serialize';
import { buildCsvFiles } from '../io/exportCsv';
import { safeFilename, timestamp } from '../io/filename';
import { makeId } from '../id';
import { resolveFormulaSpec } from '../formula';
import type { FormulaSpec } from '@slaclab/canopy-client';
import { capturePlots, type PngSource, type CapturedPlot } from '../io/exportPlotImage';
import { PostToElogModal } from './PostToElogModal';
import { ConfigStoreModal } from './ConfigStoreModal';
import { getConfig } from '../api/magpie';
import { CanopyError } from '../api/client';
import { useElogConfig } from '../hooks/useElogConfig';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';

const BUG_REPORT_URL = 'https://forms.office.com/r/qV7BmK2xi9';
const DOCS_URL = 'https://fuzzy-adventure-4qvly8m.pages.github.io/';

function generateMockData(
  points: number,
  baseline: number,
  variance: number
): { time: number; value: number }[] {
  const now = Date.now();
  return Array.from({ length: points }, (_, i) => ({
    time: now - (points - i) * 1000,
    value: baseline + (Math.random() - 0.5) * variance,
  }));
}

// The app starts with a single empty plot so users begin from a clean slate.
const INITIAL_PLOTS: Plot[] = [
  {
    id: 'plot-1',
    title: 'Plot 1',
    backgroundColor: '#161616',
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
    axes: [
      {
        id: 'y-axis-1',
        name: 'Y-Axis 1',
        orientation: 'left',
        autoScale: true,
        logScale: false,
        visible: true,
      },
    ],
    traces: [],
  },
];

// `plotId` scopes the selection to a specific plot so the layer panel can edit
// any plot in grid view (trace/axis ids aren't globally unique across plots).
export type SelectedItem = {
  type: 'trace' | 'axis' | 'plot';
  id: string;
  plotId: string;
} | null;

export function TraceApp() {
  const canopy = useCanopyConnection();
  const [plots, setPlots] = useState<Plot[]>(INITIAL_PLOTS);
  const [activePlotId, setActivePlotId] = useState<string>('plot-1');
  const [selectedItem, setSelectedItem] = useState<SelectedItem>({
    type: 'plot',
    id: 'plot-1',
    plotId: 'plot-1',
  });
  const [viewMode, setViewMode] = useState<'tabs' | 'grid'>('tabs');
  const [poppedOutPlot, setPoppedOutPlot] = useState<string | null>(null);
  // Plots detached into their own browser windows. Their charts render there
  // via a portal; the main window shows a reattach placeholder in their place.
  const [detachedPlotIds, setDetachedPlotIds] = useState<string[]>([]);
  // What the browser last refused to open as a pop-up (a plot title or "Data
  // Insight"), shown in a toast. DetachedWindow reattaches it on its own.
  const [blockedPopup, setBlockedPopup] = useState<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  // Data Insight Tool: a dockable panel that can be minimized or popped out into
  // its own window. `pv` is the trace id whose PV is being inspected.
  const [insight, setInsight] = useState<{
    open: boolean;
    minimized: boolean;
    detached: boolean;
    pv?: string;
  }>({ open: false, minimized: false, detached: false });
  const { colorMode, toggle: toggleTheme } = useColorMode();
  const { paletteId } = usePaletteId();
  const elogConfig = useElogConfig();
  // E-Log post dialog. `captured` holds the plot PNGs snapshotted at open time
  // (data URLs), so editing in the dialog works against a stable image set.
  const [elogModal, setElogModal] = useState<{ open: boolean; captured: CapturedPlot[] }>({
    open: false,
    captured: [],
  });
  // Config-store (magpie) save/browse dialog.
  const [configModalOpen, setConfigModalOpen] = useState(false);
  // Shared success/error toast (E-Log posts, config-store save/load, …). `seq`
  // keys the ToastNotification: Carbon arms its auto-dismiss timer in an effect
  // keyed on `timeout`, so two same-kind toasts in a row would reuse one
  // instance and the first toast's timer would dismiss the second early.
  const [toast, setToast] = useState<{
    kind: 'success' | 'error';
    title: string;
    subtitle?: string;
    timeout?: number;
    seq: number;
  } | null>(null);
  const toastSeq = useRef(0);
  const showToast = useCallback(
    (t: { kind: 'success' | 'error'; title: string; subtitle?: string; timeout?: number }) => {
      setToast({ ...t, seq: ++toastSeq.current });
    },
    []
  );
  // Last viewport emitted by each plot's dataZoom. Drives the archive store's
  // window per trace; the store decides whether the change requires a fetch
  // based on its coverage check, so this map can be updated freely.
  const [viewWindowByPlot, setViewWindowByPlot] = useState<Map<string, TimeWindowNs>>(
    () => new Map()
  );
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0);
  const leftPanelRef = usePanelRef();
  const rightPanelRef = usePanelRef();
  // In-flight units lookups per trace, so a rapid PV re-selection aborts the
  // previous fetch and the last selection wins (see assignTraceToUnitAxis).
  const unitFetchAbortRef = useRef(new Map<string, AbortController>());

  // Per-plot "now". A following plot's anchor advances once per its refresh
  // interval; any other plot's anchor holds, which freezes its window.
  const clock = useAutoScrollTimers(plots, viewWindowByPlot);
  const resyncClock = clock.resync;

  const activePlot = plots.find((p) => p.id === activePlotId) ?? plots[0];

  const allTraces = plots.flatMap((p) => p.traces);

  // Each plot's fetch window: a pan/zoom view window takes precedence,
  // otherwise the plot's time range resolved at its anchor. It feeds the
  // archive, formula and Data Insight queries; the chart gets the axis end (see
  // axisEndFor) and resolves the full requested range itself (a view window is
  // a sub-zoom of that range, not the axis extent). Each trace takes its plot's
  // fetch window: the time range is plot-level — traces don't carry their own.
  const fetchWindowByPlot = new Map<string, TimeWindowNs>();
  const windowByTrace = new Map<string, TimeWindowNs>();
  // Each trace inherits its plot's default archiver unless it sets its own.
  const plotArchiverByTrace = new Map<string, string | undefined>();
  // Resolved Fox spec per formula trace (bindings mapped to PV names); null when
  // the formula isn't ready to evaluate (empty expression or an unbound variable).
  const formulaSpecByTrace = new Map<string, FormulaSpec | null>();
  for (const plot of plots) {
    const win =
      viewWindowByPlot.get(plot.id) ?? resolveTimeWindow(plot.xAxis, clock.nowFor(plot.id)).window;
    fetchWindowByPlot.set(plot.id, win);
    for (const trace of plot.traces) {
      if (trace.useArchive) windowByTrace.set(trace.id, win);
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
  const liveResults = useLiveSeries(allTraces);
  const formulaResults = useFormulaSeries(allTraces, formulaSpecByTrace, windowByTrace);

  const handleViewWindowChange = (plotId: string, window: TimeWindowNs) => {
    setViewWindowByPlot((prev) => {
      const next = new Map(prev);
      next.set(plotId, window);
      return next;
    });
    // A manual pan/zoom takes over the window, so stop tracking "now". Picking a
    // time range re-enables it (see updatePlot).
    setPlots((prev) => prev.map((p) => (p.id === plotId ? { ...p, autoScroll: false } : p)));
  };

  // Split the flat result maps per plot. Memoized on (plots, archiveResults,
  // liveResults, formulaResults): live/formula data drives frequent re-renders
  // via useSyncExternalStore, and rebuilding these maps every render would churn
  // the props passed into PlotArea / RightPanel. The hooks now return stable
  // references when their data is unchanged, so this memo holds across frames
  // that don't touch the underlying series.
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

  // Where each plot's time axis ends (see axisEndMs). The chart draws to this,
  // and stopping Autoscroll or a pan freezes the plot here, so both agree.
  const axisEndFor = (plotId: string): number => {
    const plot = plots.find((p) => p.id === plotId);
    const anchorMs = clock.nowFor(plotId);
    if (!plot) return anchorMs;
    const live = liveResultsByPlot.get(plotId) ?? new Map<string, LiveSeriesResult>();
    return axisEndMs(plot, anchorMs, isFollowing(plot, viewWindowByPlot), live);
  };

  // When a following plot stops following, pin its anchor where its axis ends
  // right now so freezing doesn't pull the axis back: at axisEndFor (it may be
  // ahead of the anchor; see axisEndMs), or later, since a following axis also
  // scrolls on animation frames to within a pixel of the current time
  // (useFollowNow).
  const freezeAtDisplayedEnd = (plotId: string) => {
    const plot = plots.find((p) => p.id === plotId);
    if (!plot || !isFollowing(plot, viewWindowByPlot)) return;
    clock.resync([plotId], Math.max(Date.now(), axisEndFor(plotId)));
  };

  // Selecting an item also focuses its plot, so RightPanel / Data Insight (which
  // read `activePlot`) stay correct even when selecting across plots in grid view.
  const selectItem = (item: SelectedItem) => {
    setSelectedItem(item);
    if (item) setActivePlotId(item.plotId);
  };

  // Per-plot, per-axis computed [min, max] published by ECharts after each
  // render. A ref so PlotArea can update without re-rendering TraceApp; the
  // value is read lazily by RightPanel when the user toggles auto-scale off.
  const axisRangesRef = useRef(new Map<string, Map<string, [number, number]>>());
  const handleAxisRangesChange = useCallback(
    (plotId: string, ranges: Map<string, [number, number]>) => {
      axisRangesRef.current.set(plotId, ranges);
    },
    []
  );
  const getAxisRange = useCallback(
    (axisId: string): [number, number] | undefined =>
      axisRangesRef.current.get(activePlotId)?.get(axisId),
    [activePlotId]
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
    const plotNum = plots.length + 1;
    setPlots((prev) => [
      ...prev,
      {
        id,
        title: `Plot ${plotNum}`,
        backgroundColor: '#161616',
        showLegend: true,
        showXGridlines: true,
        showYGridlines: true,
        showCrosshair: true,
        gridStyle: 'solid',
        gridOpacity: 1,
        tickFontSize: 11,
        xAxis: { timeRange: '-1h' },
        autoScroll: true,
        refreshIntervalS: 5,
        axes: [
          {
            id: `${id}-axis-1`,
            name: 'Y-Axis 1',
            orientation: 'left',
            autoScale: true,
            logScale: false,
            visible: true,
          },
        ],
        traces: [],
      },
    ]);
    clock.resync([id]);
    setActivePlotId(id);
    // Select the new plot's settings too: Properties resolves a trace/axis
    // selection only within the active plot, so a stale one from the previous
    // plot would leave it empty.
    setSelectedItem({ type: 'plot', id, plotId: id });
  };

  const removePlot = (plotId: string) => {
    if (plots.length === 1) return;
    setPlots((prev) => prev.filter((p) => p.id !== plotId));
    if (poppedOutPlot === plotId) setPoppedOutPlot(null);
    setDetachedPlotIds((prev) => prev.filter((id) => id !== plotId));
    if (activePlotId === plotId) {
      const remaining = plots.filter((p) => p.id !== plotId);
      setActivePlotId(remaining[0].id);
    }
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
  // E-Log) handles Escape on document and calls preventDefault, so that
  // keypress closes only the modal.
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

  const clearViewWindow = (plotId: string) => {
    setViewWindowByPlot((prev) => {
      if (!prev.has(plotId)) return prev;
      const next = new Map(prev);
      next.delete(plotId);
      return next;
    });
  };

  const updatePlot = (plotId: string, updates: Partial<Plot>) => {
    // Picking a new x-axis time range is an explicit reset: drop the panned
    // viewport so the next render uses the relative range (PlotArea also
    // dispatches a dataZoom reset when the range changes or the plot resumes
    // following), re-enable tracking, and re-anchor the plot at the current
    // time. Turning Autoscroll back on resumes the same way, even after a pan.
    const reselectsRange = !!updates.xAxis && 'timeRange' in updates.xAxis;
    const resumes = reselectsRange || updates.autoScroll === true;
    if (updates.autoScroll === false && !resumes) freezeAtDisplayedEnd(plotId);
    setPlots((prev) =>
      prev.map((p) =>
        p.id === plotId ? { ...p, ...updates, ...(resumes ? { autoScroll: true } : {}) } : p
      )
    );
    if (resumes) {
      clearViewWindow(plotId);
      clock.resync([plotId]);
    }
  };

  // A pan/zoom started on a following plot: stop following the same way the
  // Autoscroll toggle does, before the view window is debounced in.
  const handleFollowStop = (plotId: string) => updatePlot(plotId, { autoScroll: false });

  // ── Trace operations ─────────────────────────────────────────────────────────

  const addTrace = (plotId: string, axisId: string) => {
    const id = makeId('trace');
    const traceCount = plots.find((p) => p.id === plotId)?.traces.length ?? 0;
    const newTrace: PVTrace = {
      id,
      pvName: '',
      displayName: '', // traceLabel() falls back to pvName --> no default needed
      color: colorForIndex(getPalette(paletteId), traceCount),
      visible: true,
      axisId,
      // New traces default to both sources on. Live is the headline; archive
      // backfills the past until live samples arrive.
      useLive: true,
      updateRate: 'monitor',
      useArchive: true,
      lineWidth: 2,
      lineType: 'step',
      lineStyle: 'solid',
      showSymbol: false,
      symbolShape: 'circle',
      symbolSize: 10,
      data: generateMockData(50, 10, 2),
    };
    setPlots((prev) =>
      prev.map((p) => (p.id === plotId ? { ...p, traces: [...p.traces, newTrace] } : p))
    );
    selectItem({ type: 'trace', id, plotId });
  };

  const addFormula = (plotId: string, axisId: string) => {
    const id = makeId('formula');
    const traceCount = plots.find((p) => p.id === plotId)?.traces.length ?? 0;
    const newFormula: PVTrace = {
      id,
      kind: 'formula',
      pvName: '',
      displayName: 'New Formula',
      color: colorForIndex(getPalette(paletteId), traceCount),
      visible: true,
      axisId,
      // Formula curves have no PV data source; their values come from Fox.
      useLive: false,
      updateRate: 'monitor',
      useArchive: false,
      expression: '',
      bindings: {},
      lineWidth: 2,
      lineType: 'direct',
      lineStyle: 'solid',
      showSymbol: false,
      symbolShape: 'circle',
      symbolSize: 10,
      data: [],
    };
    setPlots((prev) =>
      prev.map((p) => (p.id === plotId ? { ...p, traces: [...p.traces, newFormula] } : p))
    );
    selectItem({ type: 'trace', id, plotId });
  };

  // Derive a formula curve from an existing PV trace (the "transform" entry
  // point). Non-destructive: the source curve is untouched; a new formula is
  // seeded with it bound to {x1} and an identity expression the user then edits.
  const createFormulaFromTrace = (plotId: string, sourceTraceId: string) => {
    const plot = plots.find((p) => p.id === plotId);
    const source = plot?.traces.find((t) => t.id === sourceTraceId);
    if (!plot || !source) return;
    const id = makeId('formula');
    const newFormula: PVTrace = {
      id,
      kind: 'formula',
      pvName: '',
      displayName: `f(${source.pvName || source.displayName || 'curve'})`,
      color: colorForIndex(getPalette(paletteId), plot.traces.length),
      visible: true,
      axisId: source.axisId,
      useLive: false,
      updateRate: 'monitor',
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
      prev.map((p) => (p.id === plotId ? { ...p, traces: [...p.traces, newFormula] } : p))
    );
    selectItem({ type: 'trace', id, plotId });
  };

  const deleteTrace = (plotId: string, traceId: string) => {
    setPlots((prev) =>
      prev.map((p) =>
        p.id === plotId ? { ...p, traces: p.traces.filter((t) => t.id !== traceId) } : p
      )
    );
    if (selectedItem?.id === traceId && selectedItem.plotId === plotId) setSelectedItem(null);
  };

  const updateTrace = (traceId: string, updates: Partial<PVTrace>) => {
    setPlots((prev) =>
      prev.map((p) =>
        p.id === activePlotId
          ? {
              ...p,
              traces: p.traces.map((t) => (t.id === traceId ? { ...t, ...updates } : t)),
            }
          : p
      )
    );
  };

  const applyPalette = (palId: string, scope: { plotId: string; axisId?: string }) => {
    const palette = getPalette(palId);
    setPlots((prev) =>
      prev.map((p) => {
        if (p.id !== scope.plotId) return p;
        let i = 0;
        return {
          ...p,
          traces: p.traces.map((t) => {
            if (scope.axisId && t.axisId !== scope.axisId) return t;
            return { ...t, color: colorForIndex(palette, i++) };
          }),
        };
      })
    );
  };

  // Workspace replacement invalidates every in-flight units lookup: trace and axis
  // ids collide across workspaces, so a late answer would retarget an incoming trace.
  const abortUnitLookups = useCallback(() => {
    for (const c of unitFetchAbortRef.current.values()) c.abort();
    unitFetchAbortRef.current.clear();
  }, []);
  // Unmounting abandons them too.
  useEffect(() => abortUnitLookups, [abortUnitLookups]);

  // When a PV is chosen for a trace, look up its engineering units and move the
  // trace to the axis representing those units, creating one if none exists.
  // This is a best-effort default the user can override with the axis dropdown
  // or drag-and-drop; failures (no units, fetch error) leave the trace put.
  const assignTraceToUnitAxis = async (plotId: string, traceId: string, pvName: string) => {
    const plot = plots.find((p) => p.id === plotId);
    const trace = plot?.traces.find((t) => t.id === traceId);
    if (!plot || !trace) return;

    // Abort any in-flight lookup for this trace so a rapid re-selection can't
    // have a stale response land after the newer one.
    const abortMap = unitFetchAbortRef.current;
    abortMap.get(traceId)?.abort();
    const controller = new AbortController();
    abortMap.set(traceId, controller);

    // Remember where the trace sat when the fetch began. If the user moves it
    // (drag or axis dropdown) before we resolve, we must not clobber that.
    const axisIdAtFetch = trace.axisId;

    let unit: string | undefined;
    try {
      const meta = await fetchMetadata(
        canopy,
        pvName,
        trace.archiver ?? plot.archiver,
        controller.signal
      );
      unit = meta.units?.trim() || undefined;
    } catch {
      return; // metadata unavailable / aborted — keep the trace on its current axis
    } finally {
      // Only clear the slot if it's still ours; a newer call may have replaced it.
      if (abortMap.get(traceId) === controller) abortMap.delete(traceId);
    }
    if (controller.signal.aborted || !unit) return;

    const unitLower = unit.toLowerCase();
    setPlots((prev) =>
      prev.map((p) => {
        if (p.id !== plotId) return p;
        // The user moved the trace to a different axis (or gave it another PV)
        // while we were fetching; respect that and skip the auto-assign entirely.
        const current = p.traces.find((t) => t.id === traceId);
        if (!current || current.axisId !== axisIdAtFetch || current.pvName !== pvName) return p;
        const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();
        // Match an axis by recorded units, or by name as a fallback for axes
        // that predate unit tracking. The name fallback matches the unit only
        // when it appears parenthesized (e.g. "Vacuum (kV)") so a short unit
        // like "V" doesn't loosely match an unrelated "kV" axis.
        const match = p.axes.find(
          (a) => norm(a.units) === unitLower || norm(a.name).includes(`(${unitLower})`)
        );
        if (match) {
          // Stamp units on the matched axis if it didn't have them yet.
          const axes = match.units
            ? p.axes
            : p.axes.map((a) => (a.id === match.id ? { ...a, units: unit } : a));
          return {
            ...p,
            axes,
            traces: p.traces.map((t) => (t.id === traceId ? { ...t, axisId: match.id } : t)),
          };
        }
        // No match: create a new axis labeled with the unit, alternating sides.
        const newAxisId = makeId('axis');
        const newAxis: Axis = {
          id: newAxisId,
          name: unit,
          units: unit,
          orientation: p.axes.length % 2 === 0 ? 'left' : 'right',
          autoScale: true,
          logScale: false,
          visible: true,
        };
        return {
          ...p,
          axes: [...p.axes, newAxis],
          traces: p.traces.map((t) => (t.id === traceId ? { ...t, axisId: newAxisId } : t)),
        };
      })
    );
  };

  const moveTrace = (
    sourcePlotId: string,
    traceId: string,
    targetPlotId: string,
    targetAxisId: string
  ) => {
    setPlots((prev) => {
      const trace = prev.find((p) => p.id === sourcePlotId)?.traces.find((t) => t.id === traceId);
      if (!trace) return prev;
      const moved: PVTrace = { ...trace, axisId: targetAxisId };
      return prev.map((p) => {
        if (sourcePlotId === targetPlotId && p.id === sourcePlotId) {
          // Same plot, different axis — just retarget in place.
          return { ...p, traces: p.traces.map((t) => (t.id === traceId ? moved : t)) };
        }
        if (p.id === sourcePlotId) {
          return { ...p, traces: p.traces.filter((t) => t.id !== traceId) };
        }
        if (p.id === targetPlotId) {
          return { ...p, traces: [...p.traces, moved] };
        }
        return p;
      });
    });
    // Follow the trace if it was the selected item so the properties panel
    // keeps editing it after a cross-plot move.
    if (selectedItem?.type === 'trace' && selectedItem.id === traceId) {
      selectItem({ type: 'trace', id: traceId, plotId: targetPlotId });
    }
  };

  // ── Axis operations ──────────────────────────────────────────────────────────

  const addAxis = (plotId: string) => {
    const id = makeId('axis');
    const axisNum = (plots.find((p) => p.id === plotId)?.axes.length ?? 0) + 1;
    const newAxis: Axis = {
      id,
      name: `Y-Axis ${axisNum}`,
      orientation: axisNum % 2 === 0 ? 'right' : 'left',
      autoScale: true,
      logScale: false,
      visible: true,
    };
    setPlots((prev) =>
      prev.map((p) => (p.id === plotId ? { ...p, axes: [...p.axes, newAxis] } : p))
    );
    selectItem({ type: 'axis', id, plotId });
  };

  const deleteAxis = (plotId: string, axisId: string) => {
    const plot = plots.find((p) => p.id === plotId);
    if (!plot || plot.axes.length === 1) return;
    const fallbackAxisId = plot.axes.find((a) => a.id !== axisId)!.id;
    setPlots((prev) =>
      prev.map((p) =>
        p.id === plotId
          ? {
              ...p,
              axes: p.axes.filter((a) => a.id !== axisId),
              traces: p.traces.map((t) =>
                t.axisId === axisId ? { ...t, axisId: fallbackAxisId } : t
              ),
            }
          : p
      )
    );
    if (selectedItem?.id === axisId && selectedItem.plotId === plotId) setSelectedItem(null);
  };

  const updateAxis = (axisId: string, updates: Partial<Axis>) => {
    updateAxisInPlot(activePlotId, axisId, updates);
  };

  // Plot-scoped axis update: direct axis pan/zoom in PlotArea targets a specific
  // plot (grid cells and popouts aren't necessarily the active plot), so route
  // by the plot id rather than assuming activePlotId.
  const updateAxisInPlot = (plotId: string, axisId: string, updates: Partial<Axis>) => {
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

  const liveCount = activePlot.traces.filter((t) => t.useLive).length;
  const archiveCount = activePlot.traces.filter((t) => t.useArchive).length;

  // ── Toolbar handlers ────────────────────────────────────────────────────────

  const handleSave = () => {
    const json = serializeWorkspace({ theme: colorMode, plots });
    // Same local-time YYYYMMDD_HHMMSS stamp as the PNG export.
    downloadBlob(`trace-${timestamp()}.trc.json`, 'application/json', json);
  };

  // Apply a deserialized workspace to app state. Shared by file import, the
  // ?config= startup loader, and the config-store modal's Load so there's one
  // code path for "set plots + active plot + theme".
  const applyWorkspace = useCallback(
    (result: DeserializeResult) => {
      // A workspace with no plots would leave `activePlot` undefined, which the
      // render body dereferences — refuse it rather than blank the app. Reachable
      // from a hand-edited ?config= link, not just from a picked file.
      if (result.plots.length === 0) {
        throw new Error('Workspace contains no plots');
      }
      abortUnitLookups();
      setPlots(result.plots);
      setWorkspaceGeneration((generation) => generation + 1);
      setActivePlotId(result.plots[0].id);
      resyncClock(result.plots.map((p) => p.id));
      if (result.theme) setColorMode(result.theme);
      // Everything below is keyed by plot id, and ids collide across workspaces
      // (the default plot is `plot-1`, native saves keep ids verbatim, and the
      // legacy .trc converter hardcodes `plot-1`). Carrying it over would let the
      // outgoing workspace's viewport, detach state, or selection attach itself to
      // the incoming plots, so reset it all as part of "apply a workspace".
      setViewWindowByPlot(new Map());
      setDetachedPlotIds([]);
      setPoppedOutPlot(null);
      setSelectedItem(null);
      setInsight((prev) => ({ ...prev, pv: undefined }));
      axisRangesRef.current.clear();
    },
    [abortUnitLookups, resyncClock]
  );

  // Shareable-link bootstrap: ?config=<slug> loads a saved workspace from the
  // magpie config store on startup, then strips the param so a refresh doesn't
  // refetch (and a later save/edit isn't overwritten by the stale link).
  useEffect(() => {
    const slug = new URLSearchParams(window.location.search).get('config');
    if (!slug) return;
    let cancelled = false;
    const abort = new AbortController();
    (async () => {
      try {
        const dto = await getConfig(slug, abort.signal);
        if (cancelled) return;
        const result = deserializeConfigData(dto.data);
        applyWorkspace(result);
        showToast({
          kind: 'success',
          title: 'Workspace loaded',
          subtitle: [
            dto.name ? `Loaded "${dto.name}"` : `Loaded config ${slug}`,
            ...result.warnings,
          ].join('\n'),
          timeout: result.warnings.length > 0 ? 0 : undefined,
        });
      } catch (err) {
        if (cancelled) return;
        const subtitle =
          err instanceof CanopyError
            ? err.detail
            : ((err as Error | null)?.message ?? 'Unknown error');
        showToast({ kind: 'error', title: 'Could not load shared workspace', subtitle });
      } finally {
        // Don't rewrite the URL after unmount — it may belong to a later route.
        if (!cancelled) {
          const url = new URL(window.location.href);
          url.searchParams.delete('config');
          window.history.replaceState({}, '', url);
        }
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
    };
    // Mount-only: read the launch URL once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      applyWorkspace(result);
    } catch (err) {
      alert(`Failed to import: ${(err as Error).message}`);
      return;
    }
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

  // Export plots as PNG (one file each, mirroring the CSV export). Reuses the
  // same DOM-based capturePlotPng as print, so it captures exactly what's on
  // screen: the fullscreen copy if a plot is popped out, the active plot in tab
  // view, or every plot in grid view. Detached plots live in another window, so
  // capture returns null and they're skipped. Filenames share one timestamp so
  // a grid export reads as a single batch.
  const handleExportImage = () => {
    const targets = poppedOutPlot
      ? plots.filter((p) => p.id === poppedOutPlot)
      : viewMode === 'tabs'
        ? [activePlot]
        : plots;
    const stamp = timestamp();
    const shots = targets.flatMap((p) => {
      const dataUrl = capturePlotPng(p, colorMode, p.id === poppedOutPlot);
      return dataUrl ? [{ title: p.title, dataUrl }] : [];
    });
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

  const handlePrint = () => {
    // Print what's on screen: the fullscreen plot if one is popped out, the
    // active plot in tab view, or every plot in grid view. Detached plots
    // render in other windows, so capture returns null for them.
    const targets = poppedOutPlot
      ? plots.filter((p) => p.id === poppedOutPlot)
      : viewMode === 'tabs'
        ? [activePlot]
        : plots;
    const shots = targets.flatMap((p) => {
      // When a plot is fullscreen, capture that copy rather than the in-window
      // one hidden behind it (both share a data-plot-id).
      const dataUrl = capturePlotPng(p, colorMode, p.id === poppedOutPlot);
      return dataUrl ? [{ plotId: p.id, title: p.title, dataUrl }] : [];
    });
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

  const handleReportBug = () => {
    window.open(BUG_REPORT_URL, '_blank', 'noopener,noreferrer');
  };

  // Capture context-aware plots (active plot in tabs view, all plots in grid)
  // and open the e-log post dialog. Background matches the current chart theme.
  const openElogPost = useCallback(() => {
    if (!elogConfig?.enabled) return;
    const targetPlots = viewMode === 'grid' ? plots : [activePlot];
    const bg = colorMode === 'dark' ? '#161616' : '#ffffff';
    const captured = capturePlots(
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

  const handleOpenDocs = () => {
    window.open(DOCS_URL, '_blank', 'noopener,noreferrer');
  };

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
  // Each plot's current view window (pan/zoom) or its range at the plot's anchor.
  const windowByPlotId = fetchWindowByPlot;
  // Keep the selected PV valid for the inspectable set; fall back to its first PV.
  const insightTraces = insightPlots.flatMap((p) => p.traces);
  const insightPv =
    (insight.pv && insightTraces.some((t) => t.id === insight.pv)
      ? insight.pv
      : insightTraces.find((t) => t.pvName)?.id) ?? '';

  // Keyboard shortcuts map to the same handlers as the toolbar buttons below.
  // Post-to-E-Log is only wired when e-log is configured, matching the button.
  useKeyboardShortcuts({
    onSave: handleSave,
    onPrint: handlePrint,
    onOpen: () => void handleImport(),
    onExportImage: handleExportImage,
    onPostElog: elogConfig?.enabled ? openElogPost : undefined,
    onDataInsight: () => openInsight(),
    onToggleTheme: toggleTheme,
  });

  return (
    <div className="trace-app">
      {/* Header — wrapped in g100 so it stays a dark brand bar in light mode. */}
      <Theme theme="g100">
        <Header aria-label="Trace" className="trace-header">
          <HeaderName href="#" prefix="" className="trace-header__name">
            TRACE
          </HeaderName>
          <div className="trace-header__archiver">
            <span className="trace-header__counts">
              {liveCount} Live &bull; {archiveCount} Archive
            </span>
          </div>
          <HeaderGlobalBar>
            <Toolbar
              colorMode={colorMode}
              onSave={handleSave}
              onPrint={handlePrint}
              onImport={() => void handleImport()}
              onExport={handleExport}
              onExportImage={handleExportImage}
              onToggleTheme={toggleTheme}
              onReportBug={handleReportBug}
              onOpenDocs={handleOpenDocs}
              onOpenDataInsight={() => openInsight()}
              onRefreshArchive={handleRefreshArchive}
              onOpenConfigStore={() => setConfigModalOpen(true)}
              onPostElog={elogConfig?.enabled ? openElogPost : undefined}
            />
          </HeaderGlobalBar>
        </Header>
      </Theme>

      {/* 3-panel layout */}
      <div className="trace-panel-group">
        <PanelGroup orientation="horizontal" style={{ flex: 1, height: '100%' }}>
          <Panel
            defaultSize="20%"
            minSize="15%"
            maxSize="35%"
            collapsible
            collapsedSize="3%"
            panelRef={leftPanelRef}
            onResize={(size) => {
              const next = leftPanelRef.current?.isCollapsed() ?? size.asPercentage <= 5;
              if (next !== leftCollapsed) setLeftCollapsed(next);
            }}
          >
            <LeftPanel
              plots={plots}
              activePlotId={activePlotId}
              viewMode={viewMode}
              archiveResultsByPlot={archiveResultsByPlot}
              collapsed={leftCollapsed}
              selectedItem={selectedItem}
              onSelectItem={selectItem}
              onAddTrace={addTrace}
              onAddFormula={addFormula}
              onDeleteTrace={deleteTrace}
              onAddAxis={addAxis}
              onDeleteAxis={deleteAxis}
              onMoveTrace={moveTrace}
              onCollapse={() => {
                leftPanelRef.current?.collapse();
                setLeftCollapsed(true);
              }}
              onExpand={() => {
                leftPanelRef.current?.expand();
                setLeftCollapsed(false);
              }}
            />
          </Panel>

          <PanelResizeHandle className="trace-resize-handle" />

          <Panel defaultSize="60%" minSize="30%">
            <div className="plot-and-insight">
              <div className="plot-and-insight__plot">
                <PlotArea
                  key={workspaceGeneration}
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
                  onFollowStop={handleFollowStop}
                  viewWindowByPlot={viewWindowByPlot}
                  axisEndFor={axisEndFor}
                  onAxisRangesChange={handleAxisRangesChange}
                  onUpdateAxis={updateAxisInPlot}
                  onChartInstance={handleChartInstance}
                />
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
                  <DataInsightTool
                    plots={insightPlots}
                    windowByPlotId={windowByPlotId}
                    selectedPv={insightPv}
                    onSelectPv={(id) => setInsight((p) => ({ ...p, pv: id }))}
                    onClose={() => setInsight((p) => ({ ...p, open: false }))}
                    onMinimize={() => setInsight((p) => ({ ...p, minimized: true }))}
                    onDetach={() => setInsight((p) => ({ ...p, detached: true }))}
                  />
                </div>
              )}
            </div>
          </Panel>

          <PanelResizeHandle className="trace-resize-handle" />

          <Panel
            defaultSize="20%"
            minSize="15%"
            maxSize="35%"
            collapsible
            collapsedSize="3%"
            panelRef={rightPanelRef}
            onResize={(size) => {
              const next = rightPanelRef.current?.isCollapsed() ?? size.asPercentage <= 5;
              if (next !== rightCollapsed) setRightCollapsed(next);
            }}
          >
            <RightPanel
              selectedItem={selectedItem}
              activePlot={activePlot}
              nowMs={clock.nowFor(activePlot.id)}
              archiveResults={archiveResultsByPlot.get(activePlot.id) ?? new Map()}
              liveResults={liveResultsByPlot.get(activePlot.id) ?? new Map()}
              collapsed={rightCollapsed}
              onUpdateTrace={updateTrace}
              onSelectPv={(traceId, pvName) => assignTraceToUnitAxis(activePlotId, traceId, pvName)}
              onUpdateAxis={updateAxis}
              onUpdatePlot={(updates) => updatePlot(activePlotId, updates)}
              onApplyPalette={applyPalette}
              getAxisRange={getAxisRange}
              onInspectTrace={(id) => openInsight(id)}
              onCreateFormula={(sourceId) => createFormulaFromTrace(activePlotId, sourceId)}
              onCollapse={() => {
                rightPanelRef.current?.collapse();
                setRightCollapsed(true);
              }}
              onExpand={() => {
                rightPanelRef.current?.expand();
                setRightCollapsed(false);
              }}
            />
          </Panel>
        </PanelGroup>
      </div>

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
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <SinglePlot
                    plot={plot}
                    endMs={axisEndFor(plot.id)}
                    following={isFollowing(plot, viewWindowByPlot)}
                    onFollowStop={() => handleFollowStop(plot.id)}
                    fullscreen
                    archiveResults={archiveResultsByPlot.get(plot.id) ?? new Map()}
                    liveResults={liveResultsByPlot.get(plot.id) ?? new Map()}
                    formulaResults={formulaResultsByPlot.get(plot.id) ?? new Map()}
                    // eslint-disable-next-line react-hooks/refs -- ref is written from ECharts' finished event, not during render
                    onAxisRangesChange={(r) => handleAxisRangesChange(plot.id, r)}
                    onUpdateAxis={(id, u) => updateAxisInPlot(plot.id, id, u)}
                    // eslint-disable-next-line react-hooks/refs -- ref is written on mount/unmount, not during render
                    onChartInstance={(inst, active) => handleChartInstance(plot.id, inst, active)}
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
            <Theme
              theme={colorMode === 'dark' ? 'g90' : 'g10'}
              style={{
                height: '100vh',
                background: 'var(--cds-background)',
                color: 'var(--cds-text-primary)',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
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
              <div style={{ flex: 1, minHeight: 0 }}>
                <SinglePlot
                  plot={plot}
                  endMs={axisEndFor(plot.id)}
                  following={isFollowing(plot, viewWindowByPlot)}
                  onFollowStop={() => handleFollowStop(plot.id)}
                  archiveResults={archiveResultsByPlot.get(plot.id) ?? new Map()}
                  liveResults={liveResultsByPlot.get(plot.id) ?? new Map()}
                  formulaResults={formulaResultsByPlot.get(plot.id) ?? new Map()}
                  onViewWindowChange={(w) => handleViewWindowChange(plot.id, w)}
                  initialViewWindowNs={viewWindowByPlot.get(plot.id)}
                  onAxisRangesChange={(r) => handleAxisRangesChange(plot.id, r)}
                  onUpdateAxis={(id, u) => updateAxisInPlot(plot.id, id, u)}
                  onChartInstance={(inst, active) => handleChartInstance(plot.id, inst, active)}
                />
              </div>
            </Theme>
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
          <Theme
            theme={colorMode === 'dark' ? 'g90' : 'g10'}
            style={{
              height: '100vh',
              background: 'var(--cds-background)',
              color: 'var(--cds-text-primary)',
            }}
          >
            <DataInsightTool
              plots={insightPlots}
              windowByPlotId={windowByPlotId}
              selectedPv={insightPv}
              detached
              onSelectPv={(id) => setInsight((p) => ({ ...p, pv: id }))}
              onClose={() => setInsight((p) => ({ ...p, open: false, detached: false }))}
              onReattach={() => setInsight((p) => ({ ...p, detached: false }))}
            />
          </Theme>
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
          logbooks={elogConfig.logbooks}
          defaultLogbooks={elogConfig.defaultLogbooks}
          buildConfigFile={buildElogConfigFile}
          onClose={() => setElogModal((p) => ({ ...p, open: false }))}
          onPosted={(entryId) =>
            showToast({
              kind: 'success',
              title: 'Posted to E-Log',
              subtitle: `Entry ${entryId} created`,
            })
          }
          onPostFailed={(message) =>
            showToast({ kind: 'error', title: 'E-Log post failed', subtitle: message })
          }
        />
      )}

      {configModalOpen && (
        <ConfigStoreModal
          open={configModalOpen}
          plots={plots}
          theme={colorMode}
          onClose={() => setConfigModalOpen(false)}
          onLoaded={applyWorkspace}
          onToast={showToast}
        />
      )}

      {toast &&
        createPortal(
          <div
            style={{ position: 'fixed', top: 56, right: 16, zIndex: 9999 }}
            role="status"
            aria-live="polite"
          >
            <ToastNotification
              key={toast.seq}
              kind={toast.kind}
              title={toast.title}
              subtitle={toast.subtitle}
              timeout={toast.timeout ?? (toast.kind === 'success' ? 5000 : 0)}
              onClose={() => {
                setToast(null);
                return true;
              }}
            />
          </div>,
          document.body
        )}
    </div>
  );
}
