// A stand-in for a host that frames a tool and draws its tile bar, built
// from one route: `vite preview` serves only `dist/`, so the host page is
// answered by `page.route` on the tools' own origin, which keeps the frame
// same-origin exactly as a real host's is.
//
// The host page (`HOST_PATH?src=<tool url>`) holds one iframe and:
//   - records every message the frame posts it (`event.source` is the frame,
//     `event.origin` our own), in order: `canopy:tool-actions`,
//     `canopy:save-view`, and the bridge's own `canopy:trace-ready`;
//   - answers `canopy:trace-ready` with `{type: 'canopy:trace-visibility',
//     visible: true}`, as a host does for a shown tab, so a tool that waits
//     for its host to show it (Correlation's Formula Engine subscription) starts;
//   - posts any message into the frame at `location.origin` on request, which
//     is how a spec sends `canopy:tool-invoke`.
//
// The tool URL is the spec's: `embedded=true&hostbar=1` puts the tool under
// the host bar, `embedded=true` alone keeps it a plain embedded page.

import { expect, type Frame, type FrameLocator, type Page } from '@playwright/test';

/** Where the host page is answered; no file of the build lives there. */
export const HOST_PATH = '/__e2e/host-bar.html';

export const TOOL_ACTIONS = 'canopy:tool-actions';
export const TOOL_INVOKE = 'canopy:tool-invoke';
export const SAVE_VIEW = 'canopy:save-view';

/** One `canopy:tool-actions` entry as the tool reports it. */
export interface ToolActionEntry {
  id: string;
  label: string;
  kind: 'button' | 'toggle';
  pressed?: boolean;
  disabled?: false | string;
  shortcut?: string;
  /** A Carbon icon component name. */
  icon?: string;
  placement: 'bar' | 'menu';
}

/** The `canopy:tool-actions` payload. */
export interface ToolActionsMessage {
  type: typeof TOOL_ACTIONS;
  version: number;
  state?: string;
  actions: ToolActionEntry[];
  links: { docs?: string; bug?: string };
}

/** A message the frame posted to the host. */
export interface HostMessage {
  type?: string;
  [key: string]: unknown;
}

const HOST_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>host bar</title>
    <style>
      html, body { margin: 0; height: 100%; }
      iframe { display: block; border: 0; width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <iframe id="tool" title="tool"></iframe>
    <script>
      const frame = document.getElementById('tool');
      window.__hostMessages = [];
      window.addEventListener('message', (event) => {
        if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
        window.__hostMessages.push(event.data);
        if (event.data && event.data.type === 'canopy:trace-ready') {
          frame.contentWindow.postMessage(
            { type: 'canopy:trace-visibility', visible: true },
            location.origin
          );
        }
      });
      window.__hostPost = (message) => frame.contentWindow.postMessage(message, location.origin);
      frame.src = new URLSearchParams(location.search).get('src');
    </script>
  </body>
</html>
`;

/**
 * Answers `HOST_PATH` with the host page, and stubs `window.print` in
 * every document (the frame included) so Print is counted, not opened.
 * Call before `openInHost`.
 */
export async function installHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __prints: number };
    w.__prints = 0;
    window.print = () => {
      w.__prints += 1;
    };
  });
  await page.route(
    (url) => url.pathname === HOST_PATH,
    (route) => route.fulfill({ status: 200, contentType: 'text/html', body: HOST_HTML })
  );
}

export interface HostedTool {
  /** Locators inside the tool frame. */
  frame: FrameLocator;
  /** The tool frame itself, for `evaluate`. */
  content: Frame;
}

/** Opens the host page framing `toolPath` and resolves once the frame has loaded. */
export async function openInHost(page: Page, toolPath: string): Promise<HostedTool> {
  await page.goto(`${HOST_PATH}?src=${encodeURIComponent(toolPath)}`);
  const handle = await page.locator('#tool').elementHandle();
  const content = await handle?.contentFrame();
  if (!content) throw new Error('hostBar: the tool iframe has no frame');
  await content.waitForLoadState('load');
  return { frame: page.frameLocator('#tool'), content };
}

/** Every message the frame has posted so far, in order. */
export async function hostMessages(page: Page): Promise<HostMessage[]> {
  return page.evaluate(
    () => (window as unknown as { __hostMessages: HostMessage[] }).__hostMessages
  );
}

/** The messages of one type the frame has posted so far. */
export async function messagesOfType(page: Page, type: string): Promise<HostMessage[]> {
  return (await hostMessages(page)).filter((m) => m?.type === type);
}

/** The last `canopy:tool-actions` payload, or null when none was posted. */
export async function lastToolActions(page: Page): Promise<ToolActionsMessage | null> {
  const all = await messagesOfType(page, TOOL_ACTIONS);
  return (all.at(-1) as ToolActionsMessage | undefined) ?? null;
}

/** Waits for a `canopy:tool-actions` payload satisfying `check` and returns it. */
export async function waitForToolActions(
  page: Page,
  check: (message: ToolActionsMessage) => boolean = () => true,
  message = 'a matching canopy:tool-actions report'
): Promise<ToolActionsMessage> {
  await expect
    .poll(
      async () => {
        const last = await lastToolActions(page);
        return last !== null && check(last) ? true : JSON.stringify(last);
      },
      { message }
    )
    .toBe(true);
  return (await lastToolActions(page))!;
}

/** Posts `message` from the host into the tool frame (same origin, as a real host does). */
export async function postToTool(page: Page, message: unknown): Promise<void> {
  await page.evaluate((m) => {
    (window as unknown as { __hostPost: (m: unknown) => void }).__hostPost(m);
  }, message);
}

/** Posts `canopy:tool-invoke` for `id`. */
export async function invokeTool(page: Page, id: string): Promise<void> {
  await postToTool(page, { type: TOOL_INVOKE, id });
}

/** How many times the frame called `window.print`. */
export async function printCount(content: Frame): Promise<number> {
  return content.evaluate(() => (window as unknown as { __prints: number }).__prints);
}

/** Whether the frame binds the primary modifier to Cmd (macOS) or Ctrl. */
export async function primaryKey(content: Frame): Promise<'Meta' | 'Control'> {
  const mac = await content.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform));
  return mac ? 'Meta' : 'Control';
}
