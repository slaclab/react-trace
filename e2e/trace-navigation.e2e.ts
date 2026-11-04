// Trace's plot navigation in a real browser against the built page, with the shared Hare and Mole doubles: one plot, two PVs, a -10m range.
//
// What is asserted, and why it matters:
//
//   * a wheel over the time labels zooms time alone into a sub-range whose
//     samples are much smaller than the rest, and the auto-scaled Y axis
//     refits to it (a wheel over the plot area would zoom the Y axis too):
//     its tick labels drop to the small values (the view-window cut does
//     this fit);
//   * a vertical drag on the Y band then stretches that axis: its tick labels
//     change while the time labels and the window's right edge stay as they
//     were (the Y band never moves time), and the stretched axis shows
//     its auto-scale badge, which turns auto-scale back on. The stretch runs
//     on the zoomed window because a gesture froze it: on the live -10m window
//     the time ticks move on their own whenever the clock passes a minute;
//   * wheeling out past the preset widens the window beyond the -10m span;
//   * Now returns the window to the relative span ending at now.
//
// The chart draws on a canvas, so the spec reads what it draws: an init
// script records every `fillText` per canvas (reset on each clear, so the list
// is the last full repaint), and labels are told apart by where they sit —
// Y tick labels left of the grid, time labels in the strip under it. The time
// window is read through the status line under the plot (`data-status-time`):
// the time under the pointer at two fixed points gives the window's scale in
// ms per px, which is proportional to its span while the Y labels keep their
// width (wider labels push the grid's left edge in).
//
// The archive double here is spec-local: `SIM:TEST` and `SIM:OTHER` answer with
// samples near 40 before a pivot four minutes before the page opened and near
// 1 after it, so a zoom into the newest minute holds small samples only.

import { expect, test, type Locator, type Page } from '@playwright/test';

import { FORMULA_ENGINE_PATH, MOLE_PV, mockHare, mockMole, pathEndsWith } from './mocks';
import { waitForWorkbench } from './workbench';

const VIEWPORT = { width: 1280, height: 800 };
const OTHER_PV = 'SIM:OTHER';
const PVS = [MOLE_PV, OTHER_PV];
const RANGE = '-10m';
const PAGE = `/?embedded=true&${PVS.map((pv) => `pv=${encodeURIComponent(pv)}`).join('&')}&range=${RANGE}`;

/** Grid insets of a plot with one left axis (PlotArea `plotLayout`). */
const GRID_TOP = 40;
const GRID_BOTTOM = 60;
const GRID_LEFT = 70;
/** Y tick labels sit left of the grid, right-aligned; wider labels widen the grid's margin. */
const Y_LABEL_MAX_X = 200;
/** Height of the time-label strip under the grid (axisHitTest `X_BAND_PX`). */
const X_BAND_PX = 26;

/** Archive samples per answer, evenly inside the requested window. */
const SAMPLES = 60;
/** How long before the page opens the samples drop from ~40 to ~1. */
const PIVOT_BEFORE_OPEN_MS = 4 * 60_000;

/** A wheel delta that is the router's per-event maximum (half an octave). */
const WHEEL_STEP_PX = 150;

test.use({ viewport: VIEWPORT });
test.describe.configure({ timeout: 90_000 });

interface DrawnText {
  text: string;
  x: number;
  y: number;
}

/** Records every `fillText` per canvas, in CSS px; a clear starts the list afresh. */
async function recordCanvasText(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const drawn = new WeakMap<HTMLCanvasElement, { text: string; x: number; y: number }[]>();
    const proto = CanvasRenderingContext2D.prototype;
    const fillText = proto.fillText;
    proto.fillText = function (text: string, x: number, y: number, maxWidth?: number) {
      const m = this.getTransform();
      const dpr = window.devicePixelRatio || 1;
      let list = drawn.get(this.canvas);
      if (list === undefined) drawn.set(this.canvas, (list = []));
      list.push({
        text: String(text),
        x: (m.a * x + m.c * y + m.e) / dpr,
        y: (m.b * x + m.d * y + m.f) / dpr,
      });
      return maxWidth === undefined
        ? fillText.call(this, text, x, y)
        : fillText.call(this, text, x, y, maxWidth);
    };
    const clearRect = proto.clearRect;
    proto.clearRect = function (x: number, y: number, w: number, h: number) {
      drawn.set(this.canvas, []);
      return clearRect.call(this, x, y, w, h);
    };
    (window as unknown as { __drawnText: (c: HTMLCanvasElement) => unknown }).__drawnText = (
      canvas
    ) => drawn.get(canvas) ?? [];
  });
}

/** The main chart canvas of the plot: the one with text on it. */
function chartCanvas(page: Page): Locator {
  return page.locator('[data-plot-id] canvas');
}

async function drawnText(page: Page): Promise<{ texts: DrawnText[]; height: number }> {
  const all = await chartCanvas(page).evaluateAll((canvases) =>
    canvases.map((c) => ({
      texts: (
        window as unknown as { __drawnText: (c: HTMLCanvasElement) => DrawnText[] }
      ).__drawnText(c as HTMLCanvasElement),
      height: (c as HTMLCanvasElement).getBoundingClientRect().height,
    }))
  );
  return all.reduce((best, c) => (c.texts.length > best.texts.length ? c : best), {
    texts: [] as DrawnText[],
    height: 0,
  });
}

/** The Y tick labels, top to bottom: numbers left of the grid, within its height. */
async function yLabels(page: Page): Promise<string[]> {
  const { texts, height } = await drawnText(page);
  return texts
    .filter(
      (t) =>
        t.x < Y_LABEL_MAX_X &&
        t.y >= GRID_TOP - 2 &&
        t.y <= height - GRID_BOTTOM + 2 &&
        /^-?[\d.,e+-]+$/i.test(t.text)
    )
    .sort((a, b) => a.y - b.y)
    .map((t) => t.text);
}

/** The time tick labels, left to right: the strip directly under the grid. */
async function timeLabels(page: Page): Promise<string[]> {
  const { texts, height } = await drawnText(page);
  const bottom = height - GRID_BOTTOM;
  return texts
    .filter(
      (t) => t.y > bottom && t.y <= bottom + X_BAND_PX && /^\d{1,2}:\d\d(:\d\d)?$/.test(t.text)
    )
    .sort((a, b) => a.x - b.x)
    .map((t) => t.text);
}

/** The largest Y tick label's value. */
async function yMax(page: Page): Promise<number> {
  const values = (await yLabels(page)).map(Number).filter(Number.isFinite);
  return values.length === 0 ? Number.NaN : Math.max(...values);
}

async function canvasBox(page: Page) {
  const box = await page.locator('[data-plot-id]').first().boundingBox();
  if (!box) throw new Error('the plot has no box');
  return box;
}

/** Parses the status line's local `YYYY-MM-DD HH:mm:ss`. */
function parseStatusTime(text: string): number {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(text.trim());
  if (!m) return Number.NaN;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** The time under the pointer at canvas-local `x` (mid-grid height), via the status line. */
async function timeAt(page: Page, x: number): Promise<number> {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + x, box.y + box.height / 2);
  const status = page.locator('[data-status-time]').first();
  await expect(status).toHaveText(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  return parseStatusTime(await status.innerText());
}

/** Two fixed probe points inside the grid, canvas-local x. */
async function probes(page: Page): Promise<[number, number]> {
  const box = await canvasBox(page);
  return [GRID_LEFT + 80, box.width - 60];
}

/** The window's scale in ms per px (proportional to its span) and the right probe's time. */
async function windowScale(page: Page): Promise<{ msPerPx: number; rightT: number }> {
  const [a, b] = await probes(page);
  const ta = await timeAt(page, a);
  const tb = await timeAt(page, b);
  await parkPointer(page);
  return { msPerPx: (tb - ta) / (b - a), rightT: tb };
}

/**
 * Moves the pointer off the plot, so the crosshair's axis-pointer labels (drawn
 * in the same strips as the tick labels) are gone before labels are read.
 */
async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(VIEWPORT.width - 4, 4);
}

/** Waits until the drawn value of `read` stops changing over two frames' worth. */
async function settled<T>(page: Page, read: () => Promise<T>): Promise<T> {
  let last = JSON.stringify(await read());
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const next = JSON.stringify(await read());
    if (next === last) return JSON.parse(next) as T;
    last = next;
  }
  return JSON.parse(last) as T;
}

/** Serves both PVs' archive data: ~40 before the pivot, ~1 after it. */
async function mockArchive(page: Page, pivotMs: number): Promise<{ requests: number }> {
  const seen = { requests: 0 };
  const value = (pv: string, tMs: number, i: number) =>
    tMs < pivotMs
      ? (pv === MOLE_PV ? 40 : 35) + Math.sin(i / 5)
      : (pv === MOLE_PV ? 1 : 0.8) + 0.2 * Math.sin(i / 5);
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
      seen.requests++;
      const nowNs = Date.now() * 1_000_000;
      const to = Number(url.searchParams.get('to') ?? nowNs);
      const from = Number(url.searchParams.get('from') ?? to - 600 * 1_000_000_000);
      const step = (to - from) / (SAMPLES + 1);
      const samples = Array.from({ length: SAMPLES }, (_, i) => {
        const tsNs = Math.round(from + (i + 1) * step);
        return {
          tsNs,
          value: value(pv, tsNs / 1_000_000, i),
          severity: 'NO_ALARM',
          source: 'archive',
        };
      });
      return route.fulfill({
        json: { mode: 'raw', pv, archiver, from, to, decimated: false, samples },
      });
    }
  );
  return seen;
}

/** Opens Trace on both PVs with the spec-local archive double installed last (it wins). */
async function openNavigation(page: Page): Promise<void> {
  await recordCanvasText(page);
  await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
  await mockHare(page);
  await mockMole(page);
  await mockArchive(page, Date.now() - PIVOT_BEFORE_OPEN_MS);
  // The page never opens the Formula Engine here; answer it anyway so nothing leaks out.
  await page.routeWebSocket(pathEndsWith(FORMULA_ENGINE_PATH), () => {});
  await page.goto(PAGE);
  await waitForWorkbench(page);
  await expect(page.locator('.wb-outline-row')).toHaveCount(PVS.length);
  // Drawn with the archive answered: the old, large samples set the Y extent.
  await expect.poll(() => yMax(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(30);
  await expect.poll(async () => (await timeLabels(page)).length).toBeGreaterThan(2);
}

test('wheel zoom in refits the auto Y axis, a Y stretch leaves time alone, zoom out, Now', async ({
  page,
}) => {
  await openNavigation(page);
  const box = await canvasBox(page);
  const gridMidY = GRID_TOP + (box.height - GRID_TOP - GRID_BOTTOM) / 2;
  // The time-label strip: a wheel there zooms time only.
  const timeBandY = box.height - GRID_BOTTOM + X_BAND_PX / 2;

  // ── Wheel-zoom into the newest minute: the auto Y axis refits ────────────
  const preset = await windowScale(page);
  const yAuto = await settled(page, () => yLabels(page));
  // Near the right edge, so the zoomed window holds only post-pivot samples.
  await page.mouse.move(box.x + box.width - 60, box.y + timeBandY);
  for (let i = 0; i < 7; i++) {
    await page.mouse.wheel(0, -WHEEL_STEP_PX);
    await page.waitForTimeout(60);
  }
  await parkPointer(page);
  await expect.poll(() => yMax(page), { timeout: 15_000 }).toBeLessThan(5);
  expect(await settled(page, () => yLabels(page))).not.toEqual(yAuto);
  const zoomedIn = await windowScale(page);
  expect(zoomedIn.msPerPx).toBeLessThan(preset.msPerPx * 0.2);

  // ── Stretch the Y axis: its labels change, the time labels do not ─────────
  // The zoomed window is frozen (a gesture wrote it), so the time axis only
  // moves if the stretch moves it.
  await expect(page.locator('[data-axis-badge]')).toHaveCount(0);
  const yBefore = await settled(page, () => yLabels(page));
  const timeBefore = await settled(page, () => timeLabels(page));
  const windowBefore = await windowScale(page);
  expect(timeBefore.length).toBeGreaterThan(2);

  const bandX = box.x + GRID_LEFT / 2;
  await page.mouse.move(bandX, box.y + gridMidY);
  await page.mouse.down();
  await page.mouse.move(bandX, box.y + gridMidY - 20, { steps: 4 });
  await page.mouse.move(bandX, box.y + gridMidY - 120, { steps: 10 });
  await page.mouse.up();
  await parkPointer(page);

  await expect.poll(() => yLabels(page)).not.toEqual(yBefore);
  const yStretched = await settled(page, () => yLabels(page));
  expect(yStretched).not.toEqual(yBefore);
  // Dragging up narrows the extent about its centre: the top label drops.
  expect(Math.max(...yStretched.map(Number))).toBeLessThan(Math.max(...yBefore.map(Number)));
  expect(await timeLabels(page)).toEqual(timeBefore);
  // The right edge has not moved either (the left probe may: wider Y labels
  // can push the grid's left edge in).
  expect(Math.abs((await windowScale(page)).rightT - windowBefore.rightT)).toBeLessThanOrEqual(
    1_000
  );

  // The stretched axis is no longer auto-scaled; its badge turns auto back on.
  const badge = page.locator('[data-axis-badge]');
  await expect(badge).toHaveCount(1);
  await badge.click();
  await parkPointer(page);
  await expect(badge).toHaveCount(0);
  await expect.poll(async () => JSON.stringify(await yLabels(page))).toBe(JSON.stringify(yBefore));

  // ── Wheel-zoom out past the preset: the window widens beyond -10m ─────────
  await page.mouse.move(box.x + box.width / 2, box.y + timeBandY);
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, WHEEL_STEP_PX);
    await page.waitForTimeout(60);
  }
  await parkPointer(page);
  await expect
    .poll(async () => (await windowScale(page)).msPerPx, { timeout: 15_000 })
    .toBeGreaterThan(preset.msPerPx * 1.5);

  // ── Now: back to the relative span, ending at now ────────────────────────
  await page.locator('[data-range-controls] [data-range-chip="now"]').first().click();
  await expect
    .poll(async () => (await windowScale(page)).msPerPx / preset.msPerPx, { timeout: 15_000 })
    .toBeCloseTo(1, 1);
  const back = await windowScale(page);
  // The right probe sits 40 px inside the grid's right edge, under a minute from now.
  expect(back.rightT).toBeGreaterThan(Date.now() - 90_000);
  expect(back.rightT).toBeLessThanOrEqual(Date.now() + 1_000);
});
