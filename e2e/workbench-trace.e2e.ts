// Trace's sidebar gestures, one test per gesture, in a real
// browser against the built page with the shared Hare and Mole doubles.
//
// What is asserted, and why it matters:
//
//   * the pane's collapse button collapses the sidebar to a rail with one
//     expand target, and that target expands it again; both are written;
//   * the page opens with its opening selection's card (the first curve)
//     open in place, and a click on a card head closes and reopens it; a
//     collapsed page stays collapsed for that opening selection, while a
//     selection the user makes on the canvas (a drawing placed from the rail)
//     expands it with the drawing's card open; none of these is written;
//   * a reload restores the arrangement the page's own gestures wrote;
//   * two pages on one origin never change each other's sidebar, a write from
//     one never reverts a field the other wrote, a resize in one followed by
//     widening the other keeps the other's own width, and the next page opened
//     takes the last-written collapsed state and width;
//   * a viewport resize keeps the sidebar's px width and writes nothing;
//   * formula curves work embedded, against mocks of the validate and
//     evaluate POSTs the host relays: Add formula adds a curve that binds the
//     PV, validates and draws (the statistics readout counts its evaluated
//     points), and a `.trc.json` import keeps its formula curves and draws
//     them.
//
// Each test seeds the arrangement at most once (e2e/workbench.ts); a test
// that checks persistence changes it only through a gesture. A card drag onto
// a full section ("no drop") has no Trace instance and lives in the
// Correlation spec.

import { expect, test, type Locator, type Page } from '@playwright/test';

import { FORMULA_ENGINE_EVALUATE_POINTS, MOLE_PV, mockFormulaEngineRest } from './mocks';
import {
  cardNamed,
  dragEdge,
  openCard,
  openPlotSection,
  openTrace,
  panel,
  readArrangement,
  settleWrites,
  sidebar,
  sidebarWidth,
  waitForStored,
  type Arrangement,
} from './workbench';

const VIEWPORT = { width: 1280, height: 800 };
/** Width rounding of a px size through the panel library's percentages. */
const WIDTH_TOLERANCE_PX = 2;
/** The stored rail: the sidebar collapsed. */
const RAIL: Partial<Arrangement> = { collapsed: true };

test.use({ viewport: VIEWPORT });
test.describe.configure({ timeout: 60_000 });

const cards = (page: Page) => panel(page).locator('li[data-card-id]');
const firstCard = (page: Page) => cards(page).first();
const openCards = (page: Page) => panel(page).locator('li.wb-card--open');

const isRail = (s: Arrangement | null) => s?.collapsed === true;

test('the collapse button collapses to a rail with one target, which expands it', async ({
  page,
}) => {
  await openTrace(page);
  const bar = sidebar(page);
  await expect(bar.content).toBeVisible();

  await bar.collapse.click();

  await expect(bar.root).toHaveClass(/wb-sidebar--collapsed/);
  await expect(bar.rail.locator('.wb-sidebar__rail-target')).toHaveCount(1);
  await expect(bar.railTarget).toBeVisible();
  await expect(bar.pane).toBeHidden();
  await waitForStored(page, isRail);

  await bar.railTarget.click();
  await expect(bar.root).not.toHaveClass(/wb-sidebar--collapsed/);
  await expect(bar.content).toBeVisible();
  await expect(bar.rail).toHaveCount(0);
  await waitForStored(page, (s) => s?.collapsed === false);
});

test('the opening selection opens its card in place, and a card head click toggles it unwritten', async ({
  page,
}) => {
  await openTrace(page);
  const first = firstCard(page);
  // The opening selection (the first curve) fills the panel: its card is open.
  await expect(first).toHaveClass(/wb-card--open/);
  await expect(openCards(page)).toHaveCount(1);
  await expect(first.locator('.wb-card__body[data-level=item]')).toBeVisible();

  await first.locator('.wb-card__head .wb-outline-row__name').click();
  await expect(first).not.toHaveClass(/wb-card--open/);
  await expect(first.locator('.wb-card__body')).toHaveCount(0);
  await expect(openCards(page)).toHaveCount(0);

  await openCard(first);
  await expect(first.locator('.wb-card__head .wb-outline-row__name')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect(first.locator('#display-name')).toBeVisible();
  await settleWrites(page);
  expect(await readArrangement(page)).toBeNull();
});

/** The plot grid's box (the drawing overlay spans it). */
async function gridBox(page: Page) {
  const layer = page.locator('svg[data-annotation-layer]').first();
  await expect(layer).toBeAttached();
  const box = await layer.boundingBox();
  if (!box || box.width < 50 || box.height < 50) throw new Error('the plot grid has no box');
  return box;
}

test('a collapsed page stays collapsed for its opening selection; a canvas selection expands it unwritten', async ({
  page,
}) => {
  await openTrace(page, { arrangement: RAIL });
  const bar = sidebar(page);
  // The opening selection never reveals the panel.
  await expect(bar.root).toHaveClass(/wb-sidebar--collapsed/);
  await expect(bar.pane).toBeHidden();
  const seeded = await readArrangement(page);

  // An H-line placed from the drawing rail is selected on commit, by the user.
  const rail = page.locator('[data-drawing-rail]');
  await rail.locator('[data-drawing-tool="hline"]').click();
  await expect(rail.locator('[data-drawing-tool="hline"]')).toHaveAttribute('aria-pressed', 'true');
  const grid = await gridBox(page);
  await page.mouse.click(grid.x + grid.width * 0.5, grid.y + grid.height * 0.3);
  await expect(page.locator('[data-annotation-kind="hline"]')).toHaveCount(1);

  await expect(bar.root).not.toHaveClass(/wb-sidebar--collapsed/);
  await expect(bar.content).toBeVisible();
  const drawing = panel(page)
    .locator('li[data-card-id]')
    .filter({
      has: page.locator('.wb-card__head[data-section="annotations"]'),
    });
  await expect(drawing).toHaveCount(1);
  await expect(drawing).toHaveClass(/wb-card--open/);
  await expect(openCards(page)).toHaveCount(1);
  await settleWrites(page);
  expect(await readArrangement(page)).toEqual(seeded);
});

test('a reload restores the arrangement the page wrote', async ({ page }) => {
  await openTrace(page);
  const bar = sidebar(page);

  // Gestures only: widen the sidebar, then collapse it.
  await dragEdge(page, 80);
  const widened = await waitForStored(page, (s) => (s?.widthPx ?? 0) > 300);
  const width = await sidebarWidth(page);
  await bar.collapse.click();
  const stored = await waitForStored(page, (s) => isRail(s) && s?.widthPx === widened?.widthPx);

  await page.reload();
  await expect(page.locator('[data-testid=actions-bar]')).toBeVisible();

  await expect(bar.root).toHaveClass(/wb-sidebar--collapsed/);
  await expect(bar.railTarget).toBeVisible();
  expect(await readArrangement(page)).toEqual(stored);

  // Expanded again, the sidebar takes the width the page wrote.
  await bar.railTarget.click();
  await expect(bar.content).toBeVisible();
  await expect.poll(() => sidebarWidth(page)).toBeGreaterThanOrEqual(width - WIDTH_TOLERANCE_PX);
  expect(Math.abs((await sidebarWidth(page)) - stored!.widthPx)).toBeLessThanOrEqual(
    WIDTH_TOLERANCE_PX
  );
});

test('two pages on one origin never change or revert each other', async ({ page, context }) => {
  const other = await context.newPage();
  await openTrace(page);
  await openTrace(other);
  const a = sidebar(page);
  const b = sidebar(other);
  const widthB = await sidebarWidth(other);

  // A resizes; B's sidebar does not move.
  await dragEdge(page, 100);
  const stored = await waitForStored(page, (s) => (s?.widthPx ?? 0) > 350);
  const widthA = await sidebarWidth(page);
  expect(Math.abs((await sidebarWidth(other)) - widthB)).toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);

  // Widening B's tile re-applies B's own width, never A's.
  await other.setViewportSize({ width: VIEWPORT.width + 200, height: VIEWPORT.height });
  await other.waitForTimeout(300);
  expect(Math.abs((await sidebarWidth(other)) - widthB)).toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);

  // B collapses; its write keeps A's width, and A stays expanded at its width.
  await b.collapse.click();
  await expect(b.root).toHaveClass(/wb-sidebar--collapsed/);
  const merged = await waitForStored(other, isRail);
  expect(merged?.widthPx).toBe(stored?.widthPx);
  await expect(a.root).not.toHaveClass(/wb-sidebar--collapsed/);
  expect(Math.abs((await sidebarWidth(page)) - widthA)).toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);

  // The next page takes the last-written collapsed state and width.
  const third = await context.newPage();
  await openTrace(third);
  const c = sidebar(third);
  await expect(c.root).toHaveClass(/wb-sidebar--collapsed/);
  await c.railTarget.click();
  await expect(c.content).toBeVisible();
  await expect
    .poll(async () => Math.abs((await sidebarWidth(third)) - merged!.widthPx))
    .toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);
});

test('a viewport resize keeps the sidebar px width and writes nothing', async ({ page }) => {
  await openTrace(page);
  const width = await sidebarWidth(page);
  expect(Math.abs(width - 300)).toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);

  await page.setViewportSize({ width: 1000, height: VIEWPORT.height });
  await page.waitForTimeout(300);
  expect(Math.abs((await sidebarWidth(page)) - width)).toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);

  await page.setViewportSize({ width: 1600, height: VIEWPORT.height });
  await page.waitForTimeout(300);
  expect(Math.abs((await sidebarWidth(page)) - width)).toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);

  await settleWrites(page);
  expect(await readArrangement(page)).toBeNull();
});

// ── Formulas embedded ───────────────────────────────────────────────────────

/**
 * The statistics readout's `n` (the samples drawn in the view window) for the
 * curve `id`: Show statistics is turned on from the Statistics section.
 */
async function readoutCount(page: Page, id: string): Promise<Locator> {
  const statistics = await openPlotSection(page, 'statistics');
  const show = statistics.locator('[data-field="stats-show"]');
  const toggle = show.locator('[role="switch"]');
  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    // Carbon's toggle label covers its switch button: the label is what a user clicks.
    await show.locator('label[for="stats-show"]').click();
  }
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('readout-col-n')).toBeVisible();
  return page.getByTestId(`readout-${id}`).locator('td').first();
}

test('embedded, Add formula adds a formula curve that validates and draws', async ({ page }) => {
  await openTrace(page);
  const engine = await mockFormulaEngineRest(page);
  await expect(cards(page)).toHaveCount(1);

  const add = page.getByRole('button', { name: /^add formula/i });
  await expect(add).not.toHaveAttribute('aria-disabled', 'true');
  await add.click();
  await expect(cards(page)).toHaveCount(2);

  // The new formula is selected, so its card is the open one and holds its editor.
  await expect(openCards(page)).toHaveCount(1);
  const formula = openCards(page);
  const expression = formula.locator('#formula-expression');
  await expect(expression).toBeVisible();
  await expect(expression).toBeEditable();
  await expression.fill('{x1} * 2');
  await formula.locator('#formula-bind-x1').selectOption({ index: 1 });

  await expect(page.locator('.trace-formula__valid')).toHaveText('Valid');
  await expect(page.getByText(/formulas are not available here/i)).toHaveCount(0);
  expect(engine.validated.at(-1)).toMatchObject({
    expression: '{x1} * 2',
    bindings: { x1: MOLE_PV },
  });

  await expect.poll(() => engine.evaluated.length).toBeGreaterThan(0);
  expect(engine.evaluated.at(-1)?.spec).toMatchObject({
    kind: 'timeseries',
    expression: '{x1} * 2',
    bindings: { x1: MOLE_PV },
  });
  const id = await formula.getAttribute('data-card-id');
  expect(id).not.toBeNull();
  await expect(await readoutCount(page, id!)).toHaveText(String(FORMULA_ENGINE_EVALUATE_POINTS));
});

test('embedded, a .trc.json import keeps its formula curves and draws them', async ({ page }) => {
  await openTrace(page);
  const engine = await mockFormulaEngineRest(page);
  const axis = {
    id: 'imp-ax',
    name: 'Y',
    orientation: 'left',
    autoScale: true,
    logScale: false,
    visible: true,
  };
  const curve = {
    color: '#0f62fe',
    visible: true,
    axisId: axis.id,
    useLive: false,
    lineWidth: 1,
    lineType: 'step',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'none',
    symbolSize: 4,
    data: [],
  };
  const workspace = {
    schemaVersion: 1,
    savedAt: '2026-10-01T00:00:00Z',
    theme: 'light',
    plots: [
      {
        id: 'imp-plot',
        title: 'Imported',
        axes: [axis],
        backgroundColor: '#ffffff',
        showLegend: true,
        showXGridlines: true,
        showYGridlines: true,
        showCrosshair: false,
        gridStyle: 'solid',
        gridOpacity: 1,
        tickFontSize: 11,
        xAxis: { timeRange: '10m' },
        traces: [
          {
            ...curve,
            id: 'imp-pv',
            pvName: MOLE_PV,
            displayName: 'Imported PV curve',
            useArchive: true,
          },
          {
            ...curve,
            id: 'imp-f',
            kind: 'formula',
            pvName: '',
            displayName: 'Imported formula curve',
            color: '#da1e28',
            useArchive: false,
            expression: '{x1} + 1',
            bindings: { x1: 'imp-pv' },
          },
        ],
      },
    ],
  };

  const chooser = page.waitForEvent('filechooser');
  await page
    .getByTestId('actions-bar')
    .getByRole('button', { name: /^import/i })
    .click();
  await (
    await chooser
  ).setFiles({
    name: 'workspace.trc.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(workspace)),
  });

  const names = panel(page).locator('.wb-card__head .wb-outline-row__name');
  await expect(names.filter({ hasText: 'Imported PV curve' })).toHaveCount(1);
  await expect(names.filter({ hasText: 'Imported formula curve' })).toHaveCount(1);

  await expect.poll(() => engine.evaluated.length).toBeGreaterThan(0);
  expect(engine.evaluated.at(-1)?.spec).toMatchObject({
    expression: '{x1} + 1',
    bindings: { x1: MOLE_PV },
  });

  const formula = cardNamed(page, 'Imported formula curve');
  await openCard(formula);
  await expect(formula.locator('#formula-expression')).toHaveValue('{x1} + 1');
  const id = await formula.getAttribute('data-card-id');
  expect(id).not.toBeNull();
  await expect(await readoutCount(page, id!)).toHaveText(String(FORMULA_ENGINE_EVALUATE_POINTS));
});
