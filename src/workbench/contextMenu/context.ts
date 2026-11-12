// The menu host's two contexts and the hooks the tool's parts use: the
// opener (`useContextMenu`, for the Outline, legends and plots) and the
// writers' slot (`useContextMenuWriters`, for the tool's canvas).
import { createContext, useContext, useEffect, useLayoutEffect } from 'react';
import type { ContextMenuWriters, MenuRequest, MenuSignal } from './registry';

/** Where a menu opens: viewport coordinates of `target`'s document, portalled into `target`. */
export interface MenuAt {
  x: number;
  y: number;
  /** The portal node: the opening element's `ownerDocument.body`; the global body when absent. */
  target?: Element;
}

export interface ContextMenuApi {
  /** Open the signal menu for these item ids; false when none is a signal. */
  openSignals(ids: readonly string[], at: MenuAt): boolean;
  /** Open a menu for `request`; false when nothing applies. */
  open(request: MenuRequest, at: MenuAt, local?: ContextMenuWriters): boolean;
  /** The signal an item id names (the tool's `signalOf`), or null. */
  signalOf(id: string): MenuSignal | null;
  /** Show the toast (two seconds). */
  toast(text: string, error?: boolean): void;
}

export const MenuContext = createContext<ContextMenuApi | null>(null);
/** Where the tool's writers are registered. */
export interface WritersSlot {
  set(writers: ContextMenuWriters): void;
}

export const WritersContext = createContext<WritersSlot | null>(null);

/** The tool's menu host, or null outside a workbench (the caller keeps its own behaviour). */
export function useContextMenu(): ContextMenuApi | null {
  return useContext(MenuContext);
}

/** Register the tool's writers (latest wins, read when a menu opens). */
export function useContextMenuWriters(writers: ContextMenuWriters): void {
  const slot = useContext(WritersContext);
  useLayoutEffect(() => {
    slot?.set(writers);
  });
  useEffect(() => () => slot?.set({}), [slot]);
}
