import {
  configureColorMode,
  getColorMode,
  syncDocumentColorMode,
} from '@slaclab/canopy-shell/color-mode';

/**
 * Trace's settings for the shared @slaclab/canopy-shell color-mode store. The
 * `trace.theme` key is the one trace's own store used, so existing users keep
 * their choice; dark stays the default.
 */
export const TRACE_COLOR_MODE = { storageKey: 'trace.theme', defaultMode: 'dark' } as const;

/**
 * Configure the store and mirror the stored mode onto <html> (`data-theme` and
 * the Carbon `cds--g10`/`cds--g100` class). Call once in main.tsx, before the
 * first render, so the page background is right before React mounts.
 */
export function setupColorMode(): void {
  configureColorMode(TRACE_COLOR_MODE);
  syncDocumentColorMode(getColorMode());
}
