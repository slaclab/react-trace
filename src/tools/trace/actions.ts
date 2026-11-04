// Trace's canvas actions.
//
// Refresh archive, Data insight, Post to e-log, Save, Print, Import, Export
// CSV and Export PNG, in every mode and in the retired toolbar's order, then
// the workbench's standard actions (theme standalone only, Report a bug,
// Docs). The canvas registers the list through `useCanvasActions`; the
// workbench's actions bar renders it and binds every shortcut from it, so
// each shortcut is declared here on its action and Trace keeps no shortcut
// table of its own.
//
// Post to e-log is *hidden* when the deployment has no logbook (the `elog`
// capability); any other action that is temporarily unusable stays visible
// and is *disabled with its reason*, supplied by the caller.
//
// Under the host bar (a host that draws the tool's tile bar) the report
// places the actions. Bar, in display order: Refresh archive · Data insight ·
// Export CSV · Export PNG · Post to E-Log · Plots as grid. Menu: Import… ·
// Export trace file · Print. `save` becomes "Export trace file" with no
// shortcut, since primary+S is the host's Save view (it still downloads the
// `.trc.json`), and a `view-mode` toggle (pressed = grid) is registered.
// Standalone labels, shortcuts and bar contents are unchanged.

import {
  DataTable,
  Download,
  Grid,
  Image,
  Printer,
  Renew,
  Save,
  SendAlt,
  Upload,
} from '@carbon/icons-react';
import type { Action } from '../../workbench/types';
import { useCanvasActions } from '../../workbench/useCanvasActions';
import {
  toolActions,
  type StandardActionsOptions,
  type ToolActionSpec,
} from '../../workbench/standardActions';
import type { TraceCapabilities } from './capabilities';

/** Trace's own action ids, in bar order. */
export const TRACE_ACTION_IDS = [
  'refresh-archive',
  'data-insight',
  'post-elog',
  'save',
  'print',
  'import',
  'export-csv',
  'export-png',
  'view-mode',
] as const;

export type TraceActionId = (typeof TRACE_ACTION_IDS)[number];

/** The handler each action invokes; the canvas closes these over its state. */
export interface TraceActionHandlers {
  refreshArchive(): void;
  dataInsight(): void;
  postElog(): void;
  save(): void;
  print(): void;
  import(): void;
  exportCsv(): void;
  exportPng(): void;
}

/** The spec table's handlers: the canvas's, plus the host-bar view-mode toggle. */
type TraceSpecHandlers = TraceActionHandlers & { toggleViewMode(): void };

/** The label of `save` under the host bar: the download, not Save view. */
export const EXPORT_TRACE_FILE_LABEL = 'Export trace file';

/**
 * Each action's shortcut, label and placements. Theme (Alt+T) lives on the
 * standard theme action. `bar` and `menu` are the host's tile-bar and ⋯ menu
 * placements.
 */
export const TRACE_ACTION_SPECS: Readonly<
  Record<TraceActionId, ToolActionSpec<TraceSpecHandlers>>
> = {
  'refresh-archive': {
    label: 'Refresh archive data',
    icon: Renew,
    iconName: 'Renew',
    handler: 'refreshArchive',
    bar: { order: 10 },
  },
  'data-insight': {
    label: 'Data Insight',
    icon: DataTable,
    iconName: 'DataTable',
    shortcut: 'alt+D',
    handler: 'dataInsight',
    bar: { order: 20 },
  },
  'post-elog': {
    label: 'Post to E-Log',
    icon: SendAlt,
    iconName: 'SendAlt',
    shortcut: 'primary+E',
    handler: 'postElog',
    bar: { order: 50 },
  },
  save: {
    label: 'Save',
    icon: Save,
    iconName: 'Save',
    shortcut: 'primary+S',
    handler: 'save',
    menu: { order: 40, label: EXPORT_TRACE_FILE_LABEL },
  },
  print: {
    label: 'Print',
    icon: Printer,
    iconName: 'Printer',
    shortcut: 'primary+P',
    handler: 'print',
    menu: { order: 50 },
  },
  import: {
    label: 'Import',
    icon: Upload,
    iconName: 'Upload',
    shortcut: 'primary+O',
    handler: 'import',
    menu: { order: 10, label: 'Import…' },
  },
  'export-csv': {
    label: 'Export CSV',
    icon: Download,
    iconName: 'Download',
    handler: 'exportCsv',
    bar: { order: 30 },
  },
  'export-png': {
    label: 'Export PNG',
    icon: Image,
    iconName: 'Image',
    shortcut: 'primary+I',
    handler: 'exportPng',
    bar: { order: 40 },
  },
  'view-mode': {
    label: 'Plots as grid',
    icon: Grid,
    iconName: 'Grid',
    kind: 'toggle',
    handler: 'toggleViewMode',
    bar: { order: 60 },
  },
};

export interface TraceActionsOptions extends StandardActionsOptions {
  handlers: TraceActionHandlers;
  /** Trace's capability record; `elog: false` hides Post to e-log. */
  capabilities: TraceCapabilities;
  /** Reasons an action is temporarily unusable; such an action stays visible, disabled. */
  disabled?: Partial<Record<TraceActionId, string | false>>;
  /**
   * The plot area's tabs/grid mode and its toggle; registered as the
   * `view-mode` action only under `hostBar` (pressed = grid).
   */
  viewMode?: { grid: boolean; toggle(): void };
}

/** Trace's full action list for the actions bar. Pure. */
export function traceActions(options: TraceActionsOptions): Action[] {
  const { capabilities, viewMode, handlers, ...rest } = options;
  const hostBar = options.hostBar === true;
  const actions = toolActions(TRACE_ACTION_IDS, TRACE_ACTION_SPECS, {
    ...rest,
    handlers: { ...handlers, toggleViewMode: () => viewMode?.toggle() },
    pressed: viewMode?.grid === true,
    hidden: (id) =>
      // No logbook, no Post to e-log.
      (id === 'post-elog' && !capabilities.elog) ||
      // The view-mode toggle exists only in the host's tile bar, with a mode
      // to toggle; standalone the plot area's Tab view / Grid view pair is it.
      (id === 'view-mode' && !(hostBar && viewMode !== undefined)),
  });
  if (!hostBar) return actions;
  // primary+S is the host's Save view; the download keeps its handler.
  return actions.map((a) => {
    if (a.id !== 'save') return a;
    const exported: Action = { ...a, label: EXPORT_TRACE_FILE_LABEL };
    delete exported.shortcut;
    return exported;
  });
}

/**
 * Trace's `state` for the `canopy:tool-actions` report: `<n> curves ·
 * live|paused`, live while any curve streams live data, paused otherwise. Pure.
 */
export function traceHostState(
  plots: readonly { traces: readonly { useLive?: boolean }[] }[]
): string {
  const traces = plots.flatMap((p) => p.traces);
  const n = traces.length;
  const live = traces.some((t) => t.useLive === true);
  return `${n} ${n === 1 ? 'curve' : 'curves'} · ${live ? 'live' : 'paused'}`;
}

/** Register Trace's actions from inside the canvas (no-op outside a workbench). */
export function useTraceCanvasActions(options: TraceActionsOptions): void {
  useCanvasActions(traceActions(options));
}
