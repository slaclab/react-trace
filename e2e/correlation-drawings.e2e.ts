// Correlation's drawing tools in a real browser against the built page, embedded (`embedded=true`), so the page
// writes its state, drawings included, back into its own URL as `ann=`.
//
// What is asserted, and why it matters:
//
//   * each of the six Correlation tools (H-line, V-line, trend, box, note,
//     measure) is placed from the rail, reshaped by a handle, deleted, brought
//     back by primary+Z, and restored by a reload through `ann=`: every tool
//     must round-trip its own geometry through the link;
//   * an edit in a drawing's card (a box's Colour) is undone by primary+Z
//     with focus still in the sidebar: the undo key is bound on the document;
//   * the Measure card reads the owning Y's points inside the box: `n` and
//     `mean` match what the fixed frame puts there;
//   * split layout: one overlay per Y grid; a drawing is drawn in the grid it
//     was placed in, named by that grid's Y in the link, and in no other grid;
//     the rail stays in view while the stage scrolls the panels;
//   * shared layout: a box drawn from one of Y2's points belongs to Y2, so it
//     stays on screen when Y1 is hidden;
//   * a Y hidden, removed and re-added hides its drawing (its card head dimmed
//     with the reason) and brings it back: drawings survive their Y;
//   * switching X hides the drawings placed against the old X ("x source
//     changed") but not an H-line, and switching back restores them;
//   * link overflow: past the 4 KB budget the status line says so; note
//     texts are cut first and no drawing is dropped while that is enough; past
//     that a drawing is dropped from the end, and the link, reloaded, opens
//     with exactly the drawings it carries;
//   * Export PNG composes the overlay: the image with the drawings carries the
//     box's off-palette colour, the one with Hide all on does not.
//
// The Formula Engine double is spec-local: it answers every table subscribe (removing or
// adding an X or Y resubscribes), with a fixed 16-row frame: column `x` is
// `i`, the k-th Y column `i * (k + 1)` (so Y1 = 2i, Y2 = 3i, ...). The page is
// embedded, so it subscribes only once the host posts `canopy:trace-visibility`,
// which every load (reload included) re-posts.

import { readFile } from 'node:fs/promises';

import { expect, test, type Locator, type Page, type WebSocketRoute } from '@playwright/test';

import { FORMULA_ENGINE_PATH, mockHare, mockMole, pathEndsWith } from './mocks';
import { readoutTerms } from './readout';
import { drawingCard, openCard, panel, swatchHex, waitForWorkbench } from './workbench';

const VIEWPORT = { width: 1280, height: 800 };
const PV_X = 'CORR:X';
const PV_X2 = 'CORR:X2';
const PV_Y1 = 'CORR:Y1';
const PV_Y2 = 'CORR:Y2';
const ROWS = 16;
/** Off the drawing palette, so the link keeps it and the PNG check can find it. */
const EDITED_COLOUR = '#123456';
const COLOUR_TOLERANCE = 6;
const MIN_BOX_PIXELS = 200;
/** The link budget (MAX_QUERY_BYTES) less the page keys' reserve (PAGE_KEY_RESERVE). */
const LINK_BUDGET = 4096 - 'embedded=true&theme=light&'.length;
/** A note's text in the link once cut: NOTE_TRIM_POINTS code points plus '…'. */
const NOTE_TRIM_POINTS = 24;
/** The longest drawing text (MAX_ANNOTATION_TEXT). */
const MAX_TEXT = 200;

test.use({ viewport: VIEWPORT });
test.describe.configure({ timeout: 90_000 });

// ── Formula Engine double ──────────────────────────────────────────────────────────────

interface FormulaEngineMessage {
  type: string;
  spec?: { kind?: string; columns?: Record<string, string>; bindings?: Record<string, string> };
}

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

/** Answers every table subscribe with `subscribed` and one frame. */
async function answerFormulaEngine(page: Page): Promise<void> {
  let counter = 0;
  await page.routeWebSocket(pathEndsWith(FORMULA_ENGINE_PATH), (ws: WebSocketRoute) => {
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as FormulaEngineMessage;
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

// ── The page ────────────────────────────────────────────────────────────────

interface PageOptions {
  x?: string;
  ys?: string[];
  axes?: 'shared' | 'overlay' | 'split';
  /** An `ann=` value, already encoded (see `encodeAnn`). */
  ann?: string;
}

/**
 * The embedded page's query, keys in the serializer's order, so a page that
 * has written nothing back yet already shows what it would write.
 */
function pageQuery({ x = PV_X, ys = [PV_Y1, PV_Y2], axes, ann }: PageOptions = {}): string {
  const parts = [`x=${x}`, ...ys.map((y) => `y=${y}`), 'dt=1', 'n=1000', 'lookback=1h'];
  parts.push('view=scatter');
  if (axes !== undefined && axes !== 'shared') parts.push(`axes=${axes}`);
  if (ann !== undefined) parts.push(`ann=${ann}`);
  return parts.join('&');
}

/** `JSON` as the link writes it (config.ts `encodeJsonParam`). */
function encodeAnn(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value)).replace(/%(3A|2C|5B|5D|7B|7D)/gi, (m) =>
    decodeURIComponent(m)
  );
}

const byteLength = (s: string) => Buffer.byteLength(s, 'utf8');

/** Installs the backend doubles: 503 for anything unmocked, Hare, Mole, the Formula Engine double. */
async function installBackend(page: Page): Promise<void> {
  await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
  await mockHare(page);
  await mockMole(page);
  await answerFormulaEngine(page);
}

/** As the host does: shows the page, which then subscribes; waits for the plot and an overlay. */
async function showPage(page: Page): Promise<void> {
  await waitForWorkbench(page);
  await page.evaluate(() =>
    window.postMessage({ type: 'canopy:trace-visibility', visible: true }, location.origin)
  );
  await expect(page.locator('.correlation-plot__chart')).toBeVisible();
  await waitForPlotted(page);
}

/**
 * Waits until the overlay can take a gesture: the chart has drawn the frame
 * (Plot.tsx `RENDERED_MARK`, on with `bench=1`), the first overlay's box has stopped moving, and
 * a pointer over its centre reads a value in the status line, which it does
 * only once the grid's scales are laid out over the frame's points.
 */
async function waitForPlotted(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => performance.getEntriesByName('corr:rendered').length))
    .toBeGreaterThan(0);
  const layer = page.locator('svg[data-annotation-layer]').first();
  await expect(layer).toBeAttached();
  let last = '';
  await expect
    .poll(async () => {
      const box = JSON.stringify(await layer.boundingBox());
      const same = box === last;
      last = box;
      return same;
    })
    .toBe(true);
  const value = page.locator('[data-status-line] [data-status-value]').first();
  await expect
    .poll(async () => {
      const box = await layer.boundingBox();
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      return (await value.textContent())?.trim() ?? '';
    })
    .toMatch(/\d/);
  await parkPointer(page);
}

/** Installs the doubles, opens the page. */
async function openPage(page: Page, options: PageOptions = {}): Promise<void> {
  await installBackend(page);
  await page.goto(`/correlation.html?embedded=true&bench=1&${pageQuery(options)}`);
  await showPage(page);
}

async function reloadPage(page: Page): Promise<void> {
  await page.reload();
  await showPage(page);
}

// ── The link ────────────────────────────────────────────────────────────────

type Tuple = [number, number[], number, number | null, string?, string?, string?, number?];

interface AnnValue {
  r: string[];
  b: { x: string }[];
  d: Tuple[];
}

/** The URL's `ann=` value, or null when it has none. */
function urlAnn(page: Page): AnnValue | null {
  const raw = new URL(page.url()).searchParams.get('ann');
  return raw === null ? null : (JSON.parse(raw) as AnnValue);
}

/** Polls until the URL's `ann=` carries `count` drawings, then returns it. */
async function waitForAnn(page: Page, count: number): Promise<AnnValue> {
  await expect
    .poll(() => urlAnn(page)?.d.length ?? 0, { timeout: 10_000, message: `ann= with ${count}` })
    .toBe(count);
  return urlAnn(page)!;
}

/** Polls until the URL's first drawing's points differ from `before`, then returns them. */
async function waitForPointsChange(page: Page, before: number[]): Promise<number[]> {
  await expect
    .poll(() => JSON.stringify(urlAnn(page)?.d[0]?.[1] ?? null), { timeout: 10_000 })
    .not.toBe(JSON.stringify(before));
  return urlAnn(page)!.d[0][1];
}

/** The search part of the URL, without '?' and without the page keys, in bytes. */
function linkBytes(page: Page): number {
  const search = new URL(page.url()).search.slice(1);
  return byteLength(search.replace(/(^|&)embedded=true(?=&|$)/, '').replace(/^&/, ''));
}

// ── Locators and gestures ───────────────────────────────────────────────────

const layers = (page: Page) => page.locator('svg[data-annotation-layer]');
const drawings = (page: Page, kind?: string) =>
  page.locator(kind === undefined ? '[data-annotation-kind]' : `[data-annotation-kind="${kind}"]`);
const rail = (page: Page) => page.locator('[data-drawing-rail]');
const drawingRows = (page: Page) =>
  panel(page).locator('.wb-outline-row[data-section="annotations"]');
const yRow = (page: Page, pv: string) => page.locator(`.wb-outline-row[data-row-id="y:${pv}"]`);
const xRow = (page: Page, pv: string) => page.locator(`.wb-outline-row[data-row-id="x:${pv}"]`);
const shedNotice = (page: Page) => page.locator('[data-status-shed-notice]');

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The i-th grid's overlay box, in page px. */
async function gridBox(page: Page, i = 0): Promise<Box> {
  const layer = layers(page).nth(i);
  await expect(layer).toBeAttached();
  const box = await layer.boundingBox();
  if (!box || box.width < 50 || box.height < 50) throw new Error(`grid ${i} has no box`);
  return box;
}

/** A point at fractions (fx, fy) of `grid`. */
const at = (grid: Box, fx: number, fy: number) => ({
  x: grid.x + grid.width * fx,
  y: grid.y + grid.height * fy,
});

async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(VIEWPORT.width - 4, 4);
}

/** Arms a rail tool; asserts it shows pressed. */
async function arm(page: Page, kind: string): Promise<void> {
  const tool = rail(page).locator(`[data-drawing-tool="${kind}"]`);
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
}

async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number }
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

/** One-point tools commit on a click, two-point tools on a drag. */
const ONE_POINT = new Set(['hline', 'vline', 'note']);

/**
 * Places a `kind` drawing in `grid` from the rail, between fractions `a` and
 * `b` (a one-point tool uses `a`); a note gets `text`, typed in place.
 */
async function place(
  page: Page,
  kind: string,
  grid: Box,
  a: [number, number],
  b: [number, number] = [a[0] + 0.3, a[1] - 0.3],
  text = 'probe'
): Promise<void> {
  const before = await drawings(page, kind).count();
  await arm(page, kind);
  if (ONE_POINT.has(kind)) {
    const p = at(grid, ...a);
    await page.mouse.click(p.x, p.y);
  } else {
    await drag(page, at(grid, ...a), at(grid, ...b));
  }
  if (kind === 'note') {
    const editor = page.locator('input[data-annotation-editor]');
    await expect(editor).toBeFocused();
    await editor.fill(text);
    await editor.press('Enter');
    await expect(editor).toHaveCount(0);
  }
  await expect(drawings(page, kind)).toHaveCount(before + 1);
  await parkPointer(page);
}

/**
 * Selects the drawing behind the card whose name matches by opening its card
 * (a click on an open card's head would close it, deselecting the drawing).
 */
async function selectRow(page: Page, name: RegExp): Promise<void> {
  await openCard(drawingCard(page, name));
}

// ── PNG export ──────────────────────────────────────────────────────────────

async function exportPng(page: Page): Promise<Buffer> {
  const download = page.waitForEvent('download');
  await page
    .getByTestId('actions-bar')
    .getByRole('button', { name: /^export png/i })
    .click();
  return readFile(await (await download).path());
}

/** Pixels of each PNG within tolerance of the edited colour, and the sizes. */
async function editedPixels(
  page: Page,
  a: Buffer,
  b: Buffer
): Promise<{ a: number; b: number; sameSize: boolean }> {
  return page.evaluate(
    async ([a64, b64, hex, tolerance]) => {
      const target = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      const decode = async (b64: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
      };
      const count = (d: ImageData) => {
        let n = 0;
        for (let i = 0; i < d.data.length; i += 4) {
          const dist =
            Math.abs(d.data[i] - target[0]) +
            Math.abs(d.data[i + 1] - target[1]) +
            Math.abs(d.data[i + 2] - target[2]);
          if (dist <= tolerance) n++;
        }
        return n;
      };
      const [da, db] = await Promise.all([decode(a64), decode(b64)]);
      return {
        a: count(da),
        b: count(db),
        sameSize: da.width === db.width && da.height === db.height,
      };
    },
    [a.toString('base64'), b.toString('base64'), EDITED_COLOUR, COLOUR_TOLERANCE] as const
  );
}

// ── Each tool ───────────────────────────────────────────────────────────────

/** The six tools, with their link code (CORRELATION_CATALOG) and card name. */
const TOOLS: { kind: string; code: number; row: RegExp; a: [number, number] }[] = [
  { kind: 'hline', code: 0, row: /^H-line/, a: [0.3, 0.4] },
  { kind: 'vline', code: 1, row: /^V-line/, a: [0.6, 0.5] },
  { kind: 'trend', code: 3, row: /^Trend/, a: [0.2, 0.7] },
  { kind: 'box', code: 4, row: /^Box/, a: [0.2, 0.7] },
  { kind: 'note', code: 5, row: /^Note/, a: [0.3, 0.6] },
  { kind: 'measure', code: 6, row: /^Measure/, a: [0.2, 0.7] },
];

for (const tool of TOOLS) {
  test(`${tool.kind}: place, reshape, delete, undo, restore through ann=`, async ({ page }) => {
    await openPage(page);
    const grid = await gridBox(page);

    // ── Place ───────────────────────────────────────────────────────────────
    await place(page, tool.kind, grid, tool.a);
    const placed = await waitForAnn(page, 1);
    expect(placed.d[0][0]).toBe(tool.code);
    const drawing = drawings(page, tool.kind);
    await expect(drawingRows(page)).toHaveCount(1);

    // ── Reshape: drag its first handle ──────────────────────────────────────
    await selectRow(page, tool.row);
    await expect(drawing).toHaveAttribute('data-annotation-selected', 'true');
    const handle = drawing.locator('[data-handle="0"]');
    const hb = await handle.boundingBox();
    if (!hb) throw new Error(`${tool.kind} has no handle`);
    const from = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
    await drag(page, from, { x: from.x + 60, y: from.y + 50 });
    const reshaped = await waitForPointsChange(page, placed.d[0][1]);
    expect(reshaped).toHaveLength(placed.d[0][1].length);

    // ── Delete, then undo ───────────────────────────────────────────────────
    await expect(drawing).toHaveAttribute('data-annotation-selected', 'true');
    await page.keyboard.press('Delete');
    await expect(drawing).toHaveCount(0);
    await expect(drawingRows(page)).toHaveCount(0);
    await expect.poll(() => urlAnn(page)?.d.length ?? 0, { timeout: 10_000 }).toBe(0);

    await page.keyboard.press('ControlOrMeta+z');
    await expect(drawing).toHaveCount(1);
    const restored = await waitForAnn(page, 1);
    expect(restored.d[0][1]).toEqual(reshaped);

    // ── Reload: the link restores it, reshaped ──────────────────────────────
    // Deselected, so its box is the drawing's alone (no handles, no outline).
    await page.keyboard.press('Escape');
    await expect(drawing).not.toHaveAttribute('data-annotation-selected', 'true');
    const shape = await drawing.boundingBox();
    if (!shape) throw new Error(`${tool.kind} has no box`);
    await reloadPage(page);
    await expect(drawing).toHaveCount(1);
    await expect(drawingRows(page)).toHaveCount(1);
    const reloaded = await drawing.boundingBox();
    if (!reloaded) throw new Error(`${tool.kind} has no box after the reload`);
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(reloaded[key] - shape[key]), key).toBeLessThanOrEqual(1);
    }
    if (tool.kind === 'note') {
      await expect(drawing.locator('[data-annotation-label]')).toHaveText('probe');
    }
  });
}

// ── Card edit and undo ─────────────────────────────────────────────────────

test('a card colour edit is undone by primary+Z with focus in the sidebar', async ({ page }) => {
  await openPage(page);
  const grid = await gridBox(page);
  await place(page, 'box', grid, [0.2, 0.7], [0.6, 0.3]);
  await place(page, 'hline', grid, [0.5, 0.2]);
  const boxes = drawings(page, 'box');

  await selectRow(page, /^Box/);
  await expect(boxes).toHaveAttribute('data-annotation-selected', 'true');
  await expect(drawingCard(page, /^Box/)).toHaveClass(/wb-card--open/);

  const colourField = drawingCard(page, /^Box/).locator('[data-field="annotation-color"]');
  const colour = colourField.locator('input[type="color"]');
  // A new drawing is in the theme's ink: what is drawn is what its swatch shows.
  const original = await swatchHex(colourField);
  expect(original).not.toBe(EDITED_COLOUR);
  const stroked = (hex: string) => boxes.locator(`[stroke="${hex}"]`);
  await expect(stroked(original)).not.toHaveCount(0);

  await colour.fill(EDITED_COLOUR);
  await expect(stroked(EDITED_COLOUR)).not.toHaveCount(0);
  await expect
    .poll(() => JSON.stringify(urlAnn(page)?.d ?? []), { timeout: 10_000 })
    .toContain(EDITED_COLOUR);

  expect(await page.evaluate(() => document.activeElement?.closest('.wb-sidebar') !== null)).toBe(
    true
  );
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => swatchHex(colourField)).toBe(original);
  await expect(stroked(EDITED_COLOUR)).toHaveCount(0);
  await expect(stroked(original)).not.toHaveCount(0);
  // One step only: both drawings are still there.
  await expect(boxes).toHaveCount(1);
  await expect(drawings(page, 'hline')).toHaveCount(1);
  await expect
    .poll(() => JSON.stringify(urlAnn(page)?.d ?? []), { timeout: 10_000 })
    .not.toContain(EDITED_COLOUR);
});

// ── Measure readout ─────────────────────────────────────────────────────────

test('the Measure card reads the owning Y’s points inside it', async ({ page }) => {
  await openPage(page);
  const grid = await gridBox(page);
  await place(page, 'measure', grid, [0.1, 0.9], [0.9, 0.1]);
  const ann = await waitForAnn(page, 1);
  const [x1, y1, x2, y2] = ann.d[0][1];
  // The owner is the first visible Y (no point within reach of the press): Y1 = 2i.
  expect(ann.r[ann.d[0][2]]).toBe(PV_Y1);
  const inside = Array.from({ length: ROWS }, (_, i) => i).filter((i) => {
    const v = 2 * i;
    return (
      i >= Math.min(x1, x2) &&
      i <= Math.max(x1, x2) &&
      v >= Math.min(y1, y2) &&
      v <= Math.max(y1, y2)
    );
  });
  expect(inside.length).toBeGreaterThan(2);
  const mean = inside.reduce((s, i) => s + 2 * i, 0) / inside.length;

  const card = drawings(page, 'measure').locator('[data-measure-card] text');
  // Two lines, as a figure prints them: `Δx = … Δy = … Δy/Δx = …`, then `n = … ȳ = … σ = …`.
  const lines = (await card.allTextContents()).map(readoutTerms);
  expect(lines.map((l) => Object.keys(l))).toEqual([
    ['Δx', 'Δy', 'Δy/Δx'],
    ['n', 'ȳ', 'σ'],
  ]);
  expect(lines[1].n).toBe(inside.length);
  expect(lines[1]['ȳ']).toBeCloseTo(mean, 2);
  expect(lines[0]['Δx']).toBeCloseTo(Math.abs(x2 - x1), 2);
  expect(lines[0]['Δy']).toBeCloseTo(Math.abs(y2 - y1), 2);
});

// ── Split layout ────────────────────────────────────────────────────────────

test('split layout: each drawing is drawn in its own grid; the rail stays in view', async ({
  page,
}) => {
  // Eight Ys: three rows of panels, taller than the stage, so it scrolls.
  const ys = Array.from({ length: 8 }, (_, i) => `CORR:Y${i + 1}`);
  await openPage(page, { ys, axes: 'split' });
  await expect(layers(page)).toHaveCount(ys.length);

  // A box in the first grid.
  const first = await gridBox(page, 0);
  await place(page, 'box', first, [0.2, 0.7], [0.6, 0.3]);
  let ann = await waitForAnn(page, 1);
  expect(ann.d[0][0]).toBe(4);
  expect(ann.r[ann.d[0][2]]).toBe(ys[0]);

  // An H-line in the last grid, scrolled into view first.
  const last = layers(page).nth(ys.length - 1);
  await last.scrollIntoViewIfNeeded();
  await place(page, 'hline', await gridBox(page, ys.length - 1), [0.5, 0.5]);
  ann = await waitForAnn(page, 2);
  // Kind codes (catalog): H-line 0, box 4.
  const hline = ann.d.find((t) => t[0] === 0)!;
  expect(ann.r[hline[2]]).toBe(ys[ys.length - 1]);

  // Each is drawn in its own grid only.
  for (let i = 0; i < ys.length; i++) {
    const layer = layers(page).nth(i);
    await expect(layer.locator('[data-annotation-kind="box"]')).toHaveCount(i === 0 ? 1 : 0);
    await expect(layer.locator('[data-annotation-kind="hline"]')).toHaveCount(
      i === ys.length - 1 ? 1 : 0
    );
  }

  // The stage scrolls the panels; the rail, outside the scroller, stays in view.
  const stage = page.locator('.correlation-plot__stage');
  const scroll = await stage.evaluate((el) => ({ h: el.scrollHeight, c: el.clientHeight }));
  expect(scroll.h).toBeGreaterThan(scroll.c);
  await stage.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(rail(page)).toBeInViewport();
  await stage.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(rail(page)).toBeInViewport();
  await expect(layers(page).nth(0).locator('[data-annotation-kind="box"]')).toHaveCount(1);
});

// ── Shared layout ───────────────────────────────────────────────────────────

/** The shared grid's pixel ↔ data map, read off a measure placed and undone. */
async function calibrate(page: Page, grid: Box) {
  await place(page, 'measure', grid, [0.2, 0.8], [0.8, 0.2]);
  const [x1, y1, x2, y2] = (await waitForAnn(page, 1)).d[0][1];
  await page.keyboard.press('ControlOrMeta+z');
  await expect(drawings(page)).toHaveCount(0);
  await expect.poll(() => urlAnn(page)?.d.length ?? 0, { timeout: 10_000 }).toBe(0);
  const fx = (x: number) => 0.2 + ((x - x1) / (x2 - x1)) * 0.6;
  const fy = (v: number) => 0.8 - ((v - y1) / (y2 - y1)) * 0.6;
  return (x: number, v: number): [number, number] => [fx(x), fy(v)];
}

test('shared layout: a box drawn around Y2’s points stays when Y1 is hidden', async ({ page }) => {
  await openPage(page);
  const grid = await gridBox(page);
  const toFraction = await calibrate(page, grid);

  // From Y2's point (10, 30) to past (12, 36); Y1 there is 20..24, outside.
  await place(page, 'box', grid, toFraction(10, 30), toFraction(12.5, 37.5));
  const ann = await waitForAnn(page, 1);
  expect(ann.r[ann.d[0][2]]).toBe(PV_Y2);

  await yRow(page, PV_Y1).locator('.wb-outline-row__eye button').click();
  await expect(yRow(page, PV_Y1).locator('.wb-outline-row__eye button')).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  await expect.poll(() => new URL(page.url()).searchParams.get('hide')).toBe('1');
  await expect(drawings(page, 'box')).toHaveCount(1);
  await expect(drawingRows(page).locator('.wb-outline-row__status--stale')).toHaveCount(0);
});

// ── Hiding, removing and re-adding a Y ──────────────────────────────────────

/** A drawing row's status title: its hidden reason when dimmed. */
const rowStatus = (page: Page) => drawingRows(page).first().locator('.wb-outline-row__status');

test('a Y hidden, removed and re-added hides its drawing and brings it back', async ({ page }) => {
  await openPage(page);
  const grid = await gridBox(page);
  const toFraction = await calibrate(page, grid);
  // From Y1's point (4, 8): the box belongs to Y1.
  await place(page, 'box', grid, toFraction(4, 8), toFraction(7, 16));
  const ann = await waitForAnn(page, 1);
  expect(ann.r[ann.d[0][2]]).toBe(PV_Y1);
  const box = drawings(page, 'box');

  // ── Hide Y1 ─────────────────────────────────────────────────────────────
  const eye = yRow(page, PV_Y1).locator('.wb-outline-row__eye button');
  await eye.click();
  await expect(box).toHaveCount(0);
  await expect(drawingRows(page)).toHaveCount(1);
  await expect(rowStatus(page)).toHaveClass(/wb-outline-row__status--stale/);
  await expect(rowStatus(page)).toHaveAttribute('title', /series hidden/);
  await eye.click();
  await expect(box).toHaveCount(1);
  await expect(rowStatus(page)).not.toHaveClass(/wb-outline-row__status--stale/);

  // ── Remove Y1 ───────────────────────────────────────────────────────────
  await yRow(page, PV_Y1).locator('.wb-outline-row__remove').click();
  await expect(yRow(page, PV_Y1)).toHaveCount(0);
  await expect(box).toHaveCount(0);
  await expect(drawingRows(page)).toHaveCount(1);
  await expect(rowStatus(page)).toHaveAttribute('title', /series removed/);
  // The link keeps it, named by its Y.
  await expect.poll(() => urlAnn(page)?.r ?? [], { timeout: 10_000 }).toContain(PV_Y1);

  // ── Re-add Y1 ───────────────────────────────────────────────────────────
  const add = page.locator('.wb-outline-add[data-section="y"] input');
  await add.fill(PV_Y1);
  await add.press('Enter');
  await expect(yRow(page, PV_Y1)).toHaveCount(1);
  await expect(box).toHaveCount(1);
  await expect(rowStatus(page)).not.toHaveClass(/wb-outline-row__status--stale/);
});

// ── Switching X ─────────────────────────────────────────────────────────────

async function switchX(page: Page, from: string, to: string): Promise<void> {
  await xRow(page, from).locator('.wb-outline-row__remove').click();
  await expect(xRow(page, from)).toHaveCount(0);
  const add = page.locator('.wb-outline-add[data-section="x"] input');
  await add.fill(to);
  await add.press('Enter');
  await expect(xRow(page, to)).toHaveCount(1);
  await expect(page.locator('.correlation-plot__chart')).toBeVisible();
}

test('switching X hides the drawings placed against the old X, switching back restores them', async ({
  page,
}) => {
  await openPage(page);
  const grid = await gridBox(page);
  await place(page, 'box', grid, [0.2, 0.7], [0.6, 0.3]);
  await place(page, 'hline', grid, [0.5, 0.2]);
  const ann = await waitForAnn(page, 2);
  expect(ann.b.map((b) => b.x)).toEqual([PV_X]);
  const box = drawings(page, 'box');
  const hline = drawings(page, 'hline');
  const boxRow = drawingRows(page).filter({
    has: page.locator('.wb-outline-row__name', { hasText: /^Box/ }),
  });

  await switchX(page, PV_X, PV_X2);
  await expect(box).toHaveCount(0);
  await expect(hline).toHaveCount(1);
  await expect(boxRow.locator('.wb-outline-row__status')).toHaveAttribute(
    'title',
    /x source changed/
  );

  await switchX(page, PV_X2, PV_X);
  await expect(box).toHaveCount(1);
  await expect(hline).toHaveCount(1);
  await expect(boxRow.locator('.wb-outline-row__status')).not.toHaveClass(
    /wb-outline-row__status--stale/
  );
});

// ── Link overflow ───────────────────────────────────────────────────────────

test('link overflow: notes are cut first, then drawings dropped; the link reloads as reported', async ({
  page,
}) => {
  // A seed link just under the budget: one long note, and a second Y whose
  // long name (never shed before the drawings) takes up the rest.
  const longNote = 'a'.repeat(MAX_TEXT);
  const seedAnn = encodeAnn({
    r: [PV_Y1],
    b: [{ x: PV_X }],
    d: [[5, [4.5, 20], 0, null, '', longNote, '', 0]],
  });
  const target = LINK_BUDGET - 70;
  const bare = byteLength(pageQuery({ ys: [PV_Y1, 'CORR:P'], ann: seedAnn }));
  const pad = `CORR:P${'p'.repeat(target - bare)}`;
  const options = { ys: [PV_Y1, pad], ann: seedAnn };
  expect(byteLength(pageQuery(options))).toBe(target);

  await openPage(page, options);
  await expect(drawings(page, 'note')).toHaveCount(1);
  await expect(shedNotice(page)).toHaveCount(0);
  const grid = await gridBox(page);

  // ── A second long note: over budget, and cutting the notes is enough ────
  await place(page, 'note', grid, [0.6, 0.3], undefined, 'b'.repeat(MAX_TEXT));
  await expect(shedNotice(page)).toHaveText('Note text shortened in the link');
  const cut = await waitForAnn(page, 2);
  for (const tuple of cut.d) {
    expect([...tuple[5]!]).toHaveLength(NOTE_TRIM_POINTS + 1);
    expect(tuple[5]!.endsWith('…')).toBe(true);
  }
  expect(linkBytes(page)).toBeLessThanOrEqual(LINK_BUDGET);
  // The page still holds the full texts.
  await expect(drawings(page, 'note').first().locator('[data-annotation-label]')).not.toHaveText(
    cut.d[0][5]!
  );

  // ── A box with a long label: cutting is no longer enough ────────────────
  await place(page, 'box', grid, [0.1, 0.9], [0.3, 0.7]);
  await selectRow(page, /^Box/);
  const label = drawingCard(page, /^Box/).locator('[data-field="annotation-label"] input');
  await label.fill('c'.repeat(MAX_TEXT));
  await label.press('Enter');
  await expect(shedNotice(page)).toHaveText('1 drawing not saved in the link');
  const dropped = await waitForAnn(page, 2);
  // The box, last, was dropped; the notes it kept had their text shortened first.
  expect(dropped.d.map((t) => t[0])).toEqual([5, 5]);
  for (const tuple of dropped.d) {
    expect([...(tuple[5] ?? '')].length).toBeLessThanOrEqual(NOTE_TRIM_POINTS + 1);
  }
  expect(linkBytes(page)).toBeLessThanOrEqual(LINK_BUDGET);
  await expect(drawings(page)).toHaveCount(3);

  // ── Reload the link: exactly the drawings it carried ────────────────────
  await reloadPage(page);
  await expect(drawings(page, 'note')).toHaveCount(2);
  await expect(drawings(page, 'box')).toHaveCount(0);
  await expect(drawingRows(page)).toHaveCount(2);
});

// ── PNG export ──────────────────────────────────────────────────────────────

test('Export PNG composes the overlay, and leaves it out with Hide all on', async ({ page }) => {
  await openPage(page);
  const grid = await gridBox(page);
  await place(page, 'box', grid, [0.2, 0.8], [0.7, 0.2]);
  await selectRow(page, /^Box/);
  const colour = drawingCard(page, /^Box/).locator(
    '[data-field="annotation-color"] input[type="color"]'
  );
  await colour.fill(EDITED_COLOUR);
  const box: Locator = drawings(page, 'box');
  await expect(box.locator(`[stroke="${EDITED_COLOUR}"]`)).not.toHaveCount(0);
  // Deselect, so the capture shows the drawing, not its selection outline.
  await page.keyboard.press('Escape');

  await parkPointer(page);
  const shown = await exportPng(page);

  const hide = rail(page).locator('[data-drawing-toggle="hide"]');
  await hide.click();
  await expect(hide).toHaveAttribute('aria-pressed', 'true');
  await expect(box).toHaveCount(0);
  await parkPointer(page);
  const hidden = await exportPng(page);

  expect(shown.equals(hidden)).toBe(false);
  const report = await editedPixels(page, shown, hidden);
  expect(report.sameSize).toBe(true);
  expect(report.a).toBeGreaterThan(MIN_BOX_PIXELS);
  expect(report.b * 10).toBeLessThan(report.a);

  await hide.click();
  await expect(hide).toHaveAttribute('aria-pressed', 'false');
  await expect(box).toHaveCount(1);
});
