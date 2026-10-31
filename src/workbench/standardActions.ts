// The actions every tool appends to its own, and the
// builder each tool's action list goes through (`toolActions`).
//
// Report a bug and Docs in every mode; the theme toggle standalone only,
// because embedded the host owns the theme. The tool passes in its theme
// handle and URLs, so the workbench imports no theme store and no tool
// constant. Order follows the retired Trace header: theme, bug, docs.

import { Asleep, Debug, Help, Light } from '@carbon/icons-react';
import type { Action } from './types';

export interface ThemeHandle {
  colorMode: 'light' | 'dark';
  toggle(): void;
}

export interface StandardActionsOptions {
  /** Embedded in the canopy host: no theme toggle. */
  embedded: boolean;
  /**
   * The host draws the tool's tile bar and its verbs (`embedding.ts`:
   * `embedded=true` and `hostbar=1`), read once per mount. `standardActions`
   * ignores it; a tool's own list reads it. Absent means false, so callers
   * outside a tool page need not pass it.
   */
  hostBar?: boolean;
  /** Omitted when the tool has no theme of its own to toggle. */
  theme?: ThemeHandle;
  bugUrl: string;
  docsUrl: string;
}

/** The Alt+T binding the theme toggle has always had. */
export const THEME_SHORTCUT = 'alt+T';

function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function standardActions({
  embedded,
  theme,
  bugUrl,
  docsUrl,
}: StandardActionsOptions): Action[] {
  const actions: Action[] = [];
  if (!embedded && theme !== undefined) {
    const dark = theme.colorMode === 'dark';
    actions.push({
      id: 'theme',
      label: dark ? 'Switch to light mode' : 'Switch to dark mode',
      icon: dark ? Light : Asleep,
      kind: 'button',
      shortcut: THEME_SHORTCUT,
      onClick: () => theme.toggle(),
    });
  }
  actions.push(
    {
      id: 'report-bug',
      label: 'Report a bug',
      icon: Debug,
      kind: 'button',
      href: bugUrl,
      onClick: () => openExternal(bugUrl),
    },
    {
      id: 'docs',
      label: 'Docs',
      icon: Help,
      kind: 'button',
      href: docsUrl,
      onClick: () => openExternal(docsUrl),
    }
  );
  return actions;
}

/** One of a tool's own actions, minus the handler the canvas closes over its state. */
export interface ToolActionSpec<H> {
  label: string;
  icon: Action['icon'];
  /** `'button'` when omitted. */
  kind?: Action['kind'];
  shortcut?: string;
  /** The host's ⋯ menu placement, copied onto the action. */
  menu?: Action['menu'];
  /** Host tile-bar placement, copied onto the action. */
  bar?: Action['bar'];
  /** The Carbon component name of `icon` (on the host's icon allowlist), copied onto the action. */
  iconName: string;
  handler: keyof H;
}

export interface ToolActionsOptions<Id extends string, H> extends StandardActionsOptions {
  handlers: H;
  /** Whether an action is left out of the bar entirely (the only hidden control). */
  hidden?: (id: Id) => boolean;
  /** A toggle action's pressed state. */
  pressed?: boolean;
  /** Reasons an action is temporarily unusable; such an action stays visible, disabled. */
  disabled?: Partial<Record<Id, string | false>>;
}

/**
 * A tool's full action list: its own, in `ids` order, then the standard
 * actions. Pure.
 */
export function toolActions<Id extends string, H extends { [K in keyof H]: () => void }>(
  ids: readonly Id[],
  specs: Readonly<Record<Id, ToolActionSpec<H>>>,
  options: ToolActionsOptions<Id, H>
): Action[] {
  const { handlers, hidden } = options;
  const disabled: Partial<Record<Id, string | false>> = options.disabled ?? {};
  const actions: Action[] = [];
  for (const id of ids) {
    if (hidden?.(id) === true) continue;
    const spec = specs[id];
    const kind = spec.kind ?? 'button';
    const reason = disabled[id];
    const action: Action = {
      id,
      label: spec.label,
      icon: spec.icon,
      kind,
      onClick: () => handlers[spec.handler](),
    };
    if (kind === 'toggle') action.pressed = options.pressed;
    if (spec.shortcut !== undefined) action.shortcut = spec.shortcut;
    if (spec.menu !== undefined) action.menu = { ...spec.menu };
    if (spec.bar !== undefined) action.bar = { ...spec.bar };
    action.iconName = spec.iconName;
    if (reason) action.disabled = reason;
    actions.push(action);
  }
  actions.push(
    ...standardActions({
      embedded: options.embedded,
      theme: options.theme,
      bugUrl: options.bugUrl,
      docsUrl: options.docsUrl,
    })
  );
  return actions;
}
