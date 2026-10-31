// The tool's actions bar: every action the
// canvas registered through `useCanvasActions`, as icon buttons with tooltips
// under `data-testid="actions-bar"`. The keyboard listener that binds their
// shortcuts is `useActionShortcuts`, mounted by the workbench so it runs
// whether or not the bar renders. A toggle carries `aria-pressed`; a disabled action stays
// visible, focusable and hoverable with its reason in the tooltip. Styles
// live in `actions.css`, which `workbench.css` imports.

import { useSyncExternalStore } from 'react';
import { IconButton } from '@carbon/react';
import type { Action } from './types';
import { TESTIDS } from './testids';
import { formatShortcut, type ActionRegistry } from './useCanvasActions';

/** The tooltip (and accessible name): label, shortcut hint, disabled reason. */
function actionTooltip(action: Action): string {
  const hint = formatShortcut(action.shortcut);
  const base = hint ? `${action.label} (${hint})` : action.label;
  return action.disabled ? `${base} — ${action.disabled}` : base;
}

export interface ActionsBarProps {
  registry: ActionRegistry;
}

export function ActionsBar({ registry }: ActionsBarProps) {
  const actions = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot
  );

  return (
    <div
      className="workbench-actions"
      role="toolbar"
      aria-label="Tool actions"
      data-testid={TESTIDS.actionsBar}
    >
      {actions.map((action) => {
        const Icon = action.icon;
        const toggle = action.kind === 'toggle';
        // aria-disabled, not `disabled`: a disabled button takes no hover or
        // focus, and its tooltip is where the reason is read. The
        // registry's onClick ignores a disabled action.
        const disabled = Boolean(action.disabled);
        return (
          <IconButton
            key={action.id}
            className={
              disabled
                ? 'workbench-actions__button workbench-actions__button--disabled'
                : 'workbench-actions__button'
            }
            kind="ghost"
            size="md"
            align="bottom-end"
            label={actionTooltip(action)}
            aria-disabled={disabled || undefined}
            isSelected={toggle ? Boolean(action.pressed) : undefined}
            aria-pressed={toggle ? Boolean(action.pressed) : undefined}
            onClick={() => action.onClick()}
          >
            <Icon size={20} />
          </IconButton>
        );
      })}
    </div>
  );
}
