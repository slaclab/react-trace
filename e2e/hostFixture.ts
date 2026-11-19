// An embedding host for Trace's specs, built from routes alone: `vite preview`
// stays untouched and the page sees what CANOPY's server emits when a host
// configures stylesheets.
//
// `installHost(page, ...)`, called before `page.goto`:
//   - rewrites every HTML document Trace serves (`/`, `*.html`): adds
//     `data-canopy-host` to `<html>` and appends the marked `<link>`s from the
//     shell's `links.html` (rendered with Trace's e2e prefix) as the last
//     children of `<head>`, then, fixture-only, a `<script type="module">`
//     marker. A module script runs after the entry module in document order
//     and, like it, only once no stylesheet blocks scripts, so
//     `window.__hostSheetLoadedAtModule` records whether every host sheet was
//     usable before any module ran. (A classic inline script would itself be
//     parser-blocked by the pending sheets and prove only its own ordering.)
//   - serves the host sheets: the shell's synthetic `host.css` set under
//     `/design-system/**`, with stand-in token and font sheets. The three
//     sheets answer after `SHEET_DELAY_MS`, so a tiny document's parse cannot
//     hide a missing wait.
//   - optionally breaks the adapter sheet (`canopy-host.css`): `404` and
//     `empty-200` leave no usable sheet, `wrong-major` declares contract 2.
//
// Routes registered later win: install this after a spec's backend doubles.
// It takes over document requests only and falls through for everything else.

import type { Page, Route } from '@playwright/test';

import { readShellFixture } from './hostProbes';

/** Trace's e2e pages are served at the origin root (`vite preview`). */
export const TRACE_PREFIX = '';

/** How long each host sheet is held before it is answered. */
export const SHEET_DELAY_MS = 500;

export type HostScenario = '404' | 'empty-200' | 'wrong-major';

export interface InstallHostOptions {
  /** Breaks `canopy-host.css` in the named way. */
  scenario?: HostScenario;
  /** Path prefix the pages are served under; Trace's own e2e uses none. */
  prefix?: string;
}

const MARKER_SCRIPT =
  '<script type="module">window.__hostSheetLoadedAtModule = ' +
  "[...document.querySelectorAll('link[data-canopy-host-sheet]')].every((l) => { " +
  'try { return l.sheet !== null && l.sheet.cssRules.length > 0; } catch { return false; } ' +
  '});</script>';

const TOKENS_PATH = '/design-system/css/tokens.css';
const FONTS_PATH = '/static/fonts/fonts.css';
const ADAPTER_PATH = '/design-system/css/canopy-host.css';

/**
 * Stand-ins for a host's token and font sheets. Each carries a rule:
 * a sheet with none counts as failed to load, and the host attribute would be
 * dropped.
 */
const SYNTHETIC_TOKENS =
  ':root, [data-theme="dark"] { color-scheme: dark; }\n' +
  '[data-theme="light"] { color-scheme: light; }\n';
const SYNTHETIC_FONTS = ':root { --canopy-fixture-host-fonts: none; }\n';

const CONTRACT_V1 = /--canopy-host-contract:\s*1\b/g;

/** The rendered `<link>` block a host emits for the given prefix. */
export function hostLinks(prefix: string = TRACE_PREFIX): string {
  return readShellFixture('links.html').replaceAll('{prefix}', prefix).trim();
}

/** The document with the host attribute, links and marker added, as CANOPY's server emits it. */
export function injectHost(html: string, prefix: string = TRACE_PREFIX): string {
  const open = /<html\b[^>]*>/i.exec(html);
  const close = html.search(/<\/head>/i);
  if (!open || close < 0) throw new Error('hostFixture: document has no <html> or </head>');
  const openEnd = open.index + open[0].length - 1;
  const withAttr = `${html.slice(0, openEnd)} data-canopy-host${html.slice(openEnd)}`;
  const at = close + ' data-canopy-host'.length;
  const block = `${hostLinks(prefix)}\n${MARKER_SCRIPT}\n`;
  return `${withAttr.slice(0, at)}${block}${withAttr.slice(at)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export async function installHost(page: Page, options: InstallHostOptions = {}): Promise<void> {
  const prefix = options.prefix ?? TRACE_PREFIX;
  const { scenario } = options;
  const dsBase = `${prefix}/design-system/`;
  const fontsBase = `${prefix}/static/fonts/`;
  const sheetPaths = new Set([TOKENS_PATH, FONTS_PATH, ADAPTER_PATH].map((p) => prefix + p));
  const hostCss = readShellFixture('host.css');

  /** The synthetic sheet at `path`; null when there is none. */
  const asset = (path: string): string | null => {
    if (path === prefix + TOKENS_PATH) return SYNTHETIC_TOKENS;
    if (path === prefix + FONTS_PATH) return SYNTHETIC_FONTS;
    if (path === prefix + ADAPTER_PATH) return hostCss;
    return null;
  };

  const serveAsset = async (route: Route): Promise<void> => {
    const path = new URL(route.request().url()).pathname;
    if (sheetPaths.has(path)) await delay(SHEET_DELAY_MS);
    const adapter = path === prefix + ADAPTER_PATH;
    if (adapter && scenario === '404') {
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' });
    }
    if (adapter && scenario === 'empty-200') {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    }
    const css = asset(path);
    if (css === null) return route.fulfill({ status: 404, contentType: 'text/plain', body: '' });
    if (adapter && scenario === 'wrong-major') {
      const wrong = css.replace(CONTRACT_V1, '--canopy-host-contract: 2');
      if (wrong === css) throw new Error('hostFixture: the adapter declares no contract 1');
      return route.fulfill({ status: 200, contentType: 'text/css', body: wrong });
    }
    return route.fulfill({ status: 200, contentType: 'text/css', body: css });
  };

  await page.route(
    (url) => url.pathname.startsWith(dsBase) || url.pathname.startsWith(fontsBase),
    serveAsset
  );

  await page.route(
    (url) => url.pathname === `${prefix}/` || url.pathname.endsWith('.html'),
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const response = await route.fetch();
      const html = await response.text();
      return route.fulfill({ response, body: injectHost(html, prefix) });
    }
  );
}
