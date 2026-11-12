// Status line under a plot.
//
// A 20 px line rendered as a sibling BELOW the plot wrapper (SinglePlot wraps
// both in a flex column), so the wrapper still exactly overlays the canvas.
// It shows the time under the pointer and the primary Y axis's value there,
// plus two slots — the armed tool's hint and the embedded hint. The hints derive purely from props (`tool`, `plotIndex`) so
// they never touch the plot's option build: a 1-point tool reads "click to
// place", a 2-point tool "drag or click twice", Measure "shift-drag to
// measure"; embedded, every plot but the first (the only one the tile
// publishes, see embed/stateOut.ts) says its drawings are not saved.
//
// Through the catalog: the time is the plot's x axis
// descriptor's `'status'` form (Trace: the time axis, the crosshair's format),
// the hint the catalog tool's own. The value is read in one grid: the grid of
// the selected drawing or the drawing under the pointer (`focusAxisId`), on
// that drawing's axis, while the pointer is inside it; otherwise the grid
// under the pointer, on the primary axis when that grid draws it, else on the
// grid's first axis.
//
// The pointer comes from the CursorStore the wrapper's mousemove writes and is
// projected through the ProjectionStore, both read with useSyncExternalStore:
// only this component re-renders on a pointer move, never the plot.
//
// It is plot chrome (`data-status-line`, matched by `isPlotChrome`). No colour
// literals here (src/annotations is literal-guarded): Carbon/canopy variables.
import { useSyncExternalStore, type ReactNode } from 'react';
import {
  inRect,
  useProjection,
  type CursorStore,
  type Projection,
  type ProjectionStore,
} from '../plot/geometry';
import type { Catalog, GridProjection, XAxisDescriptor } from './catalog/types';
import type { Tool } from './tools';
import { embeddedHintFor, toolHintIn } from './statusHints';

/** Height of the status line in CSS pixels. */
const STATUS_LINE_HEIGHT = 20;

/** A value at seven significant digits, exponential when very small or large. */
function formatStatusValue(v: number): string {
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs < 1e-3 || abs >= 1e7) return v.toExponential(4);
  return String(Number(v.toPrecision(7)));
}

export interface StatusLineProps {
  cursorStore: CursorStore;
  projectionStore: ProjectionStore;
  /** The primary (first visible) Y axis, whose value the line reports. */
  primaryAxisId?: string;
  /** The armed tool; its hint fills the tool slot unless `toolHint` is given. */
  tool?: Tool;
  /** This plot's position in the plot list (0 = the one an embedded tile saves). */
  plotIndex?: number;
  /**
   * The app runs embedded in a host tile (Trace's `isEmbedded()`, injected so
   * the drawing core reads no app state); absent = not embedded.
   */
  embedded?: boolean;
  /** Explicit tool-slot content; overrides the hint derived from `tool`. */
  toolHint?: ReactNode;
  /** Explicit embedded-slot content; overrides the hint derived from `plotIndex`. */
  embeddedHint?: ReactNode;
  /** The plot's tools (the hint's source). */
  catalog: Catalog;
  /** The plot's x axis (the time slot's format). */
  xAxis: XAxisDescriptor;
  /**
   * The axis of the selected drawing or the drawing under the pointer: while
   * the pointer is in that axis's grid, the value is read there, on that axis.
   */
  focusAxisId?: string | null;
}

/**
 * The grid the pointer is read in and the axis its value is read on, or null
 * when the pointer is in no grid: the focus axis's grid while the pointer is
 * inside it, else the grid under the pointer on the primary axis when that
 * grid draws it, else its first axis.
 */
function readAt(
  projection: Projection,
  cursor: { x: number; y: number },
  focusAxisId: string | null | undefined,
  primaryAxisId: string | undefined
): { grid: GridProjection; axisId: string | undefined } | null {
  if (focusAxisId) {
    const grid = projection.gridOf(focusAxisId);
    if (grid && inRect(grid.gridRect, cursor.x, cursor.y)) return { grid, axisId: focusAxisId };
  }
  const grid = projection.gridAt(cursor.x, cursor.y);
  if (!grid) return null;
  const axisId =
    primaryAxisId && grid.axisIds.includes(primaryAxisId) ? primaryAxisId : grid.axisIds[0];
  return { grid, axisId };
}

export function StatusLine({
  cursorStore,
  projectionStore,
  primaryAxisId,
  tool,
  plotIndex,
  embedded = false,
  toolHint: toolHintProp,
  embeddedHint: embeddedHintProp,
  catalog,
  xAxis,
  focusAxisId,
}: StatusLineProps) {
  const toolHint = toolHintProp !== undefined ? toolHintProp : toolHintIn(catalog, tool, { xAxis });
  const embeddedHint =
    embeddedHintProp !== undefined ? embeddedHintProp : embeddedHintFor(plotIndex, embedded);
  const cursor = useSyncExternalStore(cursorStore.subscribe, cursorStore.get, cursorStore.get);
  const projection = useProjection(projectionStore);

  let time = '';
  let value = '';
  const read = cursor && projection ? readAt(projection, cursor, focusAxisId, primaryAxisId) : null;
  if (cursor && read) {
    const t = read.grid.xToT(cursor.x);
    if (Number.isFinite(t)) time = xAxis.format(t, 'status');
    if (read.axisId) {
      const v = read.grid.yToV(cursor.y, read.axisId);
      if (Number.isFinite(v)) value = formatStatusValue(v);
    }
  }

  return (
    <div
      data-status-line=""
      style={{
        flex: `0 0 ${STATUS_LINE_HEIGHT}px`,
        height: STATUS_LINE_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 8px',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        fontSize: 'var(--canopy-text-sm)',
        color: 'var(--cds-text-secondary)',
        background: 'var(--cds-layer)',
        borderTop: '1px solid var(--cds-border-subtle)',
      }}
    >
      <span data-status-time="" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {time}
      </span>
      <span data-status-value="" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
      <span data-status-tool-hint="" style={{ marginLeft: 'auto' }}>
        {toolHint}
      </span>
      {embeddedHint != null && <span data-status-embedded-hint="">{embeddedHint}</span>}
    </div>
  );
}
