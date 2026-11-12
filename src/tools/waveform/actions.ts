// Waveform's canvas actions.
//
// Pause (a pressed toggle), Snapshot → reference (one click, no dialog),
// Export CSV, Export PNG and Post to e-log — in the retired toolbar's order —
// then the workbench's standard actions (theme standalone only, Report a bug,
// Docs). The canvas registers the list through `useCanvasActions`; the
// workbench's actions bar renders it and binds every shortcut from it.
//
// Post to e-log is *hidden* when the deployment has no logbook (the
// `elog` capability); any other action that is temporarily unusable (Export
// before a frame is published, Snapshot before any curve has data) stays
// visible and is *disabled with its reason*, supplied by the caller.

import { Camera, Download, Image, Pause, SendAlt } from '@carbon/icons-react';
import type { Action, Capabilities } from '../../workbench/types';
import { useCanvasActions } from '../../workbench/useCanvasActions';
import {
  toolActions,
  type StandardActionsOptions,
  type ToolActionSpec,
} from '../../workbench/standardActions';

/** Waveform's one capability record: the logbook listing loaded. */
export interface WaveformCapabilities extends Capabilities {
  elog: boolean;
}

/** Waveform's own action ids, in bar order. */
export const WAVEFORM_ACTION_IDS = [
  'pause',
  'snapshot',
  'export-csv',
  'export-png',
  'post-elog',
] as const;

export type WaveformActionId = (typeof WAVEFORM_ACTION_IDS)[number];

/** The handler each action invokes; the canvas closes these over its state. */
export interface WaveformActionHandlers {
  togglePause(): void;
  snapshot(): void;
  exportCsv(): void;
  exportPng(): void;
  postElog(): void;
}

/**
 * The spec table. `bar` places an action in the host's tile bar, in display
 * order; every action has one.
 */
export const WAVEFORM_ACTION_SPECS: Readonly<
  Record<WaveformActionId, ToolActionSpec<WaveformActionHandlers>>
> = {
  pause: {
    label: 'Pause',
    icon: Pause,
    iconName: 'Pause',
    kind: 'toggle',
    handler: 'togglePause',
    bar: { order: 10 },
  },
  snapshot: {
    label: 'Snapshot → reference',
    icon: Camera,
    iconName: 'Camera',
    kind: 'button',
    handler: 'snapshot',
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

export interface WaveformActionsOptions extends StandardActionsOptions {
  handlers: WaveformActionHandlers;
  /** Pause's pressed state. */
  paused: boolean;
  /** `elog: false` hides Post to e-log. */
  capabilities: WaveformCapabilities;
  /** Reasons an action is temporarily unusable; such an action stays visible, disabled. */
  disabled?: Partial<Record<WaveformActionId, string | false>>;
}

/** Waveform's full action list for the actions bar. Pure. */
export function waveformActions(options: WaveformActionsOptions): Action[] {
  const { capabilities, paused, ...rest } = options;
  return toolActions(WAVEFORM_ACTION_IDS, WAVEFORM_ACTION_SPECS, {
    ...rest,
    pressed: paused,
    // The only hidden control — no logbook, no Post to e-log.
    hidden: (id) => id === 'post-elog' && !capabilities.elog,
  });
}

/** Register Waveform's actions from inside the canvas (no-op outside a workbench). */
export function useWaveformCanvasActions(options: WaveformActionsOptions): void {
  useCanvasActions(waveformActions(options));
}
