import { useState } from 'react';
import {
  Panel,
  Group as PanelGroup,
  Separator as PanelResizeHandle,
  usePanelRef,
} from 'react-resizable-panels';
import { ChartLine, Close, Layers, Settings } from '@carbon/icons-react';
import type { Plot, PVTrace, Axis } from '../types';
import { LeftPanel } from './LeftPanel';
import { PlotArea, SinglePlot } from './PlotArea';
import { RightPanel } from './RightPanel';
import { useArchiveSeries, type ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import { ArchiverPicker } from './ArchiverPicker';

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
        pvName: 'TEST:SINE_A',
        displayName: 'TEST:SINE_A',
        color: '#0f62fe',
        visible: true,
        axisId: 'y-axis-1',
        useLive: true,
        updateRate: 'monitor',
        useArchive: false,
        archiveTimeRange: '-1h',
        lineWidth: 2,
        lineStyle: 'solid',
        data: generateMockData(100, 45, 5),
      },
      {
        id: 'trace-2',
        pvName: 'TEST:SINE_B',
        displayName: 'TEST:SINE_B',
        color: '#ee5396',
        visible: true,
        axisId: 'y-axis-1',
        useLive: false,
        updateRate: 'monitor',
        useArchive: true,
        archiveTimeRange: '-1h',
        lineWidth: 2,
        lineStyle: 'solid',
        data: generateMockData(100, 48, 3),
      },
      {
        id: 'trace-3',
        pvName: 'TEST:TEMP',
        displayName: 'TEST:TEMP',
        color: '#42be65',
        visible: true,
        axisId: 'y-axis-2',
        useLive: true,
        updateRate: 'monitor',
        useArchive: true,
        archiveTimeRange: '-1h',
        lineWidth: 2,
        lineStyle: 'solid',
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
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [globalArchiver, setGlobalArchiver] = useState<string | undefined>(undefined);
  const leftPanelRef = usePanelRef();
  const rightPanelRef = usePanelRef();

  const activePlot = plots.find((p) => p.id === activePlotId) ?? plots[0];

  const allTraces = plots.flatMap((p) => p.traces);
  const archiveResults = useArchiveSeries(allTraces, globalArchiver);

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
    if (activePlotId === plotId) {
      const remaining = plots.filter((p) => p.id !== plotId);
      setActivePlotId(remaining[0].id);
    }
  };

  const updatePlot = (plotId: string, updates: Partial<Plot>) => {
    setPlots((prev) => prev.map((p) => (p.id === plotId ? { ...p, ...updates } : p)));
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
      archiveTimeRange: '-1h',
      lineWidth: 2,
      lineStyle: 'solid',
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

  return (
    <div className="trace-app">
      {/* Header */}
      <header
        style={{
          height: 48,
          backgroundColor: '#262626',
          borderBottom: '1px solid #393939',
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          gap: 12,
          flexShrink: 0,
        }}
      >
        {leftCollapsed && (
          <button
            className="panel-expand-btn"
            title="Expand Layers panel"
            onClick={() => {
              leftPanelRef.current?.expand();
              setLeftCollapsed(false);
            }}
          >
            <Layers size={16} />
          </button>
        )}
        <ChartLine size={20} />
        <span style={{ fontSize: 14, fontWeight: 500 }}>EPICS Trace</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <ArchiverPicker
            value={globalArchiver}
            onChange={setGlobalArchiver}
            label=""
            width={180}
          />
          <span style={{ fontSize: 12, color: '#6f6f6f' }}>
            {liveCount} Live &bull; {archiveCount} Archive
          </span>
        </div>
        {rightCollapsed && (
          <button
            className="panel-expand-btn"
            title="Expand Properties panel"
            onClick={() => {
              rightPanelRef.current?.expand();
              setRightCollapsed(false);
            }}
          >
            <Settings size={16} />
          </button>
        )}
      </header>

      {/* 3-panel layout */}
      <div className="trace-panel-group">
        <PanelGroup orientation="horizontal" style={{ flex: 1, height: '100%' }}>
          <Panel
            defaultSize="20%"
            minSize="15%"
            maxSize="35%"
            collapsible
            collapsedSize="0%"
            panelRef={leftPanelRef}
          >
            <LeftPanel
              traces={activePlot.traces}
              axes={activePlot.axes}
              archiveResults={archiveResultsByPlot.get(activePlot.id) ?? new Map()}
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
            />
          </Panel>

          <PanelResizeHandle className="trace-resize-handle" />

          <Panel
            defaultSize="20%"
            minSize="15%"
            maxSize="35%"
            collapsible
            collapsedSize="0%"
            panelRef={rightPanelRef}
          >
            <RightPanel
              selectedItem={selectedItem}
              activePlot={activePlot}
              archiveResults={archiveResultsByPlot.get(activePlot.id) ?? new Map()}
              globalArchiver={globalArchiver}
              onUpdateTrace={updateTrace}
              onUpdateAxis={updateAxis}
              onUpdatePlot={(updates) => updatePlot(activePlotId, updates)}
              onCollapse={() => {
                rightPanelRef.current?.collapse();
                setRightCollapsed(true);
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
                  background: '#161616',
                  border: '1px solid #393939',
                  borderRadius: 8,
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div
                  style={{
                    height: 48,
                    background: '#262626',
                    borderBottom: '1px solid #393939',
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
                      color: '#c6c6c6',
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
    </div>
  );
}
