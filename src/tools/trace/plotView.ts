// A Trace plot's view settings as the plot strip reads and writes them
// (annotations/plotToggles): the tooltip is on and a left-drag zooms unless the
// plot says otherwise, and only the off-default values are stored.
import type { DragMode, PlotView } from '../../plot/plotToggles';
import type { Plot } from '../../types';

/** Trace's drag mode when the plot names none. */
export const TRACE_DEFAULT_DRAG: DragMode = 'zoom';

/** The view settings `plot` shows. */
export function tracePlotView(plot: Pick<Plot, 'showTooltip' | 'dragMode'>): PlotView {
  return { tooltip: plot.showTooltip !== false, drag: plot.dragMode ?? TRACE_DEFAULT_DRAG };
}

/** `plot` with `patch` applied, each field stored only off its default. */
export function withPlotView<P extends Pick<Plot, 'showTooltip' | 'dragMode'>>(
  plot: P,
  patch: Partial<PlotView>
): P {
  const out = { ...plot };
  if (patch.tooltip !== undefined) {
    if (patch.tooltip) delete out.showTooltip;
    else out.showTooltip = false;
  }
  if (patch.drag !== undefined) {
    if (patch.drag === TRACE_DEFAULT_DRAG) delete out.dragMode;
    else out.dragMode = patch.drag;
  }
  return out;
}
