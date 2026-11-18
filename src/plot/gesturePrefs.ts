// The choices a site can make about the plot gestures (src/site): what the
// wheel over the plot area zooms, what a drag on a Y axis does, and whether a
// double-click in the plot area resets the axes. The gesture layer reads them
// from its surface at event time (`PlotGestureSurface.prefs`); without them it
// uses DEFAULT_GESTURE_PREFS, the gestures every tool had before the choices
// existed.
//
// No colour literals here (src/plot is literal-guarded).

/**
 * What the wheel over the plot area zooms. `xy`: the X axis and every Y axis,
 * and Alt+wheel the primary Y alone. `x`: the X axis alone, and Alt+wheel the
 * X axis and every Y axis. Over an axis band the wheel always zooms that axis.
 */
export type WheelZoom = 'x' | 'xy';
export const WHEEL_ZOOMS: readonly WheelZoom[] = ['x', 'xy'];

/**
 * What a plain drag on a Y axis band does: pan that axis, or stretch it about
 * its centre. Shift or Alt does the other.
 */
export type YAxisDrag = 'pan' | 'stretch';
export const Y_AXIS_DRAGS: readonly YAxisDrag[] = ['pan', 'stretch'];

/**
 * What a double-click in the plot area does: return every axis of the grid to
 * its reset state, or nothing. A double-click on an axis band always resets
 * that axis.
 */
export type DoubleClick = 'reset' | 'none';
export const DOUBLE_CLICKS: readonly DoubleClick[] = ['reset', 'none'];

export interface GesturePrefs {
  wheel: WheelZoom;
  yAxisDrag: YAxisDrag;
  doubleClick: DoubleClick;
}

/** The layer's own choices: the ones a surface without `prefs` gets. */
export const DEFAULT_GESTURE_PREFS: Readonly<GesturePrefs> = Object.freeze({
  wheel: 'xy',
  yAxisDrag: 'stretch',
  doubleClick: 'reset',
});
