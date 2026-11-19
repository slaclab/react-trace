// Waveform's drawing tools in a real browser against the built page, embedded (`embedded=true`), so the
// page writes its state, drawings included, back into its own URL as `ann=`.
//
// What is asserted, and why it matters:
//
//   * each of the six Waveform tools (H-line, V-line, trend, box, note,
//     measure) is placed from the rail, reshaped by a handle, deleted, brought
//     back by primary+Z, and restored by a reload through `ann=`: every tool
//     must round-trip its own geometry through the link;
//   * an edit in a drawing's card (a box's Colour) is undone by primary+Z
//     with focus still in the sidebar: the undo key is bound on the document;
//   * the Measure card is a "Δx = … Δy = …" header and one row per visible
//     live curve over the measured span — its element count and mean match what
//     the frame puts there, a hidden curve has no row, and the rows follow the
//     next frame (the card reads the latest publish, not the one it was drawn
//     on);
//   * switching the X axis from the X axis PV to the element index hides the
//     drawings placed against the source ("x source changed") but not an
//     H-line, and switching back restores them;
//   * turning Subtract reference on hides the drawings placed without Δ
//     ("Δ changed"), turning it off restores them;
//   * link overflow: past the 4 KB budget the status line says so; note
//     texts are cut first and no drawing is dropped while that is enough; past
//     that a drawing is dropped from the end, the link stays within budget,
//     and, reloaded, opens with exactly the drawings it carries;
//   * Export PNG composes the overlay: the image with the drawings carries the
//     box's off-palette colour, the one with Hide all on does not;
//   * drawings stay put across live frames: at 10 Hz of identical frames the
//     drawings neither move nor re-render (no DOM mutation in their subtree),
//     and the link does not change.
//
// The Hare double serves every curve as a 16-element waveform. The specs that
// need a known frame drive it frame by frame (`hz: 0`, `sendFrame`), so no
// frame arrives between a gesture and the check that follows it. Waveform
// publishes while the document is visible, so an embedded page needs no host
// message to start.

import { readFile } from 'node:fs/promises';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { mockHare, mockMole, type HareMock, type HareWaveform } from './mocks';
import { readoutTerms, TERM_GAP } from './readout';
import {
  drawingCard,
  openCard,
  openPlotSection,
  panel,
  swatchHex,
  waitForWorkbench,
} from './workbench';

const VIEWPORT = { width: 1280, height: 800 };
const PV_A = 'WF:DRAW:A';
const PV_B = 'WF:DRAW:B';
const PV_REF = 'WF:DRAW:REF';
const PV_X = 'WF:DRAW:X';
const LENGTH = 16;
/** Off the drawing palette, so the link keeps it and the PNG check can find it. */
const EDITED_COLOUR = '#123456';
const COLOUR_TOLERANCE = 6;
const MIN_BOX_PIXELS = 200;
/** The link budget (MAX_QUERY_BYTES), page keys included. */
const MAX_QUERY_BYTES = 4096;
/** What the page keys of an embedded page take in front of the query (`embedded=true&`). */
const PAGE_KEY_RESERVE = 'embedded=true&'.length;
/** A note's text in the link once cut: NOTE_TRIM_POINTS code points plus '…'. */
const NOTE_TRIM_POINTS = 24;
/** The longest drawing text (MAX_ANNOTATION_TEXT). */
const MAX_TEXT = 200;
/** Catalog codes (WAVEFORM_CATALOG). */
const CODE = { hline: 0, vline: 1, trend: 3, box: 4, note: 5, measure: 6 } as const;

test.use({ viewport: VIEWPORT });
test.describe.configure({ timeout: 90_000 });

// ── Data ────────────────────────────────────────────────────────────────────

/** A rises one per element and one per frame; B is twice A's profile, offset, also one per frame. */
const valueA = (i: number, frame: number) => i + frame;
const valueB = (i: number, frame: number) => 2 * i + 4 + frame;

function defaultWaveforms(hz = 0): Record<string, HareWaveform> {
  return {
    [PV_A]: { length: LENGTH, hz, value: valueA },
    [PV_B]: { length: LENGTH, hz, value: valueB },
    [PV_REF]: { length: LENGTH, hz, value: (i) => i },
    // The X axis PV: element i sits at x = 10 + 2i, so index and source differ.
    [PV_X]: { length: LENGTH, hz, value: (i) => 10 + 2 * i },
  };
}

// ── The page ────────────────────────────────────────────────────────────────

interface PageOptions {
  pvs?: string[];
  /** Extra keys, in the serializer's order (ref, xs, ...). */
  head?: string[];
  /** An `ann=` value, already encoded (see `encodeAnn`). */
  ann?: string;
  waveforms?: Record<string, HareWaveform>;
}

/** The query, keys in the serializer's order (pv, head keys, ann). */
function pageQuery({ pvs = [PV_A, PV_B], head = [], ann }: PageOptions = {}): string {
  const parts = [...pvs.map((pv) => `pv=${pv}`), ...head];
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

/** Installs the doubles (503 for anything unmocked, Hare, Mole), opens the page. */
async function openPage(page: Page, options: PageOptions = {}): Promise<HareMock> {
  await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
  const hare = await mockHare(page, { waveforms: options.waveforms ?? defaultWaveforms() });
  await mockMole(page);
  await page.goto(`/waveform.html?embedded=true&${pageQuery(options)}`);
  await showPage(page);
  return hare;
}

async function showPage(page: Page): Promise<void> {
  await waitForWorkbench(page);
  await expect(page.getByTestId('waveform-app')).toBeVisible();
  await waitForPlotted(page);
}

async function reloadPage(page: Page): Promise<void> {
  await page.reload();
  await showPage(page);
}

/**
 * Waits until the overlay can take a gesture: the overlay's box has stopped
 * moving, and a pointer over its centre reads a value in the status line,
 * which it does only once the grid's scales are laid out over the frame.
 */
async function waitForPlotted(page: Page): Promise<void> {
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

// ── The link ────────────────────────────────────────────────────────────────

type Tuple = [number, number[], number, number | null, string?, string?, string?, number?];

interface AnnValue {
  r: string[];
  b: { x: string; d?: 1 }[];
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

/** The whole search part of the URL, page keys included, in bytes. */
function searchBytes(page: Page): number {
  return byteLength(new URL(page.url()).search.slice(1));
}

// ── Locators and gestures ───────────────────────────────────────────────────

const layers = (page: Page) => page.locator('svg[data-annotation-layer]');
const drawings = (page: Page, kind?: string) =>
  page.locator(kind === undefined ? '[data-annotation-kind]' : `[data-annotation-kind="${kind}"]`);
const rail = (page: Page) => page.locator('[data-drawing-rail]');
const drawingRows = (page: Page) =>
  panel(page).locator('.wb-outline-row[data-section="annotations"]');
const liveRow = (page: Page, pv: string) =>
  page.locator(`.wb-outline-row[data-row-id="live:${pv}"]`);
const shedNotice = (page: Page) => page.locator('[data-status-shed-notice]');
const rowNamed = (page: Page, name: RegExp) =>
  drawingRows(page).filter({ has: page.locator('.wb-outline-row__name', { hasText: name }) });

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The grid's overlay box, in page px. */
async function gridBox(page: Page): Promise<Box> {
  const layer = layers(page).first();
  await expect(layer).toBeAttached();
  const box = await layer.boundingBox();
  if (!box || box.width < 50 || box.height < 50) throw new Error('the grid has no box');
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

/** A drawing row's status: its hidden reason (title) and class when dimmed. */
const statusOf = (row: Locator) => row.locator('.wb-outline-row__status');

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

/** The six tools, with their link code and card name. */
const TOOLS: { kind: keyof typeof CODE; row: RegExp; a: [number, number] }[] = [
  { kind: 'hline', row: /^H-line/, a: [0.3, 0.4] },
  { kind: 'vline', row: /^V-line/, a: [0.6, 0.5] },
  { kind: 'trend', row: /^Trend/, a: [0.2, 0.7] },
  { kind: 'box', row: /^Box/, a: [0.2, 0.7] },
  { kind: 'note', row: /^Note/, a: [0.3, 0.6] },
  { kind: 'measure', row: /^Measure/, a: [0.2, 0.7] },
];

for (const tool of TOOLS) {
  test(`${tool.kind}: place, reshape, delete, undo, restore through ann=`, async ({ page }) => {
    await openPage(page);
    const grid = await gridBox(page);

    // ── Place ───────────────────────────────────────────────────────────────
    await place(page, tool.kind, grid, tool.a);
    const placed = await waitForAnn(page, 1);
    expect(placed.d[0][0]).toBe(CODE[tool.kind]);
    // Placed against the element index, without Δ.
    expect(placed.b).toEqual([{ x: 'index' }]);
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

interface CardRow {
  /** The curve's name; '' when the card reads one curve and so names none. */
  name: string;
  n: number;
  mean: number;
}

/**
 * The card's lines: the `Δx = … Δy = …` header and one `n = … x̄ = … σ = …`
 * row per curve, each prefixed `<name>:` when the card reads several curves
 * (src/tools/waveform/measure.ts `waveformMeasureLines`), parsed.
 */
async function readCard(page: Page): Promise<{ dx: number; dy: number; rows: CardRow[] }> {
  const lines = await drawings(page, 'measure')
    .locator('[data-measure-card] text')
    .allTextContents();
  const header = readoutTerms(lines[0] ?? '');
  if (!('Δx' in header) || !('Δy' in header)) {
    throw new Error(`no Δx Δy header: ${JSON.stringify(lines)}`);
  }
  const rows = lines.slice(1).map((line) => {
    const [first] = line.split(TERM_GAP);
    const named = first.endsWith(':') && !first.includes(' = ');
    const terms = readoutTerms(line);
    if (!('n' in terms) || !('x̄' in terms)) throw new Error(`not a curve row: ${line}`);
    return { name: named ? first.slice(0, -1) : '', n: terms.n, mean: terms['x̄'] };
  });
  return { dx: header['Δx'], dy: header['Δy'], rows };
}

/** The 4-significant-digit text the card writes, read back. */
const shown = (v: number) => Number(v.toPrecision(4));

test('the Measure card reads each visible curve over its span and follows the next frame', async ({
  page,
}) => {
  const hare = await openPage(page);
  const grid = await gridBox(page);
  await place(page, 'measure', grid, [0.25, 0.9], [0.75, 0.1]);
  const ann = await waitForAnn(page, 1);
  const [x1, y1, x2, y2] = ann.d[0][1];
  const inside = Array.from({ length: LENGTH }, (_, i) => i).filter(
    (i) => i >= Math.min(x1, x2) && i <= Math.max(x1, x2)
  );
  expect(inside.length).toBeGreaterThan(2);
  expect(inside.length).toBeLessThan(LENGTH);
  const meanOf = (value: (i: number, f: number) => number, frame: number) =>
    inside.reduce((s, i) => s + value(i, frame), 0) / inside.length;

  const expectCard = async (frame: number, pvs: string[]) => {
    await expect
      .poll(async () => JSON.stringify((await readCard(page)).rows), { timeout: 10_000 })
      .toBe(
        JSON.stringify(
          pvs.map((pv) => ({
            // One curve: the card names none.
            name: pvs.length > 1 ? pv : '',
            n: inside.length,
            mean: shown(meanOf(pv === PV_A ? valueA : valueB, frame)),
          }))
        )
      );
  };

  // ── Header and one row per curve, at the `initial` (frame 0) ────────────
  const card = await readCard(page);
  expect(card.dx).toBe(shown(Math.abs(x2 - x1)));
  expect(card.dy).toBe(shown(y2 - y1));
  await expectCard(0, [PV_A, PV_B]);

  // ── The next frame: every curve rises by one ────────────────────────────
  hare.sendFrame(PV_A);
  hare.sendFrame(PV_B);
  await expectCard(1, [PV_A, PV_B]);

  // ── A hidden curve has no row; shown again, it has ──────────────────────
  const eye = liveRow(page, PV_B).locator('.wb-outline-row__eye button');
  await eye.click();
  await expectCard(1, [PV_A]);
  await eye.click();
  // Shown again, B's stream restarts (the double may resend its `initial`),
  // so its mean is whichever frame landed: the row and its count are the check.
  await expect
    .poll(async () => JSON.stringify((await readCard(page)).rows.map((r) => [r.name, r.n])), {
      timeout: 10_000,
    })
    .toBe(
      JSON.stringify([
        [PV_A, inside.length],
        [PV_B, inside.length],
      ])
    );
  expect((await readCard(page)).rows[0].mean).toBe(shown(meanOf(valueA, 1)));
});

// ── Switching the x source ──────────────────────────────────────────────────

test('switching the X axis to the index hides the drawings placed against the X axis PV, switching back restores them', async ({
  page,
}) => {
  await openPage(page, { head: [`xs=${PV_X}`] });
  const grid = await gridBox(page);
  await place(page, 'box', grid, [0.2, 0.7], [0.6, 0.3]);
  await place(page, 'hline', grid, [0.5, 0.2]);
  const ann = await waitForAnn(page, 2);
  expect(ann.b.map((b) => b.x)).toEqual([`src:${PV_X}`]);
  // Placed on the X axis PV's values: x = 10 + 2i, so past every element index.
  const boxTuple = ann.d.find((t) => t[0] === CODE.box)!;
  expect(Math.min(boxTuple[1][0], boxTuple[1][2])).toBeGreaterThanOrEqual(10);

  const box = drawings(page, 'box');
  const hline = drawings(page, 'hline');
  const boxRow = rowNamed(page, /^Box/);
  const hlineRow = rowNamed(page, /^H-line/);

  await page.keyboard.press('Escape');
  const xAxis = (await openPlotSection(page, 'axes')).locator('[data-field="x-axis"]');
  await xAxis.getByRole('radio', { name: 'Element #' }).click();
  await expect(xAxis.getByRole('radio', { name: 'Element #' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await expect(box).toHaveCount(0);
  await expect(hline).toHaveCount(1);
  await expect(drawingRows(page)).toHaveCount(2);
  await expect(statusOf(boxRow)).toHaveClass(/wb-outline-row__status--stale/);
  await expect(statusOf(boxRow)).toHaveAttribute('title', /x source changed/);
  await expect(statusOf(hlineRow)).not.toHaveClass(/wb-outline-row__status--stale/);
  // Hidden, not deleted: the link still carries both.
  await expect.poll(() => new URL(page.url()).searchParams.get('xaxis')).toBe('index');
  expect(urlAnn(page)?.d).toHaveLength(2);

  await xAxis.getByRole('radio', { name: 'X axis PV' }).click();
  await expect(box).toHaveCount(1);
  await expect(hline).toHaveCount(1);
  await expect(statusOf(boxRow)).not.toHaveClass(/wb-outline-row__status--stale/);
});

// ── Toggling Δ ──────────────────────────────────────────────────────────────

/** Flips Subtract reference from the Reference group's settings; asserts it reads `on`. */
async function setSubtract(page: Page, on: boolean): Promise<void> {
  const field = panel(page).locator('.wb-outline [data-field="subtract-reference"]');
  const toggle = field.locator('[role="switch"]');
  await expect(toggle).toHaveAttribute('aria-checked', String(!on));
  // Carbon's toggle label covers its switch button: the label is what a user clicks.
  await field.locator('label[for="subtract-reference"]').click();
  await expect(toggle).toHaveAttribute('aria-checked', String(on));
}

test('turning Δ on hides the drawings placed without it, turning it off restores them', async ({
  page,
}) => {
  await openPage(page, { head: [`ref=${PV_REF}`] });
  const grid = await gridBox(page);
  await place(page, 'box', grid, [0.2, 0.7], [0.6, 0.3]);
  await place(page, 'hline', grid, [0.5, 0.2]);
  const ann = await waitForAnn(page, 2);
  expect(ann.b).toEqual([{ x: 'index' }]);
  const boxRow = rowNamed(page, /^Box/);

  await page.keyboard.press('Escape');
  await setSubtract(page, true);
  await expect.poll(() => new URL(page.url()).searchParams.get('delta')).toBe('1');
  await expect(drawings(page)).toHaveCount(0);
  await expect(drawingRows(page)).toHaveCount(2);
  await expect(statusOf(boxRow)).toHaveClass(/wb-outline-row__status--stale/);
  await expect(statusOf(boxRow)).toHaveAttribute('title', /Δ changed/);
  // Hidden, not deleted: the link still carries both.
  expect(urlAnn(page)?.d).toHaveLength(2);

  await setSubtract(page, false);
  await expect(drawings(page, 'box')).toHaveCount(1);
  await expect(drawings(page, 'hline')).toHaveCount(1);
  await expect(statusOf(boxRow)).not.toHaveClass(/wb-outline-row__status--stale/);
});

// ── Link overflow ───────────────────────────────────────────────────────────

test('link overflow: notes are cut first, then drawings dropped; the link reloads as reported', async ({
  page,
}) => {
  // A seed link just under the budget: one long note, and a second live PV
  // whose long name (never shed before the drawings) takes up the rest.
  const longNote = 'a'.repeat(MAX_TEXT);
  const seedAnn = encodeAnn({
    r: ['y'],
    b: [{ x: 'index' }],
    d: [[CODE.note, [4.5, 6], 0, null, '', longNote, '', 0]],
  });
  const target = MAX_QUERY_BYTES - PAGE_KEY_RESERVE - 70;
  const bare = byteLength(pageQuery({ pvs: [PV_A, 'WF:P'], ann: seedAnn }));
  const pad = `WF:P${'p'.repeat(target - bare)}`;
  const options: PageOptions = {
    pvs: [PV_A, pad],
    ann: seedAnn,
    waveforms: { ...defaultWaveforms(), [pad]: { length: LENGTH, hz: 0, value: valueB } },
  };
  expect(byteLength(pageQuery(options))).toBe(target);

  await openPage(page, options);
  await expect(drawings(page, 'note')).toHaveCount(1);
  await expect(drawings(page, 'note').locator('[data-annotation-label]')).toHaveText(longNote);
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
  expect(searchBytes(page)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
  // Both live PVs are still in the link: drawings shed before PVs.
  expect(new URL(page.url()).searchParams.getAll('pv')).toEqual([PV_A, pad]);
  // The page still holds the full texts.
  await expect(drawings(page, 'note').first().locator('[data-annotation-label]')).toHaveText(
    longNote
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
  expect(dropped.d.map((t) => t[0])).toEqual([CODE.note, CODE.note]);
  for (const tuple of dropped.d) {
    expect([...(tuple[5] ?? '')].length).toBeLessThanOrEqual(NOTE_TRIM_POINTS + 1);
  }
  expect(searchBytes(page)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
  expect(new URL(page.url()).searchParams.getAll('pv')).toEqual([PV_A, pad]);
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
  const withDrawings = await exportPng(page);

  const hide = rail(page).locator('[data-drawing-toggle="hide"]');
  await hide.click();
  await expect(hide).toHaveAttribute('aria-pressed', 'true');
  await expect(box).toHaveCount(0);
  await parkPointer(page);
  const hidden = await exportPng(page);

  expect(withDrawings.equals(hidden)).toBe(false);
  const report = await editedPixels(page, withDrawings, hidden);
  expect(report.sameSize).toBe(true);
  expect(report.a).toBeGreaterThan(MIN_BOX_PIXELS);
  expect(report.b * 10).toBeLessThan(report.a);

  await hide.click();
  await expect(hide).toHaveAttribute('aria-pressed', 'false');
  await expect(box).toHaveCount(1);
});

// ── Live frames ─────────────────────────────────────────────────────────────

test('drawings stay put across live frames', async ({ page }) => {
  // 10 Hz of identical frames: nothing a drawing depends on changes.
  const still = (i: number) => i;
  const hare = await openPage(page, {
    waveforms: {
      [PV_A]: { length: LENGTH, hz: 10, value: still },
      [PV_B]: { length: LENGTH, hz: 10, value: (i) => 2 * i + 4 },
    },
  });
  const grid = await gridBox(page);
  await place(page, 'box', grid, [0.2, 0.7], [0.6, 0.3]);
  await place(page, 'hline', grid, [0.5, 0.2]);
  await place(page, 'note', grid, [0.7, 0.5]);
  const ann = await waitForAnn(page, 3);
  await page.keyboard.press('Escape');
  await parkPointer(page);

  const shapes = async () =>
    Promise.all(
      ['box', 'hline', 'note'].map(async (kind) =>
        JSON.stringify(await drawings(page, kind).boundingBox())
      )
    );
  const before = await shapes();

  // Count every DOM change under the drawings from here on.
  await page.evaluate(() => {
    const w = window as unknown as { __drawingMutations: number };
    w.__drawingMutations = 0;
    const observer = new MutationObserver((records) => {
      w.__drawingMutations += records.length;
    });
    for (const g of document.querySelectorAll('[data-annotation-kind]')) {
      observer.observe(g, {
        subtree: true,
        attributes: true,
        childList: true,
        characterData: true,
      });
    }
  });

  const sent = hare.frames.filter((f) => f.pv === PV_A).length;
  await expect
    .poll(() => hare.frames.filter((f) => f.pv === PV_A).length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(sent + 10);

  expect(await shapes()).toEqual(before);
  expect(
    await page.evaluate(
      () => (window as unknown as { __drawingMutations: number }).__drawingMutations
    )
  ).toBe(0);
  expect(urlAnn(page)).toEqual(ann);
  hare.stop();
});
