// `canopy:tool-invoke`: under the host bar (`embedding.ts`) the host draws
// the tool's actions from the `canopy:tool-actions` report
// (toolActionsPublisher) and sends a pick back as
// `{type: 'canopy:tool-invoke', id}`. This hook runs the registry action for
// `id`, but only when `id` was in the last report and is not disabled there,
// so the host can trigger exactly what it was shown: hidden, disabled and
// unplaced actions are refused, and anything else is ignored.
//
// It lives here and not in `src/embed/bridge.ts` because that module-level
// bridge is installed before React mounts and cannot see the per-mount
// registry; the workbench's import allow-list also keeps it from importing
// `src/embed`, so the bridge's source/origin guard is repeated below.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { hostBarPage } from './embedding';
import { toolActionsPayload } from './toolActionsPublisher';
import type { ActionRegistry } from './useCanvasActions';

/** The message type of an invoke request. */
export const TOOL_INVOKE = 'canopy:tool-invoke';

export interface ToolInvokeMessage {
  type: typeof TOOL_INVOKE;
  id: string;
}

export interface ToolInvokeOptions {
  /** Whether to listen; read from the page URL once per mount when absent. */
  hostBar?: boolean;
}

/** The ids the report for `snapshot` offers as enabled. Pure. */
export function invocableIds(snapshot: Parameters<typeof toolActionsPayload>[0]): Set<string> {
  return new Set(
    toolActionsPayload(snapshot)
      .actions.filter((entry) => !entry.disabled)
      .map((entry) => entry.id)
  );
}

/**
 * Under the host bar only: listen for `canopy:tool-invoke` from
 * `window.parent` (same origin) and run the registry action for its `id` when
 * the last report offered it enabled.
 */
export function useToolInvoke(registry: ActionRegistry, options: ToolInvokeOptions = {}): void {
  const [fromUrl] = useState(() => hostBarPage());
  const enabled = options.hostBar ?? fromUrl;
  const snapshot = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot
  );
  // What the publisher last posted (its effect runs on the same snapshot).
  const published = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    published.current = invocableIds(snapshot);
  }, [snapshot]);

  useEffect(() => {
    if (!enabled) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== window.location.origin) return;
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) return;
      const msg = data as Record<string, unknown>;
      if (msg.type !== TOOL_INVOKE || typeof msg.id !== 'string') return;
      const id = msg.id;
      if (!published.current.has(id)) return;
      // The registry's onClick re-resolves the latest action and skips it if disabled.
      registry
        .getSnapshot()
        .find((a) => a.id === id)
        ?.onClick();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [enabled, registry]);
}
