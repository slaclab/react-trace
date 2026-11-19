// Trace's drawing tools in a real browser against the built page, with the shared Hare and Mole doubles: one plot, two PVs.
//
// What is asserted, and why it matters:
//
//   * an H-line and a box placed from the drawing rail land in the overlay as
//     `[data-annotation-kind="hline"]` and `="box"`;
//   * the box is selected through its card head, and a Colour edit in
//     its card restrokes it;
//   * primary+Z pressed while focus is still in the sidebar reverts that edit:
//     the undo key is bound on the document, not on the plot. There is
//     no redo key (the undo key rejects Shift), so the edit is redone the way a
//     user would, by making it again in the card;
//   * the drawings ride the embed URL: `plot=` gains `drawings` once the state
//     settles, and a reload restores both drawings with the edited colour. The
//     undo history is session-only, so primary+Z after the reload changes
//     nothing;
//   * Export PNG composes the drawings over the chart: the image taken with
//     them shown differs from the one taken with Hide all on, and only the
//     former carries the box's colour.
//
// The page opens on a fixed custom window, so nothing moves with the clock:
// the two exports differ by the drawings alone, and the reload redraws the
// same window. The edited colour is off the drawing palette, so the URL
// keeps it (a palette default is written as '').
//
// The archive double is spec-local (`mockMole` knows `SIM:TEST` only):
// `SIM:TEST` and `SIM:OTHER` answer with gently varying samples spread evenly
// over the requested window.

import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { FORMULA_ENGINE_PATH, MOLE_PV, mockHare, mockMole, pathEndsWith } from './mocks';
import { drawingCard, panel, swatchHex, waitForWorkbench } from './workbench';

const VIEWPORT = { width: 1280, height: 800 };
const OTHER_PV = 'SIM:OTHER';
const PVS = [MOLE_PV, OTHER_PV];
const FROM = '2026-01-01T10:00';
const TO = '2026-01-01T10:10';
const PAGE = `/?embedded=true&${PVS.map((pv) => `pv=${encodeURIComponent(pv)}`).join('&')}&range=custom&from=${FROM}&to=${TO}`;

/** Archive samples per answer, evenly inside the requested window. */
const SAMPLES = 60;
/** Off the drawing palette (chartTheme ANNOTATION_PALETTE), so the URL keeps it. */
const EDITED_COLOUR = '#123456';
/**
 * Summed per-channel distance within which a pixel counts as the edited
 * colour: the box's opaque stroke matches it to rounding, while antialiased
 * chart pixels can still land near it, so the check is relative.
 */
const COLOUR_TOLERANCE = 6;
/** Fewest edited-colour pixels the box's outline paints at pixel ratio 2. */
const MIN_BOX_PIXELS = 200;

test.use({ viewport: VIEWPORT });
test.describe.configure({ timeout: 90_000 });

/** Serves both PVs' archive data over whatever window is asked for. */
async function mockArchive(page: Page): Promise<void> {
  await page.route(
    (url) => /\/mole\/v1\/(data|metadata)\//.test(url.pathname),
    (route) => {
      const url = new URL(route.request().url());
      const [, resource, ...rest] = /\/mole\/v1\/(data|metadata)\/(.*)$/.exec(url.pathname)!;
      const pv = decodeURIComponent(rest.join('/'));
      if (!PVS.includes(pv)) return route.fallback();
      const archiver = url.searchParams.get('archiver') ?? 'mock';
      if (resource === 'metadata') {
        return route.fulfill({
          json: {
            pv,
            archiver,
            description: 'Mocked archive PV',
            units: 'mA',
            precision: 3,
            displayLow: null,
            displayHigh: null,
            alarmLow: null,
            alarmHigh: null,
            warningLow: null,
            warningHigh: null,
          },
        });
      }
      const nowNs = Date.now() * 1_000_000;
      const to = Number(url.searchParams.get('to') ?? nowNs);
      const from = Number(url.searchParams.get('from') ?? to - 600 * 1_000_000_000);
      const step = (to - from) / (SAMPLES + 1);
      const base = pv === MOLE_PV ? 10 : 8;
      const samples = Array.from({ length: SAMPLES }, (_, i) => ({
        tsNs: Math.round(from + (i + 1) * step),
        value: base + Math.sin(i / 5),
        severity: 'NO_ALARM',
        source: 'archive',
      }));
      return route.fulfill({
        json: { mode: 'raw', pv, archiver, from, to, decimated: false, samples },
      });
    }
  );
}

/** Installs the backend doubles; the spec-local archive route is last, so it wins. */
async function installBackend(page: Page): Promise<void> {
  await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
  await mockHare(page);
  await mockMole(page);
  await mockArchive(page);
  // The page never opens the Formula Engine here; answer it anyway so nothing leaks out.
  await page.routeWebSocket(pathEndsWith(FORMULA_ENGINE_PATH), () => {});
}

/** The overlay's box: the plot grid, in page px. */
async function gridBox(page: Page) {
  const layer = page.locator('svg[data-annotation-layer]').first();
  await expect(layer).toBeAttached();
  const box = await layer.boundingBox();
  if (!box || box.width < 50 || box.height < 50) throw new Error('the plot grid has no box');
  return box;
}

/** Moves the pointer off the plot, so no crosshair is drawn into a capture. */
async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(VIEWPORT.width - 4, 4);
}

/** Clicks Export PNG and returns the downloaded file's bytes. */
async function exportPng(page: Page): Promise<Buffer> {
  const download = page.waitForEvent('download');
  await page
    .getByTestId('actions-bar')
    .getByRole('button', { name: /^export png/i })
    .click();
  const file = await (await download).path();
  return readFile(file);
}

interface PixelReport {
  width: number;
  height: number;
  /** Pixels within tolerance of the edited colour. */
  edited: number;
}

/** Decodes two PNGs in the page: their sizes, edited-colour pixels, and pixels that differ. */
async function comparePngs(
  page: Page,
  a: Buffer,
  b: Buffer
): Promise<{ a: PixelReport; b: PixelReport; differing: number }> {
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
      const [da, db] = await Promise.all([decode(a64), decode(b64)]);
      const edited = (d: ImageData) => {
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
      let differing = 0;
      if (da.width === db.width && da.height === db.height) {
        for (let i = 0; i < da.data.length; i += 4) {
          if (
            da.data[i] !== db.data[i] ||
            da.data[i + 1] !== db.data[i + 1] ||
            da.data[i + 2] !== db.data[i + 2]
          ) {
            differing++;
          }
        }
      }
      return {
        a: { width: da.width, height: da.height, edited: edited(da) },
        b: { width: db.width, height: db.height, edited: edited(db) },
        differing,
      };
    },
    [a.toString('base64'), b.toString('base64'), EDITED_COLOUR, COLOUR_TOLERANCE] as const
  );
}

/** The `drawings` of the embed URL's `plot=` config, or null when it has none. */
function urlDrawings(url: string): unknown[] | null {
  const raw = new URL(url).searchParams.get('plot');
  if (raw === null) return null;
  const config = JSON.parse(raw) as { drawings?: unknown[] };
  return config.drawings ?? null;
}

test('drawings: place from the rail, edit and undo from the sidebar, persist, export', async ({
  page,
}) => {
  await installBackend(page);
  await page.goto(PAGE);
  await waitForWorkbench(page);
  await expect(page.locator('.wb-outline-row')).toHaveCount(PVS.length);
  await expect(page.locator('[data-drawing-rail]')).toBeVisible();

  const hlines = page.locator('[data-annotation-kind="hline"]');
  const boxes = page.locator('[data-annotation-kind="box"]');
  const rail = page.locator('[data-drawing-rail]');
  const grid = await gridBox(page);

  // ── Place an H-line (one click) and a box (one drag) from the rail ───────
  await rail.locator('[data-drawing-tool="hline"]').click();
  await expect(rail.locator('[data-drawing-tool="hline"]')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(grid.x + grid.width * 0.3, grid.y + grid.height * 0.25);
  await expect(hlines).toHaveCount(1);

  await rail.locator('[data-drawing-tool="box"]').click();
  await expect(rail.locator('[data-drawing-tool="box"]')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(grid.x + grid.width * 0.45, grid.y + grid.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(grid.x + grid.width * 0.8, grid.y + grid.height * 0.85, { steps: 8 });
  await page.mouse.up();
  await expect(boxes).toHaveCount(1);
  await expect(hlines).toHaveCount(1);
  await parkPointer(page);

  // ── Select the box through its card ──────────────────────────────────────
  const drawingRows = panel(page).locator('.wb-outline-row[data-section="annotations"]');
  await expect(drawingRows).toHaveCount(2);
  const rowNamed = (name: RegExp) =>
    drawingRows.filter({ has: page.locator('.wb-outline-row__name', { hasText: name }) });
  const props = drawingCard(page, /^Box/);

  // The box was selected on commit; go through the H-line so the box row's
  // click is what selects it.
  await rowNamed(/^H-line/)
    .locator('.wb-outline-row__name')
    .click();
  await expect(hlines).toHaveAttribute('data-annotation-selected', 'true');
  await rowNamed(/^Box/).locator('.wb-outline-row__name').click();
  await expect(boxes).toHaveAttribute('data-annotation-selected', 'true');
  await expect(hlines).not.toHaveAttribute('data-annotation-selected', 'true');
  await expect(props).toHaveClass(/wb-card--open/);

  // ── Change Colour in the box's card ──────────────────────────────────────
  const colourField = props.locator('[data-field="annotation-color"]');
  const colour = colourField.locator('input[type="color"]');
  // A new drawing is in the theme's ink: what is drawn is what its swatch shows.
  const original = await swatchHex(colourField);
  expect(original).toMatch(/^#[0-9a-f]{6}$/);
  expect(original).not.toBe(EDITED_COLOUR);
  const boxStroked = (hex: string) => boxes.locator(`[stroke="${hex}"]`);
  await expect(boxStroked(original)).not.toHaveCount(0);

  await colour.fill(EDITED_COLOUR);
  await expect(colour).toHaveValue(EDITED_COLOUR);
  await expect(boxStroked(EDITED_COLOUR)).not.toHaveCount(0);

  // ── primary+Z with focus still in the sidebar reverts it ─────────────────
  expect(await page.evaluate(() => document.activeElement?.closest('.wb-sidebar') !== null)).toBe(
    true
  );
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => swatchHex(colourField)).toBe(original);
  await expect(boxStroked(EDITED_COLOUR)).toHaveCount(0);
  await expect(boxStroked(original)).not.toHaveCount(0);
  // One step only: both drawings are still there.
  await expect(boxes).toHaveCount(1);
  await expect(hlines).toHaveCount(1);

  // ── Redo the Colour edit (no redo key: make it again) ────────────────────
  await colour.fill(EDITED_COLOUR);
  await expect(colour).toHaveValue(EDITED_COLOUR);
  await expect(boxStroked(EDITED_COLOUR)).not.toHaveCount(0);

  // ── The URL's plot= carries the drawings once the state settles ──────────
  await expect
    .poll(() => new URL(page.url()).searchParams.get('plot') ?? '', { timeout: 10_000 })
    .toContain('drawings');
  await expect
    .poll(
      () => {
        const drawings = urlDrawings(page.url());
        return drawings === null
          ? 'none'
          : `${drawings.length}:${JSON.stringify(drawings).includes(EDITED_COLOUR)}`;
      },
      { timeout: 10_000 }
    )
    .toBe('2:true');

  // ── Reload: both drawings and the edited colour come back ────────────────
  await page.reload();
  await waitForWorkbench(page);
  await expect(hlines).toHaveCount(1);
  await expect(boxes).toHaveCount(1);
  await expect(boxStroked(EDITED_COLOUR)).not.toHaveCount(0);

  // History is session-only: nothing is undone after the reload.
  await page.locator('[data-plot-id]').first().focus();
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(300);
  await expect(hlines).toHaveCount(1);
  await expect(boxes).toHaveCount(1);
  await expect(boxStroked(EDITED_COLOUR)).not.toHaveCount(0);

  // ── Export PNG with the drawings, then with Hide all on ──────────────────
  await parkPointer(page);
  const shown = await exportPng(page);

  const hide = page.locator('[data-drawing-rail] [data-drawing-toggle="hide"]');
  await hide.click();
  await expect(hide).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('svg[data-annotation-layer]')).toHaveCount(0);
  await parkPointer(page);
  const hidden = await exportPng(page);

  expect(shown.equals(hidden)).toBe(false);
  const report = await comparePngs(page, shown, hidden);
  expect(report.a.width).toBe(report.b.width);
  expect(report.a.height).toBe(report.b.height);
  expect(report.differing).toBeGreaterThan(0);
  // Only the export with the drawings carries the box's colour.
  expect(report.a.edited).toBeGreaterThan(MIN_BOX_PIXELS);
  expect(report.b.edited * 10).toBeLessThan(report.a.edited);

  // Leave the drawings shown again.
  await hide.click();
  await expect(hide).toHaveAttribute('aria-pressed', 'false');
  await expect(boxes).toHaveCount(1);
});
