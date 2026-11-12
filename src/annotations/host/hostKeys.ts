// Key routing of the drawing host. Pure: a keyboard event
// and the host's `handleDrawingKey` in, whether the key was consumed out.
//
// A plot with a root listener of its own (Trace's SinglePlot) resolves the
// key itself and calls `handleDrawingKey` for non-navigation commands; a plot
// without one gets `useDrawingWrapperListeners`, which calls
// `routeDrawingKey` here. Either way:
//   - navigation commands (pan, zoom) are never the drawing host's, so they
//     resolve to "not consumed" and are left to the plot;
//   - `preventDefault` is called only when the handle reports the key
//     consumed, so an Esc with nothing to cancel falls through to the
//     workbench's Escape reset;
//   - editable targets and already-handled events resolve to nothing
//     (`resolveKeyIn`).
// primary+Z is not routed here: undo is the one document-level listener.
import type { Catalog } from '../catalog/types';
import {
  isNavigationCommand,
  resolveKeyIn,
  type DrawingCommand,
  type KeyEventInput,
} from '../keys';

/** A keyboard event the router can claim. */
export type RoutableKeyEvent = KeyEventInput & { preventDefault(): void };

/** The host's key slot: true when the command was consumed. */
export type DrawingKeyHandler = (cmd: DrawingCommand<string>) => boolean;

/**
 * The drawing command `e` asks for over `catalog`, or null when it asks for
 * none or for a navigation command (the plot's own).
 */
export function drawingCommandOf(
  catalog: Catalog,
  e: KeyEventInput,
  mac?: boolean
): DrawingCommand<string> | null {
  const cmd = resolveKeyIn(catalog, e, mac);
  if (cmd === null || isNavigationCommand(cmd)) return null;
  return cmd;
}

/**
 * Routes `e` through `handle` and claims it (`preventDefault`) only when the
 * handle consumed it. Returns whether it was consumed.
 */
export function routeDrawingKey(
  catalog: Catalog,
  e: RoutableKeyEvent,
  handle: DrawingKeyHandler,
  mac?: boolean
): boolean {
  const cmd = drawingCommandOf(catalog, e, mac);
  if (cmd === null) return false;
  const consumed = handle(cmd);
  if (consumed) e.preventDefault();
  return consumed;
}
