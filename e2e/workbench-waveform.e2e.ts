// Waveform's behaviour end to end, in a real browser against the built
// `waveform.html` with the shared Hare double, and the sidebar gestures on the shared
// workbench helper (e2e/workbench.ts).
//
// What is asserted, and why it matters:
//
//   * the workbench gestures are the tool-agnostic ones: the collapse button
//     collapses to a rail whose one target expands it, a card head click
//     opens that card in place without writing, and a reload restores what
//     the page's own gestures wrote;
//   * with two live curves and Average 4, Snapshot → reference then Subtract
//     reference gives Δ ≈ 0 on both curves — at the default rate, at hz=1
//     and while paused — and Δ follows the next frame (it is live, not a
//     constant), and a second Snapshot re-zeroes it in the publish the click
//     forces;
//   * a curve added after the snapshot is not drawn in Δ and its row says
//     "not in snapshot";
//   * bars from 8 curves overlay in one column per element;
//   * with a usable X axis PV a curve of another length is hidden with the
//     length-mismatch chip; an X axis PV that matches no curve puts every
//     curve on index and the X axis reads "Element";
//   * a curve's pinned style (label and colour) survives a Group move there
//     and back and the removal of an earlier curve;
//   * hide → show starts a fresh average (the ring restarts).
//
// The data specs drive the Hare double frame by frame (`hz: 0`, `sendFrame`),
// so no frame arrives between a click and the check that follows it: the
// statistics readout (`stats=1`) then shows exactly the publish the click
// triggered — one `readout-<pv>` row per drawn live curve, cells in column
// order n, mean, std, rms, p-p, a curve that is not drawn has no row. Values
// are integers and their averages exact binary fractions, so Δ of equal
// frames is exactly 0.
//
// Specs replaced when the fixed `waveform-stat` row gave way to the shared
// statistics readout (each deleted title → the spec that now covers it):
//   - "Snapshot → reference then Subtract reference gives Δ ≈ 0 on both
//     curves at the default rate" / "… at hz=1" / "… while paused"
//       → "Snapshot → reference then Subtract reference reads Δ ≈ 0 in the
//         readout on both curves at the default rate" / "… at hz=1" /
//         "… while paused"
//   - "a curve added after the snapshot is not drawn in Δ and says so"
//       → "a curve added after the snapshot is not drawn in Δ, has no readout
//         row and says so"
//   - "a length-mismatched curve is hidden with a chip; an unusable X source
//     puts every curve on index"
//       → "a length-mismatched curve is hidden with a chip and has no readout
//         row; an unusable X axis PV puts every curve on index"
//   - "a curve's style survives a Group move and the removal of an earlier
//     curve"
//       → "a curve's style survives a Group move and the removal of an earlier
//         curve, readout label and swatch included"
//   - "hide → show starts a fresh average"
//       → "hide → show drops the readout row and starts a fresh average"

import { expect, test, type Locator, type Page } from '@playwright/test';

import { mockHare, mockMole, type HareMock, type HareWaveform } from './mocks';
import {
  card,
  openCard,
  openChartSource,
  openTrace,
  outlineSection,
  panel,
  pointerDrag,
  readArrangement,
  seedArrangement,
  settleWrites,
  sidebar,
  waitForStored,
  waitForWorkbench,
  type Arrangement,
} from './workbench';

const VIEWPORT = { width: 1280, height: 800 };

test.use({ viewport: VIEWPORT });
test.describe.configure({ timeout: 90_000 });

const PV_A = 'WF:BEH:A';
const PV_B = 'WF:BEH:B';
const PV_C = 'WF:BEH:C';
const LENGTH = 16;
/** Past dnd-kit's 50 ms post-drop click guard, with margin for a loaded host. */
const DND_CLICK_GUARD_MS = 200;
/** Δ, mean, RMS and peak-to-peak below this are zero. */
const ZERO = 1e-9;

/** The Waveform page with `params`, the query the tool parses. */
function waveformPath(params: URLSearchParams): string {
  return `/waveform.html?${params.toString()}`;
}

function query(pvs: string[], extra: Record<string, string> = {}): URLSearchParams {
  const q = new URLSearchParams();
  for (const pv of pvs) q.append('pv', pv);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q;
}

interface OpenWaveformOptions {
  waveforms: Record<string, HareWaveform>;
  arrangement?: Partial<Arrangement>;
}

/**
 * The Waveform page on the workbench with its own Hare double: every
 * unmocked backend path answers 503, then Hare (with `waveforms`) and Mole.
 */
async function openWaveform(
  page: Page,
  params: URLSearchParams,
  options: OpenWaveformOptions
): Promise<HareMock> {
  await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
  const hare = await mockHare(page, { waveforms: options.waveforms });
  await mockMole(page);
  if (options.arrangement) await seedArrangement(page, options.arrangement);
  await page.goto(waveformPath(params));
  await waitForWorkbench(page);
  await expect(page.getByTestId('waveform-app')).toBeVisible();
  return hare;
}

// ── Locators ────────────────────────────────────────────────────────────────

function row(page: Page, group: 'live' | 'reference' | 'xsource', pv: string): Locator {
  return page.locator(`.wb-outline-row[data-row-id="${group}:${pv}"]`);
}

function rowStatus(r: Locator): Locator {
  return r.locator('.wb-outline-row__status');
}

/** The statistics readout's row for `pv` (absent while the curve is not drawn). */
function readout(page: Page, pv: string): Locator {
  return page.getByTestId(`readout-${pv}`);
}

function action(page: Page, name: RegExp): Locator {
  return page.getByTestId('actions-bar').getByRole('button', { name });
}

const SNAPSHOT = /^Snapshot → reference/;
const PAUSE = /^Pause/;

/** Turns Subtract reference on from the Reference group's settings in the Outline. */
async function subtractReference(page: Page): Promise<void> {
  const field = panel(page).locator('.wb-outline [data-field="subtract-reference"]');
  const toggle = field.locator('[role="switch"]');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  // Carbon's toggle label covers its switch button: the label is what a user clicks.
  await field.locator('label[for="subtract-reference"]').click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
}

/** The readout's default columns, in order: the metric ids its headers carry. */
const COLUMNS = ['n', 'mean', 'std', 'rms', 'p2p'] as const;

type Stats = Record<(typeof COLUMNS)[number], number>;

/** The readout's header shows exactly the default columns, in order. */
async function expectColumns(page: Page): Promise<void> {
  await expect(page.locator('.stats-readout thead th[data-testid^="readout-col-"]')).toHaveCount(
    COLUMNS.length
  );
  for (const [k, id] of COLUMNS.entries()) {
    await expect(
      page.locator('.stats-readout thead th[data-testid^="readout-col-"]').nth(k)
    ).toHaveAttribute('data-testid', `readout-col-${id}`);
  }
}

/**
 * The readout's numbers for `pv`, read off its cells in column order (the
 * number before the unit; "–" reads NaN); null when it has no row.
 */
async function statsOf(page: Page, pv: string): Promise<Stats | null> {
  const entry = readout(page, pv);
  if ((await entry.count()) === 0) return null;
  const texts = await entry.locator('td').allTextContents();
  const read = (k: number): number =>
    k < texts.length ? Number(texts[k].trim().split(' ')[0]) : Number.NaN;
  return { n: read(0), mean: read(1), std: read(2), rms: read(3), p2p: read(4) };
}

/** Polls until `pv`'s mean reads `mean` (a publish of the expected frames landed). */
async function expectMean(page: Page, pv: string, mean: number): Promise<void> {
  await expect
    .poll(async () => (await statsOf(page, pv))?.mean ?? null, {
      message: `${pv} mean`,
    })
    .toBe(mean);
}

/** Polls until every statistic of `pv` is zero over the whole curve: Δ ≈ 0. */
async function expectZeroDelta(page: Page, pv: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const s = await statsOf(page, pv);
        if (s === null) return 'no row';
        const zero =
          s.n === LENGTH && [s.mean, s.std, s.rms, s.p2p].every((v) => Math.abs(v) < ZERO);
        return zero ? true : JSON.stringify(s);
      },
      { message: `${pv} Δ ≈ 0` }
    )
    .toBe(true);
}

function sendBoth(hare: HareMock): void {
  hare.sendFrame(PV_A);
  hare.sendFrame(PV_B);
}

// ── Sidebar gestures on the shared helper ──────────────────────────────────

const isRail = (s: Arrangement | null) => s?.collapsed === true;

test.describe('workbench gestures on Waveform', () => {
  const GESTURE_PAGE = waveformPath(query([PV_A]));

  test('the collapse button collapses to a rail, its one target expands', async ({ page }) => {
    await openTrace(page, { path: GESTURE_PAGE });
    const bar = sidebar(page);

    await bar.collapse.click();

    await expect(bar.root).toHaveClass(/wb-sidebar--collapsed/);
    await expect(bar.rail.locator('.wb-sidebar__rail-target')).toHaveCount(1);
    await waitForStored(page, isRail);
    await bar.railTarget.click();
    await expect(bar.root).not.toHaveClass(/wb-sidebar--collapsed/);
    await expect(bar.content).toBeVisible();
  });

  test('a card head click opens that card in place unwritten, a second click closes it', async ({
    page,
  }) => {
    await openTrace(page, { path: GESTURE_PAGE });
    const live = card(page, `live:${PV_A}`);

    await openCard(live);
    await expect(live.locator('.wb-card__body[data-level=item]')).toBeVisible();
    await expect(page.locator('li.wb-card--open')).toHaveCount(1);

    await row(page, 'live', PV_A).locator('.wb-outline-row__name').click();
    await expect(live).not.toHaveClass(/wb-card--open/);
    await expect(live.locator('.wb-card__body')).toHaveCount(0);
    await settleWrites(page);
    expect(await readArrangement(page)).toBeNull();
  });

  test('a reload restores the arrangement the page wrote', async ({ page }) => {
    await openTrace(page, { path: GESTURE_PAGE });
    const bar = sidebar(page);

    await bar.collapse.click();
    const stored = await waitForStored(page, isRail);

    await page.reload();
    await waitForWorkbench(page);

    await expect(bar.root).toHaveClass(/wb-sidebar--collapsed/);
    await expect(bar.railTarget).toBeVisible();
    await expect(bar.pane).toBeHidden();
    expect(await readArrangement(page)).toEqual(stored);
  });
});

// ── Snapshot → reference, Subtract reference ───────────────────────────────

// A rises by one per frame, B by two, each with its own element profile, so
// an average over the last four frames is the frame number 2.5 back plus the
// profile, and a Δ between averages one frame apart is 1 (A) and 2 (B).
const deltaWaveforms = (): Record<string, HareWaveform> => ({
  [PV_A]: { length: LENGTH, hz: 0, value: (i, frame) => frame + i },
  [PV_B]: { length: LENGTH, hz: 0, value: (i, frame) => 2 * frame - i },
  [PV_C]: { length: LENGTH, hz: 0, value: () => 1 },
});

/** Means over the 16 elements of the Average-4 frame ending at `frame`. */
const meanA = (frame: number) => frame - 1.5 + (LENGTH - 1) / 2;
const meanB = (frame: number) => 2 * (frame - 1.5) - (LENGTH - 1) / 2;

const RATES: { name: string; extra: Record<string, string>; paused: boolean }[] = [
  { name: 'at the default rate', extra: {}, paused: false },
  { name: 'at hz=1', extra: { hz: '1' }, paused: false },
  { name: 'while paused', extra: {}, paused: true },
];

for (const rate of RATES) {
  test(`Snapshot → reference then Subtract reference reads Δ ≈ 0 in the readout on both curves ${rate.name}`, async ({
    page,
  }) => {
    const hare = await openWaveform(
      page,
      query([PV_A, PV_B], { avg: '4', stats: '1', ...rate.extra }),
      { waveforms: deltaWaveforms() }
    );
    // The `initial` is frame 0; four more fill the Average-4 window.
    for (let n = 0; n < 4; n++) sendBoth(hare);
    await expectMean(page, PV_A, meanA(4));
    await expectMean(page, PV_B, meanB(4));
    await expectColumns(page);
    expect((await statsOf(page, PV_A))?.n).toBe(LENGTH);

    if (rate.paused) {
      await action(page, PAUSE).click();
      await expect(action(page, PAUSE)).toHaveAttribute('aria-pressed', 'true');
      // Ingested, never published while paused.
      sendBoth(hare);
      await page.waitForTimeout(300);
      expect((await statsOf(page, PV_A))?.mean).toBe(meanA(4));
    }

    await action(page, SNAPSHOT).click();
    await expect(page.locator('.wb-outline-row[data-row-id="snapshot"]')).toBeVisible();
    await subtractReference(page);

    await expectZeroDelta(page, PV_A);
    await expectZeroDelta(page, PV_B);

    // Δ is live: the next publish moves each average by one frame.
    if (rate.paused) {
      await action(page, PAUSE).click();
      await expect(action(page, PAUSE)).toHaveAttribute('aria-pressed', 'false');
    } else {
      sendBoth(hare);
    }
    await expectMean(page, PV_A, 1);
    await expectMean(page, PV_B, 2);
    expect((await statsOf(page, PV_A))?.p2p).toBe(0);

    // A new snapshot with Δ on re-zeroes Δ in the publish the click forces.
    await action(page, SNAPSHOT).click();
    await expectZeroDelta(page, PV_A);
    await expectZeroDelta(page, PV_B);
    hare.stop();
  });
}

test('a curve added after the snapshot is not drawn in Δ, has no readout row and says so', async ({
  page,
}) => {
  const hare = await openWaveform(page, query([PV_A, PV_B], { avg: '4', stats: '1' }), {
    waveforms: deltaWaveforms(),
  });
  for (let n = 0; n < 4; n++) sendBoth(hare);
  await expectMean(page, PV_A, meanA(4));
  await action(page, SNAPSHOT).click();
  await subtractReference(page);
  await expectZeroDelta(page, PV_A);

  const input = page.locator('.wb-outline-add[data-section="live"] input');
  await input.fill(PV_C);
  await input.press('Enter');

  const added = row(page, 'live', PV_C);
  await expect(added).toBeVisible();
  await expect(rowStatus(added)).toHaveAttribute('aria-label', /not in snapshot/);
  await expect(rowStatus(added)).toHaveClass(/wb-outline-row__status--stale/);
  // Not drawn: no readout row, while the snapshot's curves stay drawn at Δ 0.
  hare.sendFrame(PV_C);
  await page.waitForTimeout(300);
  await expect(readout(page, PV_C)).toHaveCount(0);
  await expect(page.locator('.stats-readout tbody tr')).toHaveCount(2);
  await expectZeroDelta(page, PV_A);
  await expectZeroDelta(page, PV_B);
  hare.stop();
});

// ── Bars overlay ───────────────────────────────────────────────────────────

const BAR_LENGTH = 4;
/** Eight pure colours no theme uses, one per curve. */
const BAR_COLOURS: [number, number, number][] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [255, 0, 255],
  [0, 255, 255],
  [255, 128, 0],
  [128, 0, 255],
];
const hex = ([r, g, b]: [number, number, number]) =>
  `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;

interface Run {
  start: number;
  end: number;
}

/** Per colour, the runs of chart-canvas columns holding it. */
function barRuns(page: Page): Promise<Run[][]> {
  return page.evaluate((colours) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="waveform-chart"] canvas'
    );
    const empty = colours.map(() => [] as { start: number; end: number }[]);
    if (canvas === null) return empty;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return empty;
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    const columns = colours.map(() => new Uint8Array(width));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        for (let k = 0; k < colours.length; k++) {
          const c = colours[k];
          if (
            Math.abs(data[o] - c[0]) < 24 &&
            Math.abs(data[o + 1] - c[1]) < 24 &&
            Math.abs(data[o + 2] - c[2]) < 24
          ) {
            columns[k][x] = 1;
            break;
          }
        }
      }
    }
    return columns.map((cols) => {
      const runs: { start: number; end: number }[] = [];
      let start = -1;
      for (let x = 0; x <= width; x++) {
        const on = x < width && cols[x] === 1;
        if (on && start < 0) start = x;
        if (!on && start >= 0) {
          runs.push({ start, end: x - 1 });
          start = -1;
        }
      }
      return runs;
    });
  }, BAR_COLOURS);
}

test('bars from 8 curves overlay in one column per element', async ({ page }) => {
  const pvs = BAR_COLOURS.map((_, k) => `WF:BAR:${k}`);
  // Curve k stands 8 − k tall: drawn in curve order, every curve shows a band.
  const waveforms: Record<string, HareWaveform> = {};
  pvs.forEach((pv, k) => {
    waveforms[pv] = { length: BAR_LENGTH, hz: 0, value: () => 8 - k };
  });
  const hare = await openWaveform(
    page,
    query(pvs, {
      legend: '0',
      grid: '0',
      yauto: '0',
      ymin: '0',
      ymax: '9',
      plot: JSON.stringify({
        v: 1,
        traces: BAR_COLOURS.map((c) => ({ color: hex(c), lineType: 'bars' })),
      }),
    }),
    { waveforms }
  );

  await expect
    .poll(async () => (await barRuns(page)).map((runs) => runs.length), {
      message: 'one run per element for every curve',
    })
    .toEqual(BAR_COLOURS.map(() => BAR_LENGTH));

  // One column per element: every curve's bar sits where the first curve's does.
  const runs = await barRuns(page);
  const [first] = runs;
  for (let k = 1; k < runs.length; k++) {
    for (let e = 0; e < BAR_LENGTH; e++) {
      const a = first[e];
      const b = runs[k][e];
      expect(Math.abs(a.start - b.start), `curve ${k} element ${e} start`).toBeLessThanOrEqual(2);
      expect(Math.abs(a.end - b.end), `curve ${k} element ${e} end`).toBeLessThanOrEqual(2);
    }
  }
  hare.stop();
});

// ── X axis PV ──────────────────────────────────────────────────────────────

test('a length-mismatched curve is hidden with a chip and has no readout row; an unusable X axis PV puts every curve on index', async ({
  page,
}) => {
  const PV_M = 'WF:BEH:M';
  const PV_X = 'WF:BEH:X';
  const hare = await openWaveform(page, query([PV_A, PV_B, PV_M], { xs: PV_X, stats: '1' }), {
    waveforms: {
      [PV_A]: { length: LENGTH, hz: 0, value: () => 1 },
      [PV_B]: { length: LENGTH, hz: 0, value: () => 2 },
      [PV_M]: { length: 10, hz: 0, value: () => 3 },
      [PV_X]: { length: LENGTH, hz: 0, value: (i) => i * 0.5 },
    },
  });

  // Usable X axis PV: the 10-element curve is not drawn and its row says why.
  const mismatched = row(page, 'live', PV_M);
  await expect(rowStatus(mismatched)).toHaveAttribute(
    'aria-label',
    `Status: 10 elements; X axis PV has ${LENGTH}`
  );
  await expect(rowStatus(mismatched)).toHaveClass(/wb-outline-row__status--error/);
  await expect(readout(page, PV_A)).toBeVisible();
  await expect(readout(page, PV_B)).toBeVisible();
  await expect(readout(page, PV_M)).toHaveCount(0);
  await expect(page.locator('.stats-readout tbody tr')).toHaveCount(2);
  await expect(rowStatus(row(page, 'xsource', PV_X))).toHaveClass(/wb-outline-row__status--ok/);

  // The X axis is the X axis PV's: its title in the chart source is not "Element".
  const code = (await openChartSource(page)).locator('[data-field="waveform-code"]');
  // The source prints an object's id, type and name first: the title follows the type.
  const xTitle = async () =>
    /xAxis: \{\s*type: '\w+',\s*name: '([^']*)'/.exec(
      (await code.locator('pre').textContent()) ?? ''
    )?.[1] ?? null;
  // The title is the X axis PV's EGU (the Hare double reports mm).
  await expect.poll(xTitle).toBe('mm');

  // An X axis PV that matches no curve: every curve on index, axis "Element".
  hare.setWaveform(PV_X, { length: 7 });
  hare.sendFrame(PV_X);
  await expect(rowStatus(row(page, 'xsource', PV_X))).toHaveAttribute(
    'aria-label',
    'Status: length 7 matches no curve'
  );
  await expect(readout(page, PV_M)).toBeVisible();
  await expect(readout(page, PV_A)).toBeVisible();
  await expect(readout(page, PV_B)).toBeVisible();
  await expect(page.locator('.stats-readout tbody tr')).toHaveCount(3);
  // The 10-element curve is drawn whole on index.
  await expect.poll(async () => (await statsOf(page, PV_M))?.n ?? null).toBe(10);
  await expect(rowStatus(mismatched)).not.toHaveClass(/wb-outline-row__status--error/);
  await expect.poll(xTitle).toBe('Element');
  hare.stop();
});

// ── Styles across a Group move and a removal ───────────────────────────────

test("a curve's style survives a Group move and the removal of an earlier curve, readout label and swatch included", async ({
  page,
}) => {
  const PINNED = '#123456';
  const hare = await openWaveform(
    page,
    query([PV_A, PV_B, PV_C], {
      stats: '1',
      plot: JSON.stringify({ v: 1, traces: [{}, {}, { displayName: 'Cee', color: PINNED }] }),
    }),
    {
      waveforms: {
        [PV_A]: { length: LENGTH, hz: 0, value: () => 1 },
        [PV_B]: { length: LENGTH, hz: 0, value: () => 2 },
        [PV_C]: { length: LENGTH, hz: 0, value: () => 3 },
      },
    }
  );
  const pinned = async (group: 'live' | 'reference') => {
    const r = row(page, group, PV_C);
    await expect(r.locator('.wb-outline-row__name')).toHaveText('Cee');
    await expect(r.locator('.wb-outline-row__swatch input[type="color"]')).toHaveValue(PINNED);
  };
  await pinned('live');

  // Live → Reference by its Group select; back to Live by a row drag (a
  // Reference item has no Group field).
  const live = card(page, `live:${PV_C}`);
  await openCard(live);
  await live.locator('[data-field="group"] select').selectOption('reference');
  await expect(row(page, 'live', PV_C)).toHaveCount(0);
  await pinned('reference');

  await pointerDrag(
    page,
    row(page, 'reference', PV_C).locator('.wb-outline-row__name'),
    outlineSection(page, 'live')
  );
  await expect(row(page, 'reference', PV_C)).toHaveCount(0);
  await pinned('live');

  // An earlier curve leaves: C moves up a place and keeps its own style.
  // dnd-kit swallows every click for 50 ms after a drop (its pointer sensor's
  // document click guard); a user's next click comes later than that.
  await page.waitForTimeout(DND_CLICK_GUARD_MS);
  await row(page, 'live', PV_A).locator('.wb-outline-row__remove').click();
  await expect(row(page, 'live', PV_A)).toHaveCount(0);
  await pinned('live');
  await expect(readout(page, PV_C).locator('th')).toContainText('Cee');
  await expect(readout(page, PV_C).locator('.stats-readout__swatch')).toHaveCSS(
    'color',
    'rgb(18, 52, 86)'
  );
  hare.stop();
});

// ── Hide → show ────────────────────────────────────────────────────────────

test('hide → show drops the readout row and starts a fresh average', async ({ page }) => {
  let level = 0;
  const hare = await openWaveform(page, query([PV_A, PV_B], { avg: '4', stats: '1' }), {
    waveforms: {
      [PV_A]: { length: LENGTH, hz: 0, value: () => level },
      [PV_B]: { length: LENGTH, hz: 0, value: () => 5 },
    },
  });
  // Four frames at 0, then one at 8: the Average-4 window reads 2.
  for (let n = 0; n < 3; n++) hare.sendFrame(PV_A);
  await expectMean(page, PV_A, 0);
  level = 8;
  hare.setWaveform(PV_A, { value: () => level });
  hare.sendFrame(PV_A);
  await expectMean(page, PV_A, 2);

  const eye = row(page, 'live', PV_A).locator('.wb-outline-row__eye button');
  await eye.click();
  await expect(readout(page, PV_A)).toHaveCount(0);
  await expect(readout(page, PV_B)).toBeVisible();

  // Shown again: the first frame alone is the average (the old window would read 27).
  level = 100;
  hare.setWaveform(PV_A, { value: () => level });
  await row(page, 'live', PV_A).locator('.wb-outline-row__eye button').click();
  await expectMean(page, PV_A, 100);
  hare.sendFrame(PV_A);
  await page.waitForTimeout(200);
  await expectMean(page, PV_A, 100);
  hare.stop();
});
