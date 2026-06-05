import { useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useSortable, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDroppable } from '@dnd-kit/core';
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
} from '@carbon/icons-react';
import { Button, Tag } from '@carbon/react';
import type { PVTrace, Axis } from '../types';
import type { SelectedItem } from './TraceApp';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import { PanelRail } from './PanelRail';

interface LeftPanelProps {
  traces: PVTrace[];
  axes: Axis[];
  archiveResults: Map<string, ArchiveSeriesResult>;
  collapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  selectedItem: SelectedItem;
  onSelectItem: (item: SelectedItem) => void;
  onAddTrace: (axisId: string) => void;
  onDeleteTrace: (traceId: string) => void;
  onAddAxis: () => void;
  onDeleteAxis: (axisId: string) => void;
  onMoveTrace: (traceId: string, targetAxisId: string) => void;
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
  archiveResult: ArchiveSeriesResult | undefined;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function TraceRow({ trace, archiveResult, isSelected, onSelect, onDelete }: TraceRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: trace.id,
    data: { type: 'trace', axisId: trace.axisId },
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
      <span className="layer-row__name" title={trace.displayName}>
        {trace.displayName}
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
  traces: PVTrace[];
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
}

function AxisSection({
  axis,
  traces,
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
}: AxisSectionProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `droppable-${axis.id}`,
    data: { type: 'axis', axisId: axis.id },
  });

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
          <SortableContext items={traces.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            {traces.map((trace) => (
              <TraceRow
                key={trace.id}
                trace={trace}
                archiveResult={archiveResults.get(trace.id)}
                isSelected={selectedItem?.type === 'trace' && selectedItem.id === trace.id}
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
          </div>
        </div>
      )}
    </div>
  );
}

export function LeftPanel({
  traces,
  axes,
  archiveResults,
  collapsed,
  selectedItem,
  onSelectItem,
  onAddTrace,
  onDeleteTrace,
  onAddAxis,
  onDeleteAxis,
  onMoveTrace,
  onCollapse,
  onExpand,
}: LeftPanelProps) {
  const [expandedAxes, setExpandedAxes] = useState<Set<string>>(new Set(axes.map((a) => a.id)));
  const [activeTraceId, setActiveTraceId] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  if (collapsed) {
    return <PanelRail side="left" label="Layers" icon={<Layers size={16} />} onExpand={onExpand} />;
  }

  const toggleAxisExpanded = (axisId: string) => {
    setExpandedAxes((prev) => {
      const next = new Set(prev);
      if (next.has(axisId)) {
        next.delete(axisId);
      } else {
        next.add(axisId);
      }
      return next;
    });
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveTraceId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTraceId(null);
    const { active, over } = event;
    if (!over) return;

    const overId = over.id as string;
    const activeTraceId = active.id as string;
    const activeTrace = traces.find((t) => t.id === activeTraceId);
    if (!activeTrace) return;

    // Dropped on a droppable axis zone
    if (overId.startsWith('droppable-')) {
      const targetAxisId = overId.replace('droppable-', '');
      if (targetAxisId !== activeTrace.axisId) {
        onMoveTrace(activeTraceId, targetAxisId);
      }
      return;
    }

    // Dropped on another trace — move to that trace's axis
    const targetTrace = traces.find((t) => t.id === overId);
    if (targetTrace && targetTrace.axisId !== activeTrace.axisId) {
      onMoveTrace(activeTraceId, targetTrace.axisId);
    }
  };

  const activeTrace = activeTraceId ? traces.find((t) => t.id === activeTraceId) : null;

  return (
    <div className="layers-panel">
      <div className="layers-panel__header">
        <span className="layers-panel__title">Layers</span>
        <button className="panel-collapse-btn" title="Collapse panel" onClick={onCollapse}>
          <ChevronLeft size={16} />
        </button>
      </div>

      <div className="layers-panel__scroll">
        {/* Plot Settings row */}
        <div
          className={`plot-settings-row${selectedItem?.type === 'plot' ? ' plot-settings-row--selected' : ''}`}
          onClick={() => onSelectItem({ type: 'plot', id: 'plot' })}
        >
          <ChartLine size={16} style={{ color: 'var(--cds-text-helper)', flexShrink: 0 }} />
          <span className="plot-settings-row__label">Plot Settings</span>
          <span className="plot-settings-row__hint">X-Axis</span>
        </div>

        <div
          style={{ height: 1, backgroundColor: 'var(--cds-border-subtle)', margin: '4px 0 8px' }}
        />

        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          {axes.map((axis) => {
            const axisTraces = traces.filter((t) => t.axisId === axis.id);
            return (
              <AxisSection
                key={axis.id}
                axis={axis}
                traces={axisTraces}
                archiveResults={archiveResults}
                isSelected={selectedItem?.type === 'axis' && selectedItem.id === axis.id}
                isExpanded={expandedAxes.has(axis.id)}
                selectedItem={selectedItem}
                canDelete={axes.length > 1}
                onSelectAxis={() => onSelectItem({ type: 'axis', id: axis.id })}
                onToggleExpanded={() => toggleAxisExpanded(axis.id)}
                onDeleteAxis={() => onDeleteAxis(axis.id)}
                onSelectTrace={(id) => onSelectItem({ type: 'trace', id })}
                onDeleteTrace={onDeleteTrace}
                onAddTrace={() => onAddTrace(axis.id)}
              />
            );
          })}

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
                <span className="layer-row__name">{activeTrace.displayName}</span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>

      <div className="layers-panel__footer">
        <Button
          kind="ghost"
          size="sm"
          renderIcon={Add}
          iconDescription="Add axis"
          onClick={onAddAxis}
          style={{ width: '100%', fontSize: 12, maxInlineSize: 'unset' }}
        >
          Add Axis
        </Button>
      </div>
    </div>
  );
}
