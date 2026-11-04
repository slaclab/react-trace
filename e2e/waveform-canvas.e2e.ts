// The Waveform canvas on its own page (`waveform.html?pv=…`), standalone and
// fed by the Hare double alone:
//   - two live waveform PVs render, each as its own curve;
//   - a PV that goes disconnected leaves the canvas and comes back when it
//     reconnects;
//   - a frame with null elements draws a gap where they sit.
//
// What "drawn" means here is read off the chart's canvas, not only the DOM:
// each curve is pinned to a pure colour no theme uses (red, blue) with a wide
// line, legend and grid are off, so the pixels of that colour are the curve
// and nothing else. The statistics readout (`stats=1`) is the DOM cross-check:
// it has one `readout-<pv>` row per drawn live curve, swatched in the curve's
// colour, and its `n` column holds the finite elements of the frame.
//
// The values are constant per PV (A at +1, B at −1), so each curve is a
// horizontal line and a gap is a run of columns without its colour.
//
// Specs replaced when the fixed `waveform-stat` row gave way to the shared
// statistics readout (each deleted title → the spec that now covers it):
//   - "two live waveform PVs render from the Hare mock alone"
//       → "two live waveform PVs render from the Hare mock alone, one readout
//         row each"
//   - "a disconnected PV leaves the canvas and returns on reconnect"
//       → "a disconnected PV leaves the canvas and the readout and returns on
//         reconnect"
//   - "a frame with null elements draws a gap"
//       → "a frame with null elements draws a gap and n counts only the finite
//         ones". The "n finite / len" gap chip no longer exists; the readout's
//         `n` dropping from the frame length to the finite count carries its
//         intent.

import { expect, test, type Page } from '@playwright/test';

import { mockHare, type HareMock, type HareWaveform } from './mocks';

const PV_A = 'WF:CANVAS:A';
const PV_B = 'WF:CANVAS:B';
const LENGTH = 200;
const HZ = 10;
/** Elements A sends as null in the gap case: 20 % of the frame, mid-range. */
const GAP = Array.from({ length: 40 }, (_, i) => 80 + i);

const RED = '#ff0000';
const BLUE = '#0000ff';
const LINE_WIDTH = 3;
/** A curve this many pixels long or shorter is not "drawn". */
const MIN_PIXELS = 200;

const waveforms: Record<string, HareWaveform> = {
  [PV_A]: { length: LENGTH, hz: HZ, value: () => 1 },
  [PV_B]: { length: LENGTH, hz: HZ, value: () => -1 },
};

function pageUrl(): string {
  const q = new URLSearchParams();
  q.append('pv', PV_A);
  q.append('pv', PV_B);
  q.set('stats', '1');
  q.set('legend', '0');
  q.set('grid', '0');
  q.set(
    'plot',
    JSON.stringify({
      v: 1,
      traces: [
        { color: RED, lineWidth: LINE_WIDTH },
        { color: BLUE, lineWidth: LINE_WIDTH },
      ],
    })
  );
  return `/waveform.html?${q.toString()}`;
}

interface Ink {
  /** Pixels of the colour. */
  pixels: number;
  /** Leftmost and rightmost column holding it (-1 when none). */
  first: number;
  last: number;
  /** The widest run of columns without it between `first` and `last`. */
  widestGap: number;
}

/** Where the chart's canvas holds `color` (a pure primary: one channel high, the others low). */
function ink(page: Page, color: 'red' | 'blue'): Promise<Ink> {
  return page.evaluate((which) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="waveform-chart"] canvas'
    );
    const none = { pixels: 0, first: -1, last: -1, widestGap: 0 };
    if (canvas === null) return none;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return none;
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    const hit = (o: number) => {
      const [r, g, b] = [data[o], data[o + 1], data[o + 2]];
      return which === 'red' ? r > 200 && g < 60 && b < 60 : b > 200 && r < 60 && g < 60;
    };
    const columns = new Uint8Array(width);
    let pixels = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (hit((y * width + x) * 4)) {
          pixels++;
          columns[x] = 1;
        }
      }
    }
    if (pixels === 0) return none;
    const first = columns.indexOf(1);
    const last = columns.lastIndexOf(1);
    let widestGap = 0;
    let run = 0;
    for (let x = first; x <= last; x++) {
      run = columns[x] ? 0 : run + 1;
      widestGap = Math.max(widestGap, run);
    }
    return { pixels, first, last, widestGap };
  }, color);
}

/** The statistics readout's row for `pv` (absent while the curve is not drawn). */
function readout(page: Page, pv: string) {
  return page.getByTestId(`readout-${pv}`);
}

/** Every readout row. */
function readoutRows(page: Page) {
  return page.locator('.stats-readout tbody tr');
}

/** The `n` cell of `pv`'s row: the first metric column, the finite element count. */
function nCell(page: Page, pv: string) {
  return readout(page, pv).locator('td').first();
}

let hare: HareMock;

test.beforeEach(async ({ page }) => {
  // Nothing reaches a real service: everything not mocked below fails fast.
  await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
  hare = await mockHare(page, { waveforms });
  await page.goto(pageUrl());
  await expect(page.getByTestId('waveform-app')).toBeVisible();
});

test.afterEach(() => {
  hare.stop();
});

test('two live waveform PVs render from the Hare mock alone, one readout row each', async ({
  page,
}) => {
  await expect(readout(page, PV_A)).toBeVisible();
  await expect(readout(page, PV_B)).toBeVisible();
  await expect(readoutRows(page)).toHaveCount(2);
  await expect(page.getByTestId('waveform-canvas-message')).toHaveCount(0);
  // n is the first column, every element of a whole frame.
  await expect(page.getByTestId('readout-col-n')).toHaveText('n');
  await expect(nCell(page, PV_A)).toHaveText(String(LENGTH));
  await expect(nCell(page, PV_B)).toHaveText(String(LENGTH));
  // Each row's swatch is its curve's pinned colour.
  await expect(readout(page, PV_A).locator('.stats-readout__swatch')).toHaveCSS(
    'color',
    'rgb(255, 0, 0)'
  );
  await expect(readout(page, PV_B).locator('.stats-readout__swatch')).toHaveCSS(
    'color',
    'rgb(0, 0, 255)'
  );

  await expect.poll(async () => (await ink(page, 'red')).pixels).toBeGreaterThan(MIN_PIXELS);
  await expect.poll(async () => (await ink(page, 'blue')).pixels).toBeGreaterThan(MIN_PIXELS);

  // Both lines run the plot's width without a break.
  const red = await ink(page, 'red');
  const blue = await ink(page, 'blue');
  expect(red.widestGap).toBeLessThanOrEqual(2);
  expect(blue.widestGap).toBeLessThanOrEqual(2);
  expect(Math.abs(red.first - blue.first)).toBeLessThanOrEqual(LINE_WIDTH);
  expect(Math.abs(red.last - blue.last)).toBeLessThanOrEqual(LINE_WIDTH);

  // Live: the mock keeps streaming, and every frame is on the record with its
  // scheduled and actual send time.
  await expect
    .poll(() => hare.frames.filter((f) => f.pv === PV_A && f.frame > 0).length)
    .toBeGreaterThanOrEqual(3);
  const periodic = hare.frames.filter((f) => f.pv === PV_B && f.frame > 0);
  expect(periodic.length).toBeGreaterThan(0);
  for (const f of periodic) {
    expect(f.connected).toBe(true);
    // Node timers may wake a millisecond early against Date.now().
    expect(f.sentAt).toBeGreaterThanOrEqual(f.scheduledAt - 2);
  }
});

test('a disconnected PV leaves the canvas and the readout and returns on reconnect', async ({
  page,
}) => {
  await expect.poll(async () => (await ink(page, 'blue')).pixels).toBeGreaterThan(MIN_PIXELS);
  await expect(readout(page, PV_B)).toBeVisible();

  hare.disconnect(PV_B);
  await expect(readout(page, PV_B)).toHaveCount(0);
  await expect(readoutRows(page)).toHaveCount(1);
  await expect.poll(async () => (await ink(page, 'blue')).pixels).toBe(0);
  // The other curve is untouched.
  await expect(readout(page, PV_A)).toBeVisible();
  await expect(nCell(page, PV_A)).toHaveText(String(LENGTH));
  expect((await ink(page, 'red')).pixels).toBeGreaterThan(MIN_PIXELS);

  hare.reconnect(PV_B);
  await expect(readout(page, PV_B)).toBeVisible();
  await expect(readoutRows(page)).toHaveCount(2);
  await expect(nCell(page, PV_B)).toHaveText(String(LENGTH));
  await expect.poll(async () => (await ink(page, 'blue')).pixels).toBeGreaterThan(MIN_PIXELS);
  expect((await ink(page, 'blue')).widestGap).toBeLessThanOrEqual(2);
});

test('a frame with null elements draws a gap and n counts only the finite ones', async ({
  page,
}) => {
  await expect.poll(async () => (await ink(page, 'red')).pixels).toBeGreaterThan(MIN_PIXELS);
  const whole = await ink(page, 'red');
  expect(whole.widestGap).toBeLessThanOrEqual(2);
  await expect(nCell(page, PV_A)).toHaveText(String(LENGTH));

  hare.setWaveform(PV_A, { nulls: GAP });
  hare.sendFrame(PV_A);

  await expect(nCell(page, PV_A)).toHaveText(String(LENGTH - GAP.length));
  // The gap spans the 41 element intervals from 79 to 120 of the 199 the line
  // covers; ask for most of that, in the middle of the line.
  const span = whole.last - whole.first;
  await expect
    .poll(async () => (await ink(page, 'red')).widestGap)
    .toBeGreaterThan(span * (35 / 199));
  const gapped = await ink(page, 'red');
  expect(gapped.first).toBeLessThanOrEqual(whole.first + 2);
  expect(gapped.last).toBeGreaterThanOrEqual(whole.last - 2);
  // The other curve is whole.
  expect((await ink(page, 'blue')).widestGap).toBeLessThanOrEqual(2);
  await expect(nCell(page, PV_B)).toHaveText(String(LENGTH));
});
