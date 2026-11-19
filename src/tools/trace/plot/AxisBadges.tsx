// Axis auto-scale badges.
//
// A small `A` button sits above every visible Y axis that is NOT auto-scaled,
// centred on that axis's line; clicking it re-enables auto-scale with ONE
// `onUpdateAxis({ autoScale: true })` and no min/max. Positions come from the
// projection store's `gridRect` (republished on each ECharts `finished` and
// resize) and the plot's layout slots, so the badges follow the grid without
// re-rendering the plot. Each badge sits over the grid that draws its axis
// (`projection.gridOf`), so a split plot badges every grid.
//
// The badge is plot chrome: it carries `data-axis-badge`, which `isPlotChrome`
// matches, so every wrapper gesture handler ignores events that start on it.
// It also stops native `pointerdown`/`mousedown` propagation itself, so a press
// on the badge never reaches the wrapper's Y-band drag. React's synthetic
// stopPropagation would be too late (React listens at the root, above the
// wrapper's native listeners), hence the native listeners on the element.
//
// No colour literals here (kept literal-free since its move out of the literal-guarded src/annotations): colours come
// from the chart theme the plot already renders with.
import { useCallback } from 'react';
import type { Axis } from '../../../types';
import { type ChartTheme } from '@slaclab/canopy-charts';
import { stopPressPropagation, useProjection, type ProjectionStore } from '../../../plot/geometry';

/** Badge edge length in CSS pixels. */
export const AXIS_BADGE_SIZE = 16;
/** Gap between the badge's bottom edge and the top of the plot grid. */
const BADGE_GAP = 4;

/**
 * The slice of the plot layout (components/PlotArea `plotLayout()`) the badges
 * need: each axis's slot on its side, the right inset, and the per-slot offset.
 * Structural, so this module never imports a component.
 */
export interface AxisBadgeLayout {
  sideIndexMap: ReadonlyMap<string, number>;
  gridRight: number;
  axisOffset: number;
}

export type AxisBadgeAxis = Pick<Axis, 'id' | 'name' | 'autoScale' | 'orientation'>;

export interface AxisBadgesProps {
  projectionStore: ProjectionStore;
  /** The plot's visible axes, in panel order. */
  axes: readonly AxisBadgeAxis[];
  layout: AxisBadgeLayout;
  theme: Pick<ChartTheme, 'bg' | 'axisLabel' | 'axisLine'>;
  onUpdateAxis?: (axisId: string, updates: Partial<Axis>) => void;
}

export function AxisBadges({
  projectionStore,
  axes,
  layout,
  theme,
  onUpdateAxis,
}: AxisBadgesProps) {
  const projection = useProjection(projectionStore);
  const enable = useCallback(
    (axisId: string) => onUpdateAxis?.(axisId, { autoScale: true }),
    [onUpdateAxis]
  );
  if (!projection || !onUpdateAxis) return null;
  const manual = axes.filter((a) => !a.autoScale);
  if (manual.length === 0) return null;

  return (
    <>
      {manual.map((axis) => {
        const grid = projection.gridOf(axis.id)?.gridRect ?? projection.gridRect;
        const top = grid.top - BADGE_GAP - AXIS_BADGE_SIZE;
        const slot = layout.sideIndexMap.get(axis.id) ?? 0;
        const lineX =
          axis.orientation === 'right'
            ? grid.left + grid.width + slot * layout.axisOffset
            : grid.left - slot * layout.axisOffset;
        const label = `Auto-scale ${axis.name || 'axis'}`;
        return (
          <button
            key={axis.id}
            type="button"
            ref={stopPressPropagation}
            data-axis-badge={axis.id}
            aria-label={label}
            title={label}
            onClick={(e) => {
              e.stopPropagation();
              enable(axis.id);
            }}
            style={{
              position: 'absolute',
              left: lineX - AXIS_BADGE_SIZE / 2,
              top: Math.max(0, top),
              width: AXIS_BADGE_SIZE,
              height: AXIS_BADGE_SIZE,
              padding: 0,
              margin: 0,
              border: `1px solid ${theme.axisLine}`,
              borderRadius: 3,
              background: theme.bg,
              color: theme.axisLabel,
              font: 'inherit',
              fontSize: 10,
              fontWeight: 600,
              lineHeight: `${AXIS_BADGE_SIZE - 2}px`,
              textAlign: 'center',
              cursor: 'pointer',
              zIndex: 1,
            }}
          >
            A
          </button>
        );
      })}
    </>
  );
}
