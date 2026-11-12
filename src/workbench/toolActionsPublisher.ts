// `canopy:tool-actions`: under the host bar (`embedding.ts`) the host draws
// the tool's tile bar and its verbs, so the workbench reports the tool's
// actions to it, on mount and on every action-registry change, always the
// whole list.
//
// Every entry carries a `placement` and, when declared, an `icon` (a Carbon
// component name). Bar entries come first, sorted by `bar.order`: the
// report's order is the bar's display order. Then the menu entries (a `menu`
// but no `bar`), sorted by `menu.order`, under `menu.label` when given. An
// action with neither placement is not reported. Handlers stay here; the host
// invokes an entry back by id (`toolInvoke.ts`). `links` come from the `href`
// of the standard `docs` and `report-bug` actions. The tools declare
// placements in their own spec tables, so this module knows no tool.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { hostBarPage } from './embedding';
import type { Action } from './types';
import type { ActionRegistry } from './useCanvasActions';

/** The message type of the tool-actions report. */
export const TOOL_ACTIONS = 'canopy:tool-actions';

/** Where the host draws an entry: its tile bar or its ⋯ menu. */
export type ToolActionPlacement = 'bar' | 'menu';

/** A reported `icon`: a Carbon icon component name. */
export const ICON_NAME_PATTERN = /^[A-Z][A-Za-z0-9]{1,39}$/;

/** One entry as reported: the registry action minus its component and handler. */
export interface ToolActionEntry {
  id: string;
  label: string;
  kind: Action['kind'];
  pressed?: boolean;
  disabled?: false | string;
  shortcut?: string;
  /** The Carbon icon component name, when the action declares a valid one. */
  icon?: string;
  placement: ToolActionPlacement;
}

export interface ToolActionsMessage {
  type: typeof TOOL_ACTIONS;
  version: 1;
  /** The tool's one-line state for the host's tile bar (e.g. `2 curves · live`). */
  state?: string;
  actions: ToolActionEntry[];
  links: { docs?: string; bug?: string };
}

/** `actions` that `order` places, sorted by it; registration order breaks ties. Pure. */
function placed(actions: readonly Action[], order: (a: Action) => number | undefined): Action[] {
  return actions
    .map((a, index) => ({ a, index, order: order(a) }))
    .filter((x): x is { a: Action; index: number; order: number } => x.order !== undefined)
    .sort((x, y) => x.order - y.order || x.index - y.index)
    .map(({ a }) => a);
}

function entryOf(a: Action, label: string, placement: ToolActionPlacement): ToolActionEntry {
  const entry: ToolActionEntry = { id: a.id, label, kind: a.kind, placement };
  if (a.pressed !== undefined) entry.pressed = a.pressed;
  if (a.disabled) entry.disabled = a.disabled;
  if (a.shortcut !== undefined) entry.shortcut = a.shortcut;
  if (a.iconName !== undefined && ICON_NAME_PATTERN.test(a.iconName)) entry.icon = a.iconName;
  return entry;
}

/** The `canopy:tool-actions` payload for a registry snapshot. Pure. */
export function toolActionsPayload(actions: readonly Action[], state?: string): ToolActionsMessage {
  const entries = [
    ...placed(actions, (a) => a.bar?.order).map((a) => entryOf(a, a.label, 'bar')),
    ...placed(actions, (a) => (a.bar === undefined ? a.menu?.order : undefined)).map((a) =>
      entryOf(a, a.menu?.label ?? a.label, 'menu')
    ),
  ];
  const links: ToolActionsMessage['links'] = {};
  const docs = actions.find((a) => a.id === 'docs')?.href;
  const bug = actions.find((a) => a.id === 'report-bug')?.href;
  if (docs !== undefined) links.docs = docs;
  if (bug !== undefined) links.bug = bug;
  const message: ToolActionsMessage = { type: TOOL_ACTIONS, version: 1, actions: entries, links };
  if (state !== undefined) message.state = state;
  return message;
}

export interface ToolActionsPublisherOptions {
  /** The tool's state fragment (the report's `state`). */
  state?: string;
  /** Whether to publish; read from the page URL once per mount when absent. */
  hostBar?: boolean;
}

/**
 * Under the host bar only: post `canopy:tool-actions` to `window.parent` at
 * `location.origin` on mount and whenever the registry snapshot or `state`
 * changes. Posts nothing otherwise.
 */
export function useToolActionsPublisher(
  registry: ActionRegistry,
  options: ToolActionsPublisherOptions = {}
): void {
  const [fromUrl] = useState(() => hostBarPage());
  const enabled = options.hostBar ?? fromUrl;
  const { state } = options;
  const snapshot = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot
  );
  useEffect(() => {
    if (!enabled) return;
    window.parent.postMessage(toolActionsPayload(snapshot, state), window.location.origin);
  }, [enabled, snapshot, state]);
}
