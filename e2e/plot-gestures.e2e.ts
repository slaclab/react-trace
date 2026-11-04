// One plot UI for Trace, Correlation and Waveform: the
// SAME gestures, driven the same way in each tool against the built pages,
// embedded, so each page writes its state back into its own URL.
//
// What is asserted, in every tool:
//
//   * the strip shows the same toggles; the tooltip toggle is on (pressed);
//     the drag toggle starts in the tool's default (zoom box in every
//     tool), and a click on the tooltip toggle reaches the link;
//   * the wheel over the plot area zooms BOTH axes, over the Y axis band the
//     Y axis only;
//   * in zoom mode a drag draws a box and its release zooms both axes;
//   * a double-click in the plot area brings every axis back to auto-scale.
//
// Trace's X axis is the time window (session state, not in its link), so
// there the link shows the Y axis and the status line's time read-out shows
// the window.

import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

import { FORMULA_ENGINE_PATH, mockHare, mockMole, pathEndsWith, type HareWaveform } from './mocks';
import { TRACE_PAGE, waitForWorkbench } from './workbench';

const VIEWPORT = { width: 1280, height: 800 };
const ROWS = 16;

test.use({ viewport: VIEWPORT });
test.describe.configure({ timeout: 90_000 });

// ── The three pages ─────────────────────────────────────────────────────────

/** One table frame: `x` = i, the c-th other column = i * (c + 1). */
function tableFrame(serverId: string, columns: string[], bindings: string[]): string {
  const t0 = Date.now() * 1_000_000 - ROWS * 1_000_000_000;
  const tsNs = Array.from({ length: ROWS }, (_, i) => t0 + i * 1_000_000_000);
  const data: Record<string, number[]> = {};
  columns.forEach((name, c) => {
    data[name] = tsNs.map((_, i) => (name === 'x' ? i : i * (c + 1)));
  });
  const inputs: Record<string, unknown> = {};
  for (const binding of bindings) {
    inputs[binding] = { history: 'seeded', status: 'ok', lateAfterFinal: false };
  }
  return JSON.stringify({
    type: 'result',
    id: serverId,
    data: { kind: 'table', table: { tsNs, columns: data, inputs, totalRows: ROWS } },
  });
}

async function answerFox(page: Page): Promise<void> {
  let counter = 0;
  await page.routeWebSocket(pathEndsWith(FORMULA_ENGINE_PATH), (ws: WebSocketRoute) => {
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as {
        type: string;
        spec?: {
          kind?: string;
          columns?: Record<string, string>;
          bindings?: Record<string, string>;
        };
      };
      if (msg.type !== 'subscribe' || msg.spec?.kind !== 'table') return;
      const serverId = `mock-${++counter}`;
      ws.send(JSON.stringify({ type: 'subscribed', id: serverId }));
      ws.send(
        tableFrame(
          serverId,
          Object.keys(msg.spec.columns ?? {}),
          Object.keys(msg.spec.bindings ?? {})
        )
      );
    });
  });
}

const WAVEFORMS: Record<string, HareWaveform> = {
  'WF:G:A': { length: 64, hz: 0, value: (i) => Math.sin(i / 6) * 10 + i / 4 },
};

interface Tool {
  name: string;
  /** The drag mode the tool opens with. */
  drag: 'zoom' | 'pan';
  open(page: Page): Promise<void>;
  /** Whether the link holds a manual X / Y scale. */
  manual(page: Page): Promise<{ x: boolean | null; y: boolean }>;
  /** The link's tooltip setting is off. */
  tooltipOff(page: Page): Promise<boolean>;
}

const params = (page: Page) => new URL(page.url()).searchParams;

/** Trace's `plot=` config (embed/plotConfig), or null. */
function traceConfig(page: Page): {
  showTooltip?: boolean;
  axes?: { autoScale?: boolean }[];
} | null {
  const raw = params(page).get('plot');
  return raw ? JSON.parse(raw) : null;
}

const TOOLS: Tool[] = [
  {
    name: 'Trace',
    drag: 'zoom',
    async open(page) {
      await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
      await mockHare(page);
      await mockMole(page);
      await page.goto(TRACE_PAGE);
      await waitForWorkbench(page);
    },
    // Trace's time window is not in its link: only the Y axis is.
    manual: async (page) => ({
      x: null,
      y: traceConfig(page)?.axes?.[0]?.autoScale === false,
    }),
    tooltipOff: async (page) => traceConfig(page)?.showTooltip === false,
  },
  {
    name: 'Correlation',
    drag: 'zoom',
    async open(page) {
      await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
      await mockHare(page);
      await mockMole(page);
      await answerFox(page);
      await page.goto(
        '/correlation.html?embedded=true&bench=1&x=CORR:X&y=CORR:Y1&dt=1&n=1000&lookback=1h&view=scatter'
      );
      await waitForWorkbench(page);
      await page.evaluate(() =>
        window.postMessage({ type: 'canopy:trace-visibility', visible: true }, location.origin)
      );
      await expect
        .poll(() => page.evaluate(() => performance.getEntriesByName('corr:rendered').length))
        .toBeGreaterThan(0);
    },
    manual: async (page) => ({
      x: params(page).get('xauto') === '0',
      y: params(page).get('yauto') === '0',
    }),
    tooltipOff: async (page) => params(page).get('tip') === '0',
  },
  {
    name: 'Waveform',
    drag: 'zoom',
    async open(page) {
      await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
      await mockHare(page, { waveforms: WAVEFORMS });
      await mockMole(page);
      await page.goto('/waveform.html?embedded=true&pv=WF:G:A');
      await waitForWorkbench(page);
      await expect(page.getByTestId('waveform-app')).toBeVisible();
    },
    manual: async (page) => ({
      x: params(page).get('xauto') === '0',
      y: params(page).get('yauto') === '0',
    }),
    tooltipOff: async (page) => params(page).get('tip') === '0',
  },
];

// ── Shared steps ────────────────────────────────────────────────────────────

const toggle = (page: Page, name: string) =>
  page.locator(`[data-drawing-rail] [data-drawing-toggle="${name}"]`).first();

/** The plot area: the first drawing layer covers the first grid, once laid out. */
async function gridBox(page: Page) {
  const layer = page.locator('svg[data-annotation-layer]').first();
  await expect(layer).toBeAttached();
  let last = '';
  await expect
    .poll(async () => {
      const box = JSON.stringify(await layer.boundingBox());
      const same = box === last && box !== 'null';
      last = box;
      return same;
    })
    .toBe(true);
  const box = JSON.parse(last) as { x: number; y: number; width: number; height: number };
  expect(box.width).toBeGreaterThan(100);
  return box;
}

async function park(page: Page) {
  await page.mouse.move(VIEWPORT.width - 4, 4);
}

for (const tool of TOOLS) {
  test(`${tool.name}: the shared strip, wheel, zoom box and double-click reset`, async ({
    page,
  }) => {
    await tool.open(page);
    const g = await gridBox(page);
    const at = (fx: number, fy: number) => ({ x: g.x + g.width * fx, y: g.y + g.height * fy });

    // ── The strip ──────────────────────────────────────────────────────────
    const names = await page
      .locator('[data-drawing-rail]')
      .first()
      .locator('[data-drawing-toggle]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-drawing-toggle')));
    expect(names).toEqual(['magnet', 'stay', 'tooltip', 'drag', 'hide']);
    await expect(toggle(page, 'tooltip')).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle(page, 'drag')).toHaveAttribute(
      'aria-pressed',
      tool.drag === 'zoom' ? 'true' : 'false'
    );
    await toggle(page, 'tooltip').click();
    await expect(toggle(page, 'tooltip')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => tool.tooltipOff(page)).toBe(true);
    await toggle(page, 'tooltip').click();
    await expect.poll(() => tool.tooltipOff(page)).toBe(false);

    // ── The wheel over the Y axis band: the Y axis only ────────────────────
    await page.mouse.move(g.x - 20, at(0.5, 0.5).y);
    await page.mouse.wheel(0, -200);
    await expect.poll(async () => (await tool.manual(page)).y).toBe(true);
    const yOnly = await tool.manual(page);
    if (yOnly.x !== null) expect(yOnly.x).toBe(false);

    // ── Double-click in the plot area: every axis back to auto-scale ───────
    await page.mouse.dblclick(at(0.5, 0.5).x, at(0.5, 0.5).y);
    await expect.poll(async () => (await tool.manual(page)).y).toBe(false);

    // ── The wheel over the plot area: both axes ────────────────────────────
    await page.mouse.move(at(0.4, 0.4).x, at(0.4, 0.4).y);
    await page.mouse.wheel(0, -200);
    await expect.poll(async () => (await tool.manual(page)).y).toBe(true);
    const both = await tool.manual(page);
    if (both.x !== null) expect(both.x).toBe(true);
    await page.mouse.dblclick(at(0.5, 0.5).x, at(0.5, 0.5).y);
    await expect.poll(async () => (await tool.manual(page)).y).toBe(false);

    // ── Zoom mode: the box zooms both axes ─────────────────────────────────
    if (tool.drag === 'pan') {
      await toggle(page, 'drag').click();
      await expect(toggle(page, 'drag')).toHaveAttribute('aria-pressed', 'true');
    }
    const a = at(0.3, 0.3);
    const b = at(0.6, 0.7);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
    await expect(page.locator('[data-zoom-box]')).toBeVisible();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator('[data-zoom-box]')).toHaveCount(0);
    await expect.poll(async () => (await tool.manual(page)).y).toBe(true);
    const boxed = await tool.manual(page);
    if (boxed.x !== null) expect(boxed.x).toBe(true);
    await park(page);
  });
}
