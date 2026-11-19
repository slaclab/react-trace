import { useSyncExternalStore } from 'react';
import { HOST_THEME_ID, modeFromThemeId } from '@slaclab/canopy-shell';
import {
  configureColorMode,
  getColorMode,
  syncDocumentColorMode,
  type ColorMode,
} from '@slaclab/canopy-shell/color-mode';
import { isEmbedded } from '../embed/embedded';

/**
 * Trace's settings for the shared @slaclab/canopy-shell color-mode store. The
 * `trace.theme` key is the one trace's own store used, so existing users keep
 * their choice; dark stays the default.
 */
export const TRACE_COLOR_MODE = { storageKey: 'trace.theme', defaultMode: 'dark' } as const;

/**
 * Embedded (`?embedded=true`), the host owns the theme. The store then runs
 * under this key instead, which nothing persists across host messages: every
 * host theme clears it and becomes the store's default, so the host's mode
 * wins over a toggle made in between. The operator's standalone choice under
 * `trace.theme` is neither read nor overwritten.
 */
export const HOSTED_COLOR_MODE_KEY = 'trace.theme.hosted';

// The host's full theme id (e.g. `retro-dark`); null when it gave none.
let hostThemeId: string | null = null;
const hostListeners = new Set<() => void>();

function applyHostMode(mode: ColorMode): void {
  try {
    window.localStorage.removeItem(HOSTED_COLOR_MODE_KEY);
  } catch {
    // storage unavailable: nothing was stored either
  }
  configureColorMode({ storageKey: HOSTED_COLOR_MODE_KEY, defaultMode: mode });
}

/**
 * Configure the store and mirror the mode onto <html> (`data-theme` and the
 * Carbon `cds--g10`/`cds--g100` class). Call once before the first render, so
 * the page background is right before React mounts. Embedded, the initial
 * host theme comes from `?theme=` when it is a valid id; its mode follows the
 * shell's rule, and without one the mode is the default.
 */
export function setupColorMode(): void {
  if (isEmbedded()) {
    const param = new URLSearchParams(window.location.search).get('theme');
    // `RegExp.test` coerces its argument, so `null` would match as 'null'.
    hostThemeId = param !== null && HOST_THEME_ID.test(param) ? param : null;
    applyHostMode(hostThemeId ? modeFromThemeId(hostThemeId) : TRACE_COLOR_MODE.defaultMode);
  } else {
    hostThemeId = null;
    configureColorMode(TRACE_COLOR_MODE);
  }
  syncDocumentColorMode(getColorMode());
}

export function getHostThemeId(): string | null {
  return hostThemeId;
}

/**
 * Apply what the embedding host sent: its theme id (already validated, or
 * `null` when it sent none) and the mode. Id listeners hear only an id change;
 * the color-mode store publishes a mode change itself.
 */
export function setHostTheme(id: string | null, mode: ColorMode): void {
  const idChanged = id !== hostThemeId;
  hostThemeId = id;
  applyHostMode(mode);
  if (idChanged) for (const l of hostListeners) l();
}

export function subscribeHostThemeId(listener: () => void): () => void {
  hostListeners.add(listener);
  return () => {
    hostListeners.delete(listener);
  };
}

export function useHostThemeId(): string | null {
  return useSyncExternalStore(subscribeHostThemeId, getHostThemeId, getHostThemeId);
}
