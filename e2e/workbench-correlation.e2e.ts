// Correlation on the workbench end to end: the sidebar gestures on the
// shared workbench helper (e2e/workbench.ts), the one gesture only Correlation
// has (a row dragged onto a full section is refused), and the Trigger's Fire
// on control reaching the Formula Engine subscription.
//
// What is asserted, and why it matters:
//
//   * the tool-agnostic gestures hold on Correlation as on Trace: the collapse
//     button collapses to a rail whose one target expands it, a card head
//     click opens that card in place (one open at a time) without writing,
//     and a reload restores what the page's own gestures wrote;
//   * while the X card is dragged over a Y section already holding 8 PVs, that
//     section shows "no drop" with its reason ("Y is full (8/8)"), and the
//     release moves nothing: a refused drop must be visible before the user
//     lets go, and must not half-apply after;
//   * switching an open page's Fire on from Every update to Rising
//     resubscribes the Formula Engine with a spec carrying `triggerEdge: 'rising'`, after an
//     unsubscribe of the old one. The first spec carries no `triggerEdge`.
//     Which rows the Formula Engine then answers is pinned by the Formula Engine's own tests, not here.
//
// Every page is standalone (no `embedded=true`), so it subscribes its table at
// once; a local Formula Engine socket double answers every subscribe and records each
// spec, which the shared `mockFormulaEngine` (first subscribe only) cannot.

import { expect, test, type Locator, type Page, type WebSocketRoute } from '@playwright/test';

import { FORMULA_ENGINE_PATH, mockHare, mockMole, pathEndsWith } from './mocks';
import {
  card,
  openCard,
  outlineSection,
  readArrangement,
  seedArrangement,
  settleWrites,
  sidebar,
  waitForStored,
  waitForWorkbench,
  type Arrangement,
} from './workbench';

test.use({ viewport: { width: 1280, height: 800 } });
test.describe.configure({ timeout: 60_000 });

const PV_X = 'CORR:X';
const PV_Y = 'CORR:Y1';
const PV_TRIG = 'CORR:TRIG';
/** Correlation's Y capacity (MAX_Y, src/tools/correlation/query.ts). */
const MAX_Y = 8;
const ROWS = 16;

/** One recorded Formula Engine message: a subscribe with its spec, or an unsubscribe. */
interface FormulaEngineMessage {
  type: string;
  id?: string;
  spec?: {
    kind?: string;
    columns?: Record<string, string>;
    bindings?: Record<string, string>;
    trigger?: unknown;
    triggerEdge?: unknown;
  };
}

/** The Formula Engine socket double: every message the page sent, in order. */
interface FormulaEngineRecorder {
  messages: FormulaEngineMessage[];
}

/** One small table frame answering a subscription. */
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

/** A Formula Engine socket double that answers every table subscribe and records each message. */
async function recordFormulaEngine(page: Page): Promise<FormulaEngineRecorder> {
  const recorder: FormulaEngineRecorder = { messages: [] };
  let counter = 0;
  await page.routeWebSocket(pathEndsWith(FORMULA_ENGINE_PATH), (ws: WebSocketRoute) => {
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as FormulaEngineMessage;
      recorder.messages.push(msg);
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
  return recorder;
}

/** The standalone Correlation page for an X PV, Y PVs and an optional Trigger PV. */
function correlationPath(x: string, ys: string[], trig?: string): string {
  const q = new URLSearchParams();
  q.set('x', x);
  for (const y of ys) q.append('y', y);
  if (trig !== undefined) q.set('trig', trig);
  else q.set('dt', '1');
  q.set('lookback', '1h');
  return `/correlation.html?${q.toString()}`;
}

/**
 * The Correlation page on the workbench: every unmocked backend path answers
 * 503, then Hare, Mole and the recording Formula Engine double; seeds the arrangement when
 * asked, and waits for the workbench and the plot.
 */
async function openCorrelation(
  page: Page,
  path: string,
  arrangement?: Partial<Arrangement>
): Promise<FormulaEngineRecorder> {
  await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
  await mockHare(page);
  await mockMole(page);
  const engine = await recordFormulaEngine(page);
  if (arrangement) await seedArrangement(page, arrangement);
  await page.goto(path);
  await waitForWorkbench(page);
  await expect(page.locator('.correlation-plot__chart')).toBeVisible();
  return engine;
}

// ── Locators ────────────────────────────────────────────────────────────────

/** The card head (the Outline row) of `pv` in the section `role`. */
function row(page: Page, role: 'x' | 'y' | 'trig', pv: string): Locator {
  return page.locator(`.wb-outline-row[data-row-id="${role}:${pv}"]`);
}

function section(page: Page, role: 'x' | 'y' | 'trig'): Locator {
  return outlineSection(page, role);
}

async function centre(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no box for ${locator}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const isRail = (s: Arrangement | null) => s?.collapsed === true;

// ── Sidebar gestures ────────────────────────────────────────────────────────

test.describe('workbench gestures on Correlation', () => {
  const GESTURE_PAGE = correlationPath(PV_X, [PV_Y]);

  test('the collapse button collapses to a rail, its one target expands', async ({ page }) => {
    await openCorrelation(page, GESTURE_PAGE);
    const bar = sidebar(page);

    await bar.collapse.click();

    await expect(bar.root).toHaveClass(/wb-sidebar--collapsed/);
    await expect(bar.rail.locator('.wb-sidebar__rail-target')).toHaveCount(1);
    await waitForStored(page, isRail);
    await bar.railTarget.click();
    await expect(bar.root).not.toHaveClass(/wb-sidebar--collapsed/);
    await expect(bar.content).toBeVisible();
  });

  test('a card head click opens that card in place, one at a time, unwritten', async ({ page }) => {
    await openCorrelation(page, GESTURE_PAGE);
    const y = card(page, `y:${PV_Y}`);
    const x = card(page, `x:${PV_X}`);

    await openCard(y);
    await expect(y.locator('.wb-card__body[data-level=item]')).toBeVisible();
    await expect(page.locator('li.wb-card--open')).toHaveCount(1);

    await openCard(x);
    await expect(y).not.toHaveClass(/wb-card--open/);
    await expect(page.locator('li.wb-card--open')).toHaveCount(1);
    await settleWrites(page);
    expect(await readArrangement(page)).toBeNull();
  });

  test('a reload restores the arrangement the page wrote', async ({ page }) => {
    await openCorrelation(page, GESTURE_PAGE);
    const bar = sidebar(page);

    await bar.collapse.click();
    const stored = await waitForStored(page, isRail);

    await page.reload();
    await expect(page.locator('[data-testid=actions-bar]')).toBeVisible();

    await expect(bar.root).toHaveClass(/wb-sidebar--collapsed/);
    await expect(bar.railTarget).toBeVisible();
    await expect(bar.pane).toBeHidden();
    expect(await readArrangement(page)).toEqual(stored);
  });

  test('a row dragged onto a full section shows "no drop" with the reason and moves nothing', async ({
    page,
  }) => {
    const ys = Array.from({ length: MAX_Y }, (_, i) => `CORR:Y${i + 1}`);
    await openCorrelation(page, correlationPath(PV_X, ys));
    const source = row(page, 'x', PV_X);
    const full = section(page, 'y');
    await expect(full.locator('.wb-outline-section__count')).toHaveText(`${MAX_Y}/${MAX_Y}`);

    // pointerDrag releases on arrival; the refusal shows only while the drag
    // is held, so this drag is pressed by hand and released after the check.
    const from = await centre(source);
    const to = await centre(full.locator('.wb-outline-section__header'));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 4, from.y + 4, { steps: 2 });
    await page.mouse.move(from.x + 12, from.y + 12, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.move(to.x, to.y + 1, { steps: 1 });

    await expect(full).toHaveClass(/wb-outline-section--no-drop/);
    await expect(full).toHaveAttribute('title', 'Y is full (8/8)');
    await expect(full.locator('.wb-outline-section__no-drop')).toHaveText('Y is full (8/8)');

    await page.mouse.up();

    await expect(full).not.toHaveClass(/wb-outline-section--no-drop/);
    await expect(full.locator('.wb-outline-section__no-drop')).toHaveCount(0);
    await expect(source).toHaveAttribute('data-section', 'x');
    await expect(full.locator('.wb-outline-section__count')).toHaveText(`${MAX_Y}/${MAX_Y}`);
    await expect(full.locator('.wb-outline-row')).toHaveCount(MAX_Y);
    expect(new URL(page.url()).searchParams.get('x')).toBe(PV_X);
  });
});

// ── Fire on ─────────────────────────────────────────────────────────────────

test.describe('Fire on reaches the Formula Engine subscription', () => {
  test('Every update to Rising resubscribes with triggerEdge "rising"', async ({ page }) => {
    const engine = await openCorrelation(page, correlationPath(PV_X, [PV_Y], PV_TRIG));
    const subscribes = () => engine.messages.filter((m) => m.type === 'subscribe');
    // The plot draws before the table subscribes (PV metadata comes first).
    await expect
      .poll(() => subscribes().length, { message: 'the first Formula Engine subscribe' })
      .toBe(1);
    const first = subscribes()[0]!.spec!;
    expect(first.trigger).toBeDefined();
    expect('triggerEdge' in first).toBe(false);

    // The Trigger's settings sit under its card in the Outline.
    const fire = section(page, 'trig').locator('.wb-outline-section__settings #trigger-fire');
    await expect(fire.getByRole('radio', { name: 'Every update' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await fire.getByRole('radio', { name: 'Rising' }).click();
    await expect(fire.getByRole('radio', { name: 'Rising' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    await expect
      .poll(() => subscribes().length, { message: 'a second Formula Engine subscribe' })
      .toBe(2);
    const second = subscribes()[1]!.spec!;
    expect(second.triggerEdge).toBe('rising');
    expect(second.trigger).toEqual(first.trigger);
    const firstAt = engine.messages.indexOf(subscribes()[0]!);
    const secondAt = engine.messages.indexOf(subscribes()[1]!);
    const between = engine.messages.slice(firstAt + 1, secondAt).map((m) => m.type);
    expect(between).toContain('unsubscribe');
  });
});
