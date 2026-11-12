// Correlation's canvas actions.
//
// Pause (a pressed toggle), Clear, Export CSV, Export PNG and Post to e-log —
// the retired plot toolbar's actions, in its order — then the workbench's
// standard actions (theme standalone only, Report a bug, Docs). The canvas
// registers the list through `useCanvasActions`; the workbench's actions bar
// renders it and binds every shortcut from it.
//
// Post to e-log is *hidden* when the deployment has no logbook (the
// `elog` capability); the exports, temporarily unusable until a frame exists,
// stay visible and are *disabled with their reason*, supplied by the caller.
// The view controls the toolbar used to hold (View, Density Y, Y layout) are
// Properties › View fields now, not actions.

import { Download, Erase, Image, Pause, SendAlt } from '@carbon/icons-react';
import type { Action, Capabilities } from '../../workbench/types';
import { useCanvasActions } from '../../workbench/useCanvasActions';
import {
  toolActions,
  type StandardActionsOptions,
  type ToolActionSpec,
} from '../../workbench/standardActions';

/** Correlation's one capability record: the logbook listing loaded. */
export interface CorrelationCapabilities extends Capabilities {
  elog: boolean;
}

/** Correlation's own action ids, in bar order. */
export const CORRELATION_ACTION_IDS = [
  'pause',
  'clear',
  'export-csv',
  'export-png',
  'post-elog',
] as const;

export type CorrelationActionId = (typeof CORRELATION_ACTION_IDS)[number];

/** The handler each action invokes; the canvas closes these over its state. */
export interface CorrelationActionHandlers {
  togglePause(): void;
  clear(): void;
  exportCsv(): void;
  exportPng(): void;
  postElog(): void;
}

/**
 * The spec table. `bar` places an action in the host's tile bar, in display
 * order; every action has one.
 */
export const CORRELATION_ACTION_SPECS: Readonly<
  Record<CorrelationActionId, ToolActionSpec<CorrelationActionHandlers>>
> = {
  pause: {
    label: 'Pause',
    icon: Pause,
    iconName: 'Pause',
    kind: 'toggle',
    handler: 'togglePause',
    bar: { order: 10 },
  },
  clear: {
    label: 'Clear',
    icon: Erase,
    iconName: 'Erase',
    kind: 'button',
    handler: 'clear',
    bar: { order: 20 },
  },
  'export-csv': {
    label: 'Export CSV',
    icon: Download,
    iconName: 'Download',
    kind: 'button',
    handler: 'exportCsv',
    bar: { order: 30 },
  },
  'export-png': {
    label: 'Export PNG',
    icon: Image,
    iconName: 'Image',
    kind: 'button',
    shortcut: 'primary+I',
    handler: 'exportPng',
    bar: { order: 40 },
  },
  'post-elog': {
    label: 'Post to E-Log',
    icon: SendAlt,
    iconName: 'SendAlt',
    kind: 'button',
    shortcut: 'primary+E',
    handler: 'postElog',
    bar: { order: 50 },
  },
};

export interface CorrelationActionsOptions extends StandardActionsOptions {
  handlers: CorrelationActionHandlers;
  /** Pause's pressed state. */
  paused: boolean;
  /** `elog: false` hides Post to e-log. */
  capabilities: CorrelationCapabilities;
  /** Reasons an action is temporarily unusable; such an action stays visible, disabled. */
  disabled?: Partial<Record<CorrelationActionId, string | false>>;
}

/** Correlation's full action list for the actions bar. Pure. */
export function correlationActions(options: CorrelationActionsOptions): Action[] {
  const { capabilities, paused, ...rest } = options;
  return toolActions(CORRELATION_ACTION_IDS, CORRELATION_ACTION_SPECS, {
    ...rest,
    pressed: paused,
    // The only hidden control — no logbook, no Post to e-log.
    hidden: (id) => id === 'post-elog' && !capabilities.elog,
  });
}

/** Register Correlation's actions from inside the canvas (no-op outside a workbench). */
export function useCorrelationCanvasActions(options: CorrelationActionsOptions): void {
  useCanvasActions(correlationActions(options));
}
