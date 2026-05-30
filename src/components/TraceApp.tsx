import { useState } from 'react';
import {
  Panel,
  Group as PanelGroup,
  Separator as PanelResizeHandle,
  usePanelRef,
} from 'react-resizable-panels';
import { Close, Login } from '@carbon/icons-react';
import { Header, HeaderName, HeaderGlobalBar, Theme } from '@carbon/react';
import type { Plot, PVTrace, Axis } from '../types';
import { LeftPanel } from './LeftPanel';
import { DetachedWindow } from './DetachedWindow';
import { PlotArea, SinglePlot } from './PlotArea';
import { RightPanel } from './RightPanel';
import { Toolbar } from './Toolbar';
import { useArchiveSeries, type ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import { ArchiverPicker } from './ArchiverPicker';
import type { TimeWindowNs } from '../api/time';
import { rangeToWindowNs } from '../api/time';
import { useColorMode } from '../state/themeStore';
import { downloadBlob, pickFile } from '../io/download';
import { serializeWorkspace, deserializeWorkspace } from '../io/serialize';
import { buildCsvFiles } from '../io/exportCsv';

const BUG_REPORT_URL = 'https://github.com/slaclab/react-trace/issues/new';
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

export type SelectedItem = { type: 'trace' | 'axis' | 'plot'; id: string } | null;

export function TraceApp() {
  const [plots, setPlots] = useState<Plot[]>(INITIAL_PLOTS);
  const [activePlotId, setActivePlotId] = useState<string>('plot-1');
  const [selectedItem, setSelectedItem] = useState<SelectedItem>({ type: 'trace', id: 'trace-1' });
  const [viewMode, setViewMode] = useState<'tabs' | 'grid'>('tabs');
  const [poppedOutPlot, setPoppedOutPlot] = useState<string | null>(null);
  // Plots detached into their own browser windows. Their charts render there
  // via a portal; the main window shows a reattach placeholder in their place.
  const [detachedPlotIds, setDetachedPlotIds] = useState<string[]>([]);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [globalArchiver, setGlobalArchiver] = useState<string | undefined>(undefined);
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
  for (const plot of plots) {
    const win = viewWindowByPlot.get(plot.id) ?? rangeToWindowNs(plot.xAxis.timeRange);
    for (const trace of plot.traces) {
      if (trace.useArchive) windowByTrace.set(trace.id, win);
    }
  }

  const archiveResults = useArchiveSeries(allTraces, globalArchiver, windowByTrace);

  const handleViewWindowChange = (plotId: string, window: TimeWindowNs) => {
    setViewWindowByPlot((prev) => {
      const next = new Map(prev);
      next.set(plotId, window);
      return next;
    });
  };

  const archiveResultsByPlot = new Map<string, Map<string, ArchiveSeriesResult>>();
  for (const plot of plots) {
    const m = new Map<string, ArchiveSeriesResult>();
    for (const trace of plot.traces) {
      const r = archiveResults.get(trace.id);
      if (r) m.set(trace.id, r);
    }
    archiveResultsByPlot.set(plot.id, m);
  }

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

  const addTrace = (axisId: string) => {
    const id = `trace-${Date.now()}`;
    const colors = ['#0f62fe', '#ee5396', '#42be65', '#ff832b', '#a56eff', '#08bdba'];
    const traceCount = activePlot.traces.length;
    const newTrace: PVTrace = {
      id,
      pvName: '',
      displayName: 'New Trace',
      color: colors[traceCount % colors.length],
      visible: true,
      axisId,
      useLive: false,
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
      prev.map((p) => (p.id === activePlotId ? { ...p, traces: [...p.traces, newTrace] } : p))
    );
    setSelectedItem({ type: 'trace', id });
  };

  const deleteTrace = (traceId: string) => {
    setPlots((prev) =>
      prev.map((p) =>
        p.id === activePlotId ? { ...p, traces: p.traces.filter((t) => t.id !== traceId) } : p
      )
    );
    if (selectedItem?.id === traceId) setSelectedItem(null);
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

  const moveTrace = (traceId: string, targetAxisId: string) => {
    updateTrace(traceId, { axisId: targetAxisId });
  };

  // ── Axis operations ──────────────────────────────────────────────────────────

  const addAxis = () => {
    const id = `axis-${Date.now()}`;
    const axisNum = activePlot.axes.length + 1;
    const newAxis: Axis = {
      id,
      name: `Y-Axis ${axisNum}`,
      orientation: axisNum % 2 === 0 ? 'right' : 'left',
      autoScale: true,
      logScale: false,
      visible: true,
    };
    setPlots((prev) =>
      prev.map((p) => (p.id === activePlotId ? { ...p, axes: [...p.axes, newAxis] } : p))
    );
    setSelectedItem({ type: 'axis', id });
  };

  const deleteAxis = (axisId: string) => {
    if (activePlot.axes.length === 1) return;
    const fallbackAxisId = activePlot.axes.find((a) => a.id !== axisId)!.id;
    setPlots((prev) =>
      prev.map((p) =>
        p.id === activePlotId
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
    if (selectedItem?.id === axisId) setSelectedItem(null);
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
    const json = serializeWorkspace({ theme: colorMode, globalArchiver, plots });
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
    if (result.globalArchiver !== undefined) setGlobalArchiver(result.globalArchiver);
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

  return (
    <div className="trace-app">
      {/* Header — wrapped in g100 so it stays a dark brand bar in light mode. */}
      <Theme theme="g100">
        <Header aria-label="Trace" className="trace-header">
          <HeaderName href="#" prefix="" className="trace-header__name">
            TRACE
          </HeaderName>
          <div className="trace-header__archiver">
            <ArchiverPicker
              value={globalArchiver}
              onChange={setGlobalArchiver}
              label=""
              width={180}
            />
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
              traces={activePlot.traces}
              axes={activePlot.axes}
              archiveResults={archiveResultsByPlot.get(activePlot.id) ?? new Map()}
              collapsed={leftCollapsed}
              selectedItem={selectedItem}
              onSelectItem={setSelectedItem}
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
            <PlotArea
              plots={plots}
              activePlotId={activePlotId}
              viewMode={viewMode}
              archiveResultsByPlot={archiveResultsByPlot}
              onSetActivePlot={setActivePlotId}
              onAddPlot={addPlot}
              onRemovePlot={removePlot}
              onSetViewMode={setViewMode}
              onPopOutPlot={setPoppedOutPlot}
              detachedPlotIds={detachedPlotIds}
              onDetachPlot={detachPlot}
              onReattachPlot={reattachPlot}
              onViewWindowChange={handleViewWindowChange}
            />
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
              globalArchiver={globalArchiver}
              collapsed={rightCollapsed}
              onUpdateTrace={updateTrace}
              onUpdateAxis={updateAxis}
              onUpdatePlot={(updates) => updatePlot(activePlotId, updates)}
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
                  onViewWindowChange={(w) => handleViewWindowChange(plot.id, w)}
                />
              </div>
            </Theme>
          </DetachedWindow>
        );
      })}
    </div>
  );
}
