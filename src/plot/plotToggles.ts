// The plot strip's toggles: ONE registry every plot tool's rail renders, so a
// toggle added here appears in every tool. A tool never keeps a list of its
// own; it supplies only the values (its defaults live in its own state) and
// the writers.
//
// Two families share the strip:
//   - the drawing prefs and hide-all (magnet, stay, hide), held by the drawing
//     document;
//   - the plot view (tooltip, drag), held in the tool's own state and written
//     to its query only when off the tool's default.
//
// A toggle whose writer the plot does not wire is shown disabled
// (`unwired: 'disable'`) or left out (`unwired: 'omit'`).
//
// No colour literals here (src/plot is literal-guarded).
import type { ComponentType } from 'react';
import { Move, View, ViewOff, ZoomArea } from '@carbon/icons-react';
import { DataTooltipIcon, KeepDrawingIcon, MagnetIcon } from './icons';

/** A plot-strip toggle: magnet, tooltip, stay armed, hide all, drag mode. */
export type PlotToggle = 'magnet' | 'tooltip' | 'stay' | 'hide' | 'drag';

/** The drawing assists the strip toggles; the drawing document's tool prefs satisfy it. */
export interface AssistPrefs {
  /** Snap anchors to the nearest sample. */
  magnet: boolean;
  /** Keep the tool armed after a commit. */
  stay: boolean;
}

/** What a left-drag in the plot area does: draw a zoom box, or pan. */
export type DragMode = 'zoom' | 'pan';

export const DRAG_MODES: readonly DragMode[] = ['zoom', 'pan'];

/** Each drag mode's name, as the Inspector's Drag field lists it. */
export const DRAG_MODE_LABEL: Readonly<Record<DragMode, string>> = {
  zoom: 'Zoom box',
  pan: 'Pan',
};

/** Whether `v` is a drag mode. */
export function isDragMode(v: unknown): v is DragMode {
  return v === 'zoom' || v === 'pan';
}

/** The plot-view settings the strip toggles; each tool holds them in its own state. */
export interface PlotView {
  /** The hover read-out (the chart tooltip) is shown. */
  tooltip: boolean;
  drag: DragMode;
}

/** The values the strip reads. */
export interface ToggleValues {
  prefs: AssistPrefs;
  hidden: boolean;
  /** Absent: the plot offers no view toggles (they are left out). */
  view?: PlotView;
}

/** The writers the strip calls; an absent writer leaves its toggles unwired. */
export interface ToggleWriters {
  onPrefs?: (patch: Partial<AssistPrefs>) => void;
  onHiddenChange?: (on: boolean) => void;
  onView?: (patch: Partial<PlotView>) => void;
}

type Icon = ComponentType<{ size?: number }>;

/** One strip toggle. */
export interface PlotToggleSpec {
  toggle: PlotToggle;
  /** The accessible name; fixed, so the button keeps its name as it toggles. */
  label: string;
  /** The rail tooltip for the current values: what a click does, or the state it shows. */
  title(v: ToggleValues): string;
  icon(v: ToggleValues): Icon;
  pressed(v: ToggleValues): boolean;
  /** The click's write, or null when its writer is not wired. */
  click(v: ToggleValues, w: ToggleWriters): (() => void) | null;
  /** How the toggle shows while its writer is not wired. */
  unwired: 'disable' | 'omit';
  /** The strip group: toggles of one group stand together, a separator between groups. */
  group: 'assist' | 'view' | 'drawings';
}

const prefsToggle = (
  toggle: 'magnet' | 'stay',
  label: string,
  title: string,
  icon: Icon
): PlotToggleSpec => ({
  toggle,
  label,
  title: () => title,
  icon: () => icon,
  pressed: (v) => v.prefs[toggle],
  click: (v, w) => (w.onPrefs ? () => w.onPrefs?.({ [toggle]: !v.prefs[toggle] }) : null),
  unwired: 'disable',
  group: 'assist',
});

/**
 * Every strip toggle, in strip order: the drawing assists (magnet, keep
 * drawing), the plot view (data tooltip, drag mode), then hide-all.
 */
export const PLOT_TOGGLES: readonly PlotToggleSpec[] = Object.freeze([
  prefsToggle('magnet', 'Magnet', 'Magnet: snap to data points', MagnetIcon),
  prefsToggle('stay', 'Keep drawing', 'Keep drawing: the tool stays armed', KeepDrawingIcon),
  {
    toggle: 'tooltip',
    label: 'Data tooltip',
    title: (v) => (v.view?.tooltip ? 'Data tooltip: on' : 'Data tooltip: off'),
    icon: () => DataTooltipIcon,
    pressed: (v) => v.view?.tooltip === true,
    click: (v, w) => (w.onView && v.view ? () => w.onView?.({ tooltip: !v.view?.tooltip }) : null),
    unwired: 'omit',
    group: 'view',
  },
  {
    toggle: 'drag',
    label: 'Zoom box',
    title: (v) =>
      v.view?.drag === 'pan' ? 'Drag pans (click: zoom box)' : 'Drag zooms a box (click: pan)',
    icon: (v) => (v.view?.drag === 'pan' ? Move : ZoomArea),
    pressed: (v) => v.view?.drag === 'zoom',
    click: (v, w) =>
      w.onView && v.view
        ? () => w.onView?.({ drag: v.view?.drag === 'zoom' ? 'pan' : 'zoom' })
        : null,
    unwired: 'omit',
    group: 'view',
  },
  {
    toggle: 'hide',
    label: 'Hide all drawings',
    title: (v) => (v.hidden ? 'Show drawings' : 'Hide drawings'),
    icon: (v) => (v.hidden ? ViewOff : View),
    pressed: (v) => v.hidden,
    click: (v, w) => (w.onHiddenChange ? () => w.onHiddenChange?.(!v.hidden) : null),
    unwired: 'omit',
    group: 'drawings',
  },
] satisfies PlotToggleSpec[]);
