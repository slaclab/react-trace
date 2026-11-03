// The message bridge between Trace and the page that embeds it (the CANOPY
// workspace). One `message` listener, installed only when `?embedded=true`,
// accepts messages solely from `window.parent` on our own origin:
//
//   {type:'canopy:trace-visibility', visible: boolean}
//   {type:'canopy:trace-theme', mode: 'light' | 'dark', theme?: string}
//
// Anything else is ignored. Once the listener is in place Trace posts
// `{type:'canopy:trace-ready'}` to the parent so the host knows it can send
// its current state.
//
// The last visibility and theme live in a small external store for
// useSyncExternalStore. `hiddenAt` is stamped only on a visible->hidden
// transition, so a repeated hidden message keeps the original time; consumers
// use it as the frozen "now" while the tab is hidden. A theme message is also
// applied to the colour-mode store (state/colorMode.ts; embedded, it never touches the standalone choice): its
// `mode`, and its `theme` as the host theme id when that is a valid id, else
// no id.
//
// `everVisible` is a separate latch, set the first time the host sends
// `visible:true`. It is not part of the snapshot: the snapshot starts visible
// and `applyVisibility` ignores an unchanged value, so only the message itself
// can tell "the host has shown us" from "nobody has said anything yet". A
// `visible:false` (e.g. the host's reply to trace-ready for a hidden tab)
// never sets it. Consumers that must not act before the host shows them
// (the correlation plot's Formula Engine subscription) read it with its own getter.

import { HOST_THEME_ID } from '@slaclab/canopy-shell';

import { isEmbedded } from './embedded';
import type { ColorMode } from '@slaclab/canopy-shell/color-mode';
import { setHostTheme } from '../state/colorMode';

export interface BridgeSnapshot {
  visible: boolean;
  /** Epoch ms of the last visible->hidden transition; set only while hidden. */
  hiddenAt?: number;
  /** Last mode the host sent; absent until it sends one. */
  mode?: ColorMode;
}

const READY = { type: 'canopy:trace-ready' } as const;

let snapshot: BridgeSnapshot = { visible: true };
const listeners = new Set<() => void>();
let everVisible = false;
const everVisibleListeners = new Set<() => void>();
let uninstallCurrent: (() => void) | null = null;

function publish(next: BridgeSnapshot): void {
  snapshot = next;
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): BridgeSnapshot {
  return snapshot;
}

/** Whether the host has sent `visible:true` at least once. Never resets. */
export function getEverVisible(): boolean {
  return everVisible;
}

/** Listen for the `everVisible` latch (called once, when it sets). */
export function subscribeEverVisible(listener: () => void): () => void {
  everVisibleListeners.add(listener);
  return () => {
    everVisibleListeners.delete(listener);
  };
}

function latchEverVisible(): void {
  if (everVisible) return;
  everVisible = true;
  for (const l of everVisibleListeners) l();
}

function applyVisibility(visible: boolean): void {
  if (visible === snapshot.visible) return;
  if (visible) {
    const { mode } = snapshot;
    publish(mode === undefined ? { visible: true } : { visible: true, mode });
  } else {
    publish({ ...snapshot, visible: false, hiddenAt: Date.now() });
  }
}

function applyTheme(mode: ColorMode, theme?: unknown): void {
  // The store is updated before the snapshot check: a host theme change that
  // keeps the mode (desy-dark -> retro-dark) must still reach it.
  const id = typeof theme === 'string' && HOST_THEME_ID.test(theme) ? theme : null;
  setHostTheme(id, mode);
  if (mode === snapshot.mode) return;
  publish({ ...snapshot, mode });
}

function onMessage(event: MessageEvent): void {
  if (event.source !== window.parent || event.origin !== window.location.origin) return;
  const data: unknown = event.data;
  if (typeof data !== 'object' || data === null) return;
  const msg = data as Record<string, unknown>;
  if (msg.type === 'canopy:trace-visibility') {
    if (typeof msg.visible === 'boolean') {
      applyVisibility(msg.visible);
      if (msg.visible) latchEverVisible();
    }
  } else if (msg.type === 'canopy:trace-theme') {
    if (msg.mode === 'light' || msg.mode === 'dark') applyTheme(msg.mode, msg.theme);
  }
}

/**
 * Install the listener and announce readiness to the parent. A no-op when not
 * embedded; idempotent when embedded. Returns a function that removes it.
 */
export function installBridge(): () => void {
  if (!isEmbedded()) return () => {};
  if (uninstallCurrent) return uninstallCurrent;
  window.addEventListener('message', onMessage);
  const uninstall = () => {
    window.removeEventListener('message', onMessage);
    if (uninstallCurrent === uninstall) uninstallCurrent = null;
  };
  uninstallCurrent = uninstall;
  window.parent.postMessage(READY, window.location.origin);
  return uninstall;
}
