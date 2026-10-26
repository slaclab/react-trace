import { useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useSortable, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Add,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChartLine,
  ChartLineData,
  Layers,
  Radio,
  Archive,
  TrashCan,
  Function as FunctionIcon,
} from '@carbon/icons-react';
import { Button, Tag } from '@carbon/react';
import type { Plot, PVTrace, Axis } from '../types';
import { traceLabel } from '../traceLabel';
import type { SelectedItem } from './TraceApp';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import { PanelRail } from './PanelRail';

const EMPTY_RESULTS: Map<string, ArchiveSeriesResult> = new Map();

// dnd-kit ids must be unique across the single DndContext, so trace draggables
// and axis droppables are namespaced by plot. The `data` payload carries the
// resolved plot/axis/trace so the move handler doesn't have to re-parse ids.
interface DragData {
  plotId: string;
  axisId: string;
  traceId?: string;
}

interface LeftPanelProps {
  plots: Plot[];
  activePlotId: string;
  viewMode: 'tabs' | 'grid';
  archiveResultsByPlot: Map<string, Map<string, ArchiveSeriesResult>>;
  collapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  selectedItem: SelectedItem;
  onSelectItem: (item: SelectedItem) => void;
  onAddTrace: (plotId: string, axisId: string) => void;
  onAddFormula: (plotId: string, axisId: string) => void;
  onDeleteTrace: (plotId: string, traceId: string) => void;
  onAddAxis: (plotId: string) => void;
  onDeleteAxis: (plotId: string, axisId: string) => void;
  onMoveTrace: (
    sourcePlotId: string,
    traceId: string,
    targetPlotId: string,
    targetAxisId: string
  ) => void;
}

const ERROR_LABELS: Record<string, { short: string; tone: 'red' | 'magenta' | 'warm-gray' }> = {
  archiver_unavailable: { short: 'Archiver down', tone: 'red' },
  archiver_timeout: { short: 'Timeout', tone: 'red' },
  archiver_bad_response: { short: 'Bad response', tone: 'red' },
  archiver_not_configured: { short: 'No archiver', tone: 'warm-gray' },
  pv_not_found_in_archiver: { short: 'Unknown PV', tone: 'magenta' },
  invalid_api_key: { short: 'Auth error', tone: 'red' },
  insufficient_read_access: { short: 'Auth error', tone: 'red' },
  network_error: { short: 'Offline', tone: 'red' },
};

function ArchiveStatusChip({ result }: { result: ArchiveSeriesResult | undefined }) {
  if (!result) return null;
  if (result.status === 'loading') {
    return (
      <Tag type="cool-gray" size="sm" style={{ minInlineSize: 'unset', padding: '0 6px' }}>
        Loading
      </Tag>
    );
  }
  if (result.status === 'error') {
    const code = result.error?.code ?? 'unknown_error';
    const label = ERROR_LABELS[code] ?? { short: 'Error', tone: 'red' as const };
    return (
      <Tag
        type={label.tone}
        size="sm"
        style={{ minInlineSize: 'unset', padding: '0 6px' }}
        title={result.error?.detail}
      >
        {label.short}
      </Tag>
    );
  }
  return null;
}

interface TraceRowProps {
  trace: PVTrace;
  label: string;
  plotId: string;
  archiveResult: ArchiveSeriesResult | undefined;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function TraceRow({
  trace,
  label,
  plotId,
  archiveResult,
  isSelected,
  onSelect,
  onDelete,
}: TraceRowProps) {
  const data: DragData = { plotId, axisId: trace.axisId, traceId: trace.id };
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `${plotId}::${trace.id}`,
    data,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`layer-row${isSelected ? ' layer-row--selected' : ''}${isDragging ? ' layer-row--dragging' : ''}`}
      onClick={onSelect}
      {...attributes}
      {...listeners}
    >
      <div className="layer-row__color-swatch" style={{ backgroundColor: trace.color }} />
      <span className="layer-row__name" title={label}>
        {label}
      </span>
      <div className="layer-row__indicators">
        {trace.useLive && (
          <div className="layer-row__indicator layer-row__indicator--live" title="Live Data">
            <Radio size={12} />
          </div>
        )}
        {trace.useArchive && (
          <div className="layer-row__indicator layer-row__indicator--archive" title="Archive Data">
            <Archive size={12} />
          </div>
        )}
        <ArchiveStatusChip result={archiveResult} />
      </div>
      <button
        className="layer-row__delete"
        title="Delete trace"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          height: 20,
          border: 'none',
          background: 'transparent',
          color: 'var(--cds-text-helper)',
          cursor: 'pointer',
          padding: 0,
          borderRadius: 2,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#da1e28';
          (e.currentTarget as HTMLButtonElement).style.color = '#ffffff';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--cds-text-helper)';
        }}
      >
        <TrashCan size={12} />
      </button>
    </div>
  );
}

interface AxisSectionProps {
  axis: Axis;
  plotId: string;
  traces: PVTrace[];
  // The plot's full trace list, for numbering unnamed traces plot-wide.
  plotTraces: PVTrace[];
  archiveResults: Map<string, ArchiveSeriesResult>;
  isSelected: boolean;
  isExpanded: boolean;
  selectedItem: SelectedItem;
  canDelete: boolean;
  onSelectAxis: () => void;
  onToggleExpanded: () => void;
  onDeleteAxis: () => void;
  onSelectTrace: (traceId: string) => void;
  onDeleteTrace: (traceId: string) => void;
  onAddTrace: () => void;
  onAddFormula: () => void;
}

function AxisSection({
  axis,
  plotId,
  traces,
  plotTraces,
  archiveResults,
  isSelected,
  isExpanded,
  selectedItem,
  canDelete,
  onSelectAxis,
  onToggleExpanded,
  onDeleteAxis,
  onSelectTrace,
  onDeleteTrace,
  onAddTrace,
  onAddFormula,
}: AxisSectionProps) {
  const data: DragData = { plotId, axisId: axis.id };
  const { setNodeRef, isOver } = useDroppable({ id: `axis::${plotId}::${axis.id}`, data });

  return (
    <div ref={setNodeRef} className={`axis-drop-zone${isOver ? ' axis-drop-zone--over' : ''}`}>
      {/* Axis header row */}
      <div
        className={`axis-section__header${isSelected ? ' axis-section__header--selected' : ''}`}
        onClick={onSelectAxis}
      >
        <button
          style={{
            display: 'flex',
            alignItems: 'center',
            border: 'none',
            background: 'transparent',
            color: 'var(--cds-text-secondary)',
            cursor: 'pointer',
            padding: 2,
            borderRadius: 2,
            flexShrink: 0,
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpanded();
          }}
          title={isExpanded ? 'Collapse' : 'Expand'}
        >
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <ChartLineData size={16} style={{ color: 'var(--cds-text-helper)', flexShrink: 0 }} />

        <Tag
          type="gray"
          size="sm"
          style={{ flexShrink: 0, minInlineSize: 'unset', padding: '0 4px' }}
        >
          {axis.orientation === 'left' ? 'L' : 'R'}
        </Tag>

        <span
          style={{
            fontSize: 12,
            color: 'var(--cds-text-primary)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={axis.name}
        >
          {axis.name}
        </span>

        {canDelete && (
          <button
            className="layer-row__delete"
            title="Delete axis"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteAxis();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              border: 'none',
              background: 'transparent',
              color: 'var(--cds-text-helper)',
              cursor: 'pointer',
              padding: 2,
              borderRadius: 2,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#da1e28';
              (e.currentTarget as HTMLButtonElement).style.color = '#ffffff';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--cds-text-helper)';
            }}
          >
            <TrashCan size={12} />
          </button>
        )}
      </div>

      {/* Traces under this axis */}
      {isExpanded && (
        <div className="axis-section__traces">
          <SortableContext
            items={traces.map((t) => `${plotId}::${t.id}`)}
            strategy={verticalListSortingStrategy}
          >
            {traces.map((trace) => (
              <TraceRow
                key={trace.id}
                trace={trace}
                label={traceLabel(trace, plotTraces)}
                plotId={plotId}
                archiveResult={archiveResults.get(trace.id)}
                isSelected={
                  selectedItem?.type === 'trace' &&
                  selectedItem.id === trace.id &&
                  selectedItem.plotId === plotId
                }
                onSelect={() => onSelectTrace(trace.id)}
                onDelete={() => onDeleteTrace(trace.id)}
              />
            ))}
          </SortableContext>
          <div className="axis-add-trace-row">
            <Button
              kind="ghost"
              size="sm"
              renderIcon={Add}
              iconDescription="Add trace"
              onClick={onAddTrace}
              style={{
                fontSize: 11,
                color: 'var(--cds-text-helper)',
                minHeight: 'unset',
                padding: '2px 8px',
              }}
            >
              Add Trace
            </Button>
            <Button
              kind="ghost"
              size="sm"
              renderIcon={FunctionIcon}
              iconDescription="Add formula"
              onClick={onAddFormula}
              style={{
                fontSize: 11,
                color: 'var(--cds-text-helper)',
                minHeight: 'unset',
                padding: '2px 8px',
              }}
            >
              Add Formula
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface PlotAxesProps {
  plot: Plot;
  archiveResults: Map<string, ArchiveSeriesResult>;
  selectedItem: SelectedItem;
  collapsedAxes: Set<string>;
  onToggleAxis: (axisId: string) => void;
  onSelectItem: (item: SelectedItem) => void;
  onAddTrace: (plotId: string, axisId: string) => void;
  onAddFormula: (plotId: string, axisId: string) => void;
  onDeleteTrace: (plotId: string, traceId: string) => void;
  onDeleteAxis: (plotId: string, axisId: string) => void;
}

// Presentational: one plot's axes + traces. Drag-and-drop is owned by the single
// DndContext in LeftPanel so traces can move between plots.
function PlotAxes({
  plot,
  archiveResults,
  selectedItem,
  collapsedAxes,
  onToggleAxis,
  onSelectItem,
  onAddTrace,
  onAddFormula,
  onDeleteTrace,
  onDeleteAxis,
}: PlotAxesProps) {
  return (
    <>
      {plot.axes.map((axis) => {
        const axisTraces = plot.traces.filter((t) => t.axisId === axis.id);
        return (
          <AxisSection
            key={axis.id}
            axis={axis}
            plotId={plot.id}
            traces={axisTraces}
            plotTraces={plot.traces}
            archiveResults={archiveResults}
            isSelected={
              selectedItem?.type === 'axis' &&
              selectedItem.id === axis.id &&
              selectedItem.plotId === plot.id
            }
            isExpanded={!collapsedAxes.has(axis.id)}
            selectedItem={selectedItem}
            canDelete={plot.axes.length > 1}
            onSelectAxis={() => onSelectItem({ type: 'axis', id: axis.id, plotId: plot.id })}
            onToggleExpanded={() => onToggleAxis(axis.id)}
            onDeleteAxis={() => onDeleteAxis(plot.id, axis.id)}
            onSelectTrace={(id) => onSelectItem({ type: 'trace', id, plotId: plot.id })}
            onDeleteTrace={(id) => onDeleteTrace(plot.id, id)}
            onAddTrace={() => onAddTrace(plot.id, axis.id)}
            onAddFormula={() => onAddFormula(plot.id, axis.id)}
          />
        );
      })}
    </>
  );
}

export function LeftPanel({
  plots,
  activePlotId,
  viewMode,
  archiveResultsByPlot,
  collapsed,
  selectedItem,
  onSelectItem,
  onAddTrace,
  onAddFormula,
  onDeleteTrace,
  onAddAxis,
  onDeleteAxis,
  onMoveTrace,
  onCollapse,
  onExpand,
}: LeftPanelProps) {
  // Track the axes the user collapsed rather than the expanded ones, so axes
  // created after mount (Add Axis, a new plot's Y-Axis 1, a PV's units axis)
  // start expanded too.
  const [collapsedAxes, setCollapsedAxes] = useState<Set<string>>(() => new Set());
  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  if (collapsed) {
    return <PanelRail side="left" label="Layers" icon={<Layers size={16} />} onExpand={onExpand} />;
  }

  const toggleAxisExpanded = (axisId: string) => {
    setCollapsedAxes((prev) => {
      const next = new Set(prev);
      if (next.has(axisId)) next.delete(axisId);
      else next.add(axisId);
      return next;
    });
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDrag((event.active.data.current as DragData) ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDrag(null);
    const { active, over } = event;
    if (!over) return;
    const from = active.data.current as DragData | undefined;
    const to = over.data.current as DragData | undefined;
    if (!from?.traceId || !to) return;
    // No-op if dropped back onto the same axis.
    if (from.plotId === to.plotId && from.axisId === to.axisId) return;
    onMoveTrace(from.plotId, from.traceId, to.plotId, to.axisId);
  };

  // Grid view shows every plot so all of them are editable; tab view shows only
  // the active plot (the others aren't visible in the chart area).
  const plotsToShow = viewMode === 'grid' ? plots : plots.filter((p) => p.id === activePlotId);

  const activeTracePlot = activeDrag?.traceId
    ? plots.find((p) => p.traces.some((t) => t.id === activeDrag.traceId))
    : null;
  const activeTrace = activeTracePlot?.traces.find((t) => t.id === activeDrag?.traceId) ?? null;

  return (
    <div className="layers-panel">
      <div className="layers-panel__header">
        <span className="layers-panel__title">Layers</span>
        <button className="panel-collapse-btn" title="Collapse panel" onClick={onCollapse}>
          <ChevronLeft size={16} />
        </button>
      </div>

      <div className="layers-panel__scroll">
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          {plotsToShow.map((plot) => (
            <div key={plot.id} className="layers-plot-group">
              {/* Plot settings / group header */}
              <div
                className={`plot-settings-row${
                  selectedItem?.type === 'plot' && selectedItem.plotId === plot.id
                    ? ' plot-settings-row--selected'
                    : ''
                }`}
                onClick={() => onSelectItem({ type: 'plot', id: plot.id, plotId: plot.id })}
              >
                <ChartLine size={16} style={{ color: 'var(--cds-text-helper)', flexShrink: 0 }} />
                <span className="plot-settings-row__label">
                  {viewMode === 'grid' ? plot.title : 'Plot Settings'}
                </span>
                <span className="plot-settings-row__hint">X-Axis</span>
              </div>

              <div
                style={{
                  height: 1,
                  backgroundColor: 'var(--cds-border-subtle)',
                  margin: '4px 0 8px',
                }}
              />

              <PlotAxes
                plot={plot}
                archiveResults={archiveResultsByPlot.get(plot.id) ?? EMPTY_RESULTS}
                selectedItem={selectedItem}
                collapsedAxes={collapsedAxes}
                onToggleAxis={toggleAxisExpanded}
                onSelectItem={onSelectItem}
                onAddTrace={onAddTrace}
                onAddFormula={onAddFormula}
                onDeleteTrace={onDeleteTrace}
                onDeleteAxis={onDeleteAxis}
              />

              <div className="layers-plot-group__add-axis">
                <Button
                  kind="ghost"
                  size="sm"
                  renderIcon={Add}
                  iconDescription="Add axis"
                  onClick={() => onAddAxis(plot.id)}
                  style={{ width: '100%', fontSize: 12, maxInlineSize: 'unset' }}
                >
                  Add Axis
                </Button>
              </div>
            </div>
          ))}

          <DragOverlay>
            {activeTrace && (
              <div
                className="layer-row layer-row--selected"
                style={{ opacity: 0.9, cursor: 'grabbing', width: '100%' }}
              >
                <div
                  className="layer-row__color-swatch"
                  style={{ backgroundColor: activeTrace.color }}
                />
                <span className="layer-row__name">
                  {traceLabel(activeTrace, activeTracePlot?.traces)}
                </span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
}
