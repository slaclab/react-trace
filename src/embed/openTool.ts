// Cross-tool open.
//
// One helper any tool uses to hand a query to another tool:
//
// - embedded (`?embedded=true`), it posts
//     {type: 'canopy:trace-open', tool: <registry id>, query: string}
//   to `window.parent`, same-origin; the workspace (TraceTab -> WorkspacePage)
//   decides whether and where that tool opens;
// - standalone, it opens the sibling page `<tool>.html?<query>` (resolved
//   against the current page) in a new browser tab.
//
// The query is passed through as given: the caller builds it in the target
// tool's own query format, with no leading "?".

import { isEmbedded } from './embedded';

export const TRACE_OPEN = 'canopy:trace-open';

export interface TraceOpenMessage {
  type: typeof TRACE_OPEN;
  /** The target tool's registry id, e.g. 'waveform'. */
  tool: string;
  /** The target tool's query, no leading "?". */
  query: string;
}

/** Each tool's page in the build; Trace is the index page. */
const TOOL_PAGES: Readonly<Record<string, string>> = { trace: 'index.html' };

/** The URL of `tool`'s sibling page carrying `query`, relative to `base`. */
export function siblingToolUrl(tool: string, query: string, base: string): string {
  const url = new URL(TOOL_PAGES[tool] ?? `${tool}.html`, base);
  url.search = query === '' ? '' : `?${query}`;
  return url.href;
}

/** Open `tool` with `query`: via the host when embedded, else in a new browser tab. */
export function openTool(tool: string, query: string): void {
  if (isEmbedded()) {
    const message: TraceOpenMessage = { type: TRACE_OPEN, tool, query };
    window.parent.postMessage(message, window.location.origin);
    return;
  }
  window.open(siblingToolUrl(tool, query, window.location.href), '_blank', 'noopener');
}
