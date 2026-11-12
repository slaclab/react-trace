// Plot context menus.
//
// Right-click on a Y axis opens `AxisMenu` (Auto-scale, Logarithmic, Invert, a
// divider, Reset scale); right-click on the time strip opens `TimeBandMenu`
// (All, then the shared `TIME_RANGE_PRESETS`). Both are plain Carbon `Menu`s —
// no custom menu component — so focus, keyboard navigation, Esc, outside-click
// (blur) and close-on-select all come from Carbon.
//
// Detached plots: the caller passes `target` — the plot
// wrapper's `ownerDocument.body` — and the pointer's clientX/clientY, which are
// viewport coordinates of THAT document, so a popped-out plot's menu portals
// into its own window rather than the opener's.
//
// Writes go through the plot's own writers: axis items send partial patches
// via `onUpdateAxis` (TraceApp merges them), time items send a whole xAxis via
// `onApplyXAxis`. The All item takes the caller's `allLoadedXAxis(…)` result
// and is disabled when that is null.
//
// Right-click in the plot interior opens the workbench's shared point menu
// (`useDrawingPlotMenu`), not a menu of this module.
//
// No colour/font literals here (kept literal-free since its move out of the literal-guarded src/annotations).
import { Menu, MenuItem, MenuItemDivider, MenuItemSelectable } from '@carbon/react';
import type { Axis, Plot } from '../../../types';
import { TIME_RANGE_PRESETS } from '../fields/timeRange';

/** Where a menu opens: a portal node and viewport coordinates in its document. */
export interface MenuAnchor {
  /** Portal target — the plot wrapper's `ownerDocument.body`. */
  target: Element;
  /** clientX of the opening contextmenu event. */
  x: number;
  /** clientY of the opening contextmenu event. */
  y: number;
}

export type AxisMenuAxis = Pick<Axis, 'id' | 'name' | 'autoScale' | 'logScale'>;

export interface AxisMenuProps extends MenuAnchor {
  axis: AxisMenuAxis;
  onUpdateAxis?: (axisId: string, updates: Partial<Axis>) => void;
  onClose: () => void;
}

export function AxisMenu({ axis, target, x, y, onUpdateAxis, onClose }: AxisMenuProps) {
  const write = (updates: Partial<Axis>) => onUpdateAxis?.(axis.id, updates);
  return (
    <Menu
      label={`${axis.name || 'Axis'} options`}
      open
      target={target}
      x={x}
      y={y}
      size="sm"
      onClose={onClose}
      data-plot-menu="axis"
    >
      <MenuItemSelectable
        label="Auto-scale"
        selected={axis.autoScale}
        onChange={(checked) => write({ autoScale: checked })}
      />
      {/* Switching the scale type invalidates the manual extent (a linear
          min of 0 is meaningless on a log axis), so it re-enables auto-scale. */}
      <MenuItemSelectable
        label="Logarithmic"
        selected={axis.logScale}
        onChange={(checked) => write({ logScale: checked, autoScale: true })}
      />
      {/* The Axis model has no inverted flag yet (src/types.ts), so Invert is
          shown but disabled until that field lands. */}
      <MenuItemSelectable label="Invert" selected={false} disabled />
      <MenuItemDivider />
      {/* Reset scale: back to auto-scale and drop any manual limits; the scale
          type (linear/log) is left alone. */}
      <MenuItem
        label="Reset scale"
        onClick={() => write({ autoScale: true, min: undefined, max: undefined })}
      />
    </Menu>
  );
}

export interface TimeBandMenuProps extends MenuAnchor {
  /** The plot's current xAxis; presets keep its other fields. */
  xAxis: Plot['xAxis'];
  /** `allLoadedXAxis(…)` at open time; null disables All. */
  all: Plot['xAxis'] | null;
  onApplyXAxis?: (xAxis: Plot['xAxis']) => void;
  onClose: () => void;
}

export function TimeBandMenu({
  xAxis,
  all,
  target,
  x,
  y,
  onApplyXAxis,
  onClose,
}: TimeBandMenuProps) {
  return (
    <Menu
      label="Time range"
      open
      target={target}
      x={x}
      y={y}
      size="sm"
      onClose={onClose}
      data-plot-menu="time"
    >
      <MenuItem
        label="All"
        disabled={all === null}
        onClick={() => {
          if (all) onApplyXAxis?.(all);
        }}
      />
      {TIME_RANGE_PRESETS.map((preset) => (
        <MenuItem
          key={preset.value}
          label={preset.label}
          onClick={() => onApplyXAxis?.({ ...xAxis, timeRange: preset.value })}
        />
      ))}
    </Menu>
  );
}
