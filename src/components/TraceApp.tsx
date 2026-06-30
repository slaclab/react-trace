import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Panel,
  Group as PanelGroup,
  Separator as PanelResizeHandle,
  usePanelRef,
} from 'react-resizable-panels';
import { Close, Login, ChevronUp } from '@carbon/icons-react';
import { Header, HeaderName, HeaderGlobalBar, Theme } from '@carbon/react';
import type { Plot, PVTrace, Axis } from '../types';
import { LeftPanel } from './LeftPanel';
import { DetachedWindow } from './DetachedWindow';
import { DataInsightTool } from './DataInsightTool';
import { PlotArea, SinglePlot } from './PlotArea';
import { RightPanel } from './RightPanel';
import { Toolbar } from './Toolbar';
import { useArchiveSeries, type ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import { useLiveSeries, type LiveSeriesResult } from '../hooks/useLiveSeries';
import type { TimeWindowNs } from '../api/time';
import { rangeToWindowNs } from '../api/time';
import { useColorMode } from '../state/themeStore';
import { downloadBlob, pickFile } from '../io/download';
import { serializeWorkspace, deserializeWorkspace } from '../io/serialize';
import { buildCsvFiles } from '../io/exportCsv';

const BUG_REPORT_URL = 'https://forms.office.com/r/qV7BmK2xi9';
const DOCS_URL = 'https://github.com/slaclab/react-trace#readme';

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

const INITIAL_PLOTS: Plot[] = [
  {
    id: 'plot-1',
    title: 'Plot 1',
    backgroundColor: '#161616',
    showGridlines: true,
    gridStyle: 'solid',
    xAxis: { timeRange: '-1h' },
    axes: [
      {
        id: 'y-axis-1',
        name: 'Vacuum (kV)',
        orientation: 'left',
        autoScale: true,
        logScale: false,
        visible: true,
      },
      {
        id: 'y-axis-2',
        name: 'Temperature (°C)',
        orientation: 'right',
        autoScale: true,
        logScale: false,
        visible: true,
      },
    ],
    traces: [
      {
        id: 'trace-1',
        pvName: 'TEST:SINE',
        displayName: 'TEST:SINE',
        color: '#0f62fe',
        visible: true,
        axisId: 'y-axis-1',
        useLive: false,
        updateRate: 'monitor',
        useArchive: true,
        lineWidth: 2,
        lineType: 'step',
        lineStyle: 'solid',
        showSymbol: false,
        symbolShape: 'circle',
        symbolSize: 10,
        data: generateMockData(100, 45, 5),
      },
      {
        id: 'trace-2',
        pvName: 'TEST:COUNTER',
        displayName: 'TEST:COUNTER',
        color: '#ee5396',
        visible: true,
        axisId: 'y-axis-1',
        useLive: false,
        updateRate: 'monitor',
        useArchive: true,
        lineWidth: 2,
        lineType: 'step',
        lineStyle: 'solid',
        showSymbol: false,
        symbolShape: 'circle',
        symbolSize: 10,
        data: generateMockData(100, 48, 3),
      },
      {
        id: 'trace-3',
        pvName: 'TEST:RAMP',
        displayName: 'TEST:RAMP',
        color: '#42be65',
        visible: true,
        axisId: 'y-axis-2',
        useLive: false,
        updateRate: 'monitor',
        useArchive: true,
        lineWidth: 2,
        lineType: 'step',
        lineStyle: 'solid',
        showSymbol: false,
        symbolShape: 'circle',
        symbolSize: 10,
        data: generateMockData(100, 25, 2),
      },
    ],
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
  const [plots, setPlots] = useState<Plot[]>(INITIAL_PLOTS);
  const [activePlotId, setActivePlotId] = useState<string>('plot-1');
  const [selectedItem, setSelectedItem] = useState<SelectedItem>({
    type: 'trace',
    id: 'trace-1',
    plotId: 'plot-1',
  });
  const [viewMode, setViewMode] = useState<'tabs' | 'grid'>('tabs');
  const [poppedOutPlot, setPoppedOutPlot] = useState<string | null>(null);
  // Plots detached into their own browser windows. Their charts render there
  // via a portal; the main window shows a reattach placeholder in their place.
  const [detachedPlotIds, setDetachedPlotIds] = useState<string[]>([]);
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
  // Last viewport emitted by each plot's dataZoom. Drives the archive store's
  // window per trace; the store decides whether the change requires a fetch
  // based on its coverage check, so this map can be updated freely.
  const [viewWindowByPlot, setViewWindowByPlot] = useState<Map<string, TimeWindowNs>>(
    () => new Map()
  );
  const leftPanelRef = usePanelRef();
  const rightPanelRef = usePanelRef();

  const activePlot = plots.find((p) => p.id === activePlotId) ?? plots[0];

  const allTraces = plots.flatMap((p) => p.traces);

  // Compute the visible window per trace from its plot. Pan/zoom of the chart
  // updates `viewWindowByPlot[plotId]`, which takes precedence; otherwise we
  // resolve the plot's relative time range (e.g. "-1h"). The time range is
  // plot-level — traces don't carry their own.
  const windowByTrace = new Map<string, TimeWindowNs>();
  // Each trace inherits its plot's default archiver unless it sets its own.
  const plotArchiverByTrace = new Map<string, string | undefined>();
  for (const plot of plots) {
    const win = viewWindowByPlot.get(plot.id) ?? rangeToWindowNs(plot.xAxis.timeRange);
    for (const trace of plot.traces) {
      if (trace.useArchive) windowByTrace.set(trace.id, win);
      plotArchiverByTrace.set(trace.id, plot.archiver);
    }
  }

  const archiveResults = useArchiveSeries(allTraces, plotArchiverByTrace, windowByTrace);
  // Live data subscriptions are owned at the app level so detached / popped-out
  // / grid views all share one WebSocket. The hook handles add/remove of
  // subscriptions when traces toggle their `useLive` flag.
  const liveResults = useLiveSeries(allTraces);

  const handleViewWindowChange = (plotId: string, window: TimeWindowNs) => {
    setViewWindowByPlot((prev) => {
      const next = new Map(prev);
      next.set(plotId, window);
      return next;
    });
  };

  // Split the flat result maps per plot. Memoized on (plots, archiveResults,
  // liveResults): live data drives frequent re-renders via useSyncExternalStore,
  // and rebuilding these maps every render would churn the props passed into
  // PlotArea / RightPanel. The hooks now return stable references when their
  // data is unchanged, so this memo holds across live frames that don't touch
  // the underlying series.
  const { archiveResultsByPlot, liveResultsByPlot } = useMemo(() => {
    const archive = new Map<string, Map<string, ArchiveSeriesResult>>();
    const live = new Map<string, Map<string, LiveSeriesResult>>();
    for (const plot of plots) {
      const a = new Map<string, ArchiveSeriesResult>();
      const l = new Map<string, LiveSeriesResult>();
      for (const trace of plot.traces) {
        const ar = archiveResults.get(trace.id);
        if (ar) a.set(trace.id, ar);
        const lr = liveResults.get(trace.id);
        if (lr) l.set(trace.id, lr);
      }
      archive.set(plot.id, a);
      live.set(plot.id, l);
    }
    return { archiveResultsByPlot: archive, liveResultsByPlot: live };
  }, [plots, archiveResults, liveResults]);

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

  // ── Plot operations ─────────────────────────────────────────────────────────

  const addPlot = () => {
    const id = `plot-${Date.now()}`;
    const plotNum = plots.length + 1;
    setPlots((prev) => [
      ...prev,
      {
        id,
        title: `Plot ${plotNum}`,
        backgroundColor: '#161616',
        showGridlines: true,
        gridStyle: 'solid',
        xAxis: { timeRange: '-1h' },
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
    setActivePlotId(id);
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

  const clearViewWindow = (plotId: string) => {
    setViewWindowByPlot((prev) => {
      if (!prev.has(plotId)) return prev;
      const next = new Map(prev);
      next.delete(plotId);
      return next;
    });
  };

  const updatePlot = (plotId: string, updates: Partial<Plot>) => {
    setPlots((prev) => prev.map((p) => (p.id === plotId ? { ...p, ...updates } : p)));
    // Picking a new x-axis time range is an explicit reset; drop the panned
    // viewport so the next render uses the relative range, not the stale one.
    // PlotArea also dispatches a dataZoom reset on the same trigger.
    if (updates.xAxis && 'timeRange' in updates.xAxis) clearViewWindow(plotId);
  };

  // ── Trace operations ─────────────────────────────────────────────────────────

  const addTrace = (plotId: string, axisId: string) => {
    const id = `trace-${Date.now()}`;
    const colors = ['#0f62fe', '#ee5396', '#42be65', '#ff832b', '#a56eff', '#08bdba'];
    const traceCount = plots.find((p) => p.id === plotId)?.traces.length ?? 0;
    const newTrace: PVTrace = {
      id,
      pvName: '',
      displayName: 'New Trace',
      color: colors[traceCount % colors.length],
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
    const id = `axis-${Date.now()}`;
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
    setPlots((prev) =>
      prev.map((p) =>
        p.id === activePlotId
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
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace(/T.*/, (m) => m.replace(/^T/, '_').slice(0, 7));
    downloadBlob(`trace-${stamp}.trc.json`, 'application/json', json);
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
    setPlots(result.plots);
    if (result.plots.length > 0) setActivePlotId(result.plots[0].id);
    if (result.theme) {
      // setColorMode lives on the store; the hook surface only exposes toggle,
      // so go through the module API.
      void import('../state/themeStore').then((m) => m.setColorMode(result.theme!));
    }
    if (result.warnings.length > 0) {
      console.warn('Import warnings:', result.warnings);
      alert(`Imported with ${result.warnings.length} warning(s):\n\n${result.warnings.join('\n')}`);
    }
  };

  const handleExport = () => {
    const files = buildCsvFiles(plots, archiveResultsByPlot);
    if (files.length === 0) {
      alert('No archive data to export. Toggle archive on a trace and wait for data to load.');
      return;
    }
    for (const f of files) {
      downloadBlob(f.filename, 'text/csv', f.csv);
    }
  };

  const handlePrint = () => {
    // TODO: render only the chart canvas. window.print() prints the full page
    // for now, which is enough to validate the wiring.
    window.print();
  };

  const handleReportBug = () => {
    window.open(BUG_REPORT_URL, '_blank', 'noopener,noreferrer');
  };

  const handleOpenDocs = () => {
    window.open(DOCS_URL, '_blank', 'noopener,noreferrer');
  };

  // ── Data Insight Tool ─────────────────────────────────────────────────────────

  const openInsight = (traceId?: string) => {
    const pv = traceId ?? activePlot.traces.find((t) => t.pvName)?.id;
    setInsight((prev) => ({ ...prev, open: true, minimized: false, pv: pv ?? prev.pv }));
  };

  // The DIT inspects every visible plot in grid view (so any plot's PVs are
  // reachable), or just the active plot in tab view.
  const insightPlots = viewMode === 'grid' ? plots : [activePlot];
  // Each plot's current view window (pan/zoom) or its resolved relative range.
  const windowByPlotId = new Map<string, TimeWindowNs>();
  for (const p of plots) {
    windowByPlotId.set(p.id, viewWindowByPlot.get(p.id) ?? rangeToWindowNs(p.xAxis.timeRange));
  }
  // Keep the selected PV valid for the inspectable set; fall back to its first PV.
  const insightTraces = insightPlots.flatMap((p) => p.traces);
  const insightPv =
    (insight.pv && insightTraces.some((t) => t.id === insight.pv)
      ? insight.pv
      : insightTraces.find((t) => t.pvName)?.id) ?? '';

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
              onToggleTheme={toggleTheme}
              onReportBug={handleReportBug}
              onOpenDocs={handleOpenDocs}
              onOpenDataInsight={() => openInsight()}
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
                  plots={plots}
                  activePlotId={activePlotId}
                  viewMode={viewMode}
                  archiveResultsByPlot={archiveResultsByPlot}
                  liveResultsByPlot={liveResultsByPlot}
                  onSetActivePlot={setActivePlotId}
                  onAddPlot={addPlot}
                  onRemovePlot={removePlot}
                  onSetViewMode={setViewMode}
                  onPopOutPlot={setPoppedOutPlot}
                  detachedPlotIds={detachedPlotIds}
                  onDetachPlot={detachPlot}
                  onReattachPlot={reattachPlot}
                  onViewWindowChange={handleViewWindowChange}
                  viewWindowByPlot={viewWindowByPlot}
                  onAxisRangesChange={handleAxisRangesChange}
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
              archiveResults={archiveResultsByPlot.get(activePlot.id) ?? new Map()}
              liveResults={liveResultsByPlot.get(activePlot.id) ?? new Map()}
              collapsed={rightCollapsed}
              onUpdateTrace={updateTrace}
              onUpdateAxis={updateAxis}
              onUpdatePlot={(updates) => updatePlot(activePlotId, updates)}
              getAxisRange={getAxisRange}
              onInspectTrace={(id) => openInsight(id)}
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
                    archiveResults={archiveResultsByPlot.get(plot.id) ?? new Map()}
                    liveResults={liveResultsByPlot.get(plot.id) ?? new Map()}
                    // eslint-disable-next-line react-hooks/refs -- ref is written from ECharts' finished event, not during render
                    onAxisRangesChange={(r) => handleAxisRangesChange(plot.id, r)}
                  />
                </div>
              </div>
            </div>
          );
        })()}

      {/* Detached plots — each renders into its own browser window via portal. */}
      {detachedPlotIds.map((id) => {
        const plot = plots.find((p) => p.id === id);
        if (!plot) return null;
        return (
          <DetachedWindow
            key={id}
            name={`trace-plot-${id}`}
            title={`${plot.title} — Trace`}
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
                  archiveResults={archiveResultsByPlot.get(plot.id) ?? new Map()}
                  liveResults={liveResultsByPlot.get(plot.id) ?? new Map()}
                  onViewWindowChange={(w) => handleViewWindowChange(plot.id, w)}
                  initialViewWindowNs={viewWindowByPlot.get(plot.id)}
                  onAxisRangesChange={(r) => handleAxisRangesChange(plot.id, r)}
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
    </div>
  );
}
