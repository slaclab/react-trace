// The shared workbench helper for the tools' gesture specs: opening a tool
// page with its backend doubles, seeding and reading the sidebar arrangement,
// the sidebar's and the properties panel's locators (cards, plot-wide
// sections, More disclosures, the chart source) with the clicks that open
// them, and the pointer drags its dnd-kit gestures need. Holds no assertion
// of its own beyond the page being drawn and a part being open once opened.
//
// The arrangement lives in localStorage under `trace.workbench` (one key for
// all three tools): whether the sidebar is collapsed to its rail, and its
// width. A spec seeds it at most once
// per page: `seedArrangement` registers an init script that writes the key
// only on the page's first document and marks the tab in sessionStorage, so a
// reload keeps whatever the page itself wrote since. A spec that checks
// persistence seeds nothing beyond that and changes the arrangement only
// through a gesture.
//
// dnd-kit listens to pointer events and starts a drag only after the pointer
// moved 6 px, so a drag here is a real press, a few moves past that threshold,
// a stepped move onto the target and a release; HTML5 `dragTo` never starts it.

import { expect, type Locator, type Page } from '@playwright/test';

import { mockHare, mockMole, MOLE_PV } from './mocks';

/** The arrangement store's key on a page with no storage scope. */
export const ARRANGEMENT_KEY = 'trace.workbench';
/** The store's write debounce (arrangementStore.ts), with margin for a loaded host. */
export const WRITE_SETTLE_MS = 600;
/** The sidebar's default width in px. */
export const DEFAULT_WIDTH_PX = 300;

/** The stored arrangement (arrangementStore.ts). */
export interface Arrangement {
  v: 1;
  /** The sidebar is collapsed to its rail. */
  collapsed: boolean;
  widthPx: number;
}

export const DEFAULT_ARRANGEMENT: Arrangement = {
  v: 1,
  collapsed: false,
  widthPx: DEFAULT_WIDTH_PX,
};

/** The Trace page with one archived PV that the Mole double serves. */
export const TRACE_PAGE = `/?embedded=true&pv=${encodeURIComponent(MOLE_PV)}&range=-10m`;

/**
 * Seeds the arrangement on this page's first document only: a reload, which
 * finds the sessionStorage mark, keeps what the page wrote. Call before `goto`.
 */
export async function seedArrangement(page: Page, patch: Partial<Arrangement>): Promise<void> {
  const value = JSON.stringify({ ...DEFAULT_ARRANGEMENT, ...patch });
  await page.addInitScript(
    ([key, value]) => {
      const mark = `e2e-seeded:${key}`;
      if (sessionStorage.getItem(mark) !== null) return;
      sessionStorage.setItem(mark, '1');
      localStorage.setItem(key, value);
    },
    [ARRANGEMENT_KEY, value] as const
  );
}

/** The stored arrangement, or `null` when nothing has been written. */
export async function readArrangement(page: Page): Promise<Arrangement | null> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), ARRANGEMENT_KEY);
  return raw === null ? null : (JSON.parse(raw) as Arrangement);
}

/** Resolves once the stored arrangement satisfies `check` (a debounced write landed). */
export async function waitForStored(
  page: Page,
  check: (stored: Arrangement | null) => boolean,
  message = 'stored arrangement'
): Promise<Arrangement | null> {
  // A miss reports the value it last read, not just `false`.
  await expect
    .poll(
      async () => {
        const stored = await readArrangement(page);
        return check(stored) ? true : JSON.stringify(stored);
      },
      { message }
    )
    .toBe(true);
  return readArrangement(page);
}

/** Waits out the write debounce, so a write that was going to land has landed. */
export async function settleWrites(page: Page): Promise<void> {
  await page.waitForTimeout(WRITE_SETTLE_MS);
}

export interface OpenTraceOptions {
  /** The page path; defaults to `TRACE_PAGE`. */
  path?: string;
  viewport?: { width: number; height: number };
  /** Seed the arrangement once before the page loads. */
  arrangement?: Partial<Arrangement>;
}

/**
 * Installs the backend doubles (every unmocked backend path answers 503,
 * then Hare and Mole), seeds the arrangement when asked, opens the Trace page
 * and waits for its workbench: the actions bar and the sidebar.
 */
export async function openTrace(page: Page, options: OpenTraceOptions = {}): Promise<void> {
  if (options.viewport) await page.setViewportSize(options.viewport);
  await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
  await mockHare(page);
  await mockMole(page);
  if (options.arrangement) await seedArrangement(page, options.arrangement);
  await page.goto(options.path ?? TRACE_PAGE);
  await waitForWorkbench(page);
}

/** Waits until the workbench is drawn: its actions bar and its sidebar. */
export async function waitForWorkbench(page: Page): Promise<void> {
  await expect(page.locator('[data-testid=actions-bar]')).toBeVisible();
  await expect(page.locator('.wb-sidebar')).toBeVisible();
}

/** The sidebar's parts, by the hooks Sidebar.tsx renders: one pane, its rail when collapsed. */
export function sidebar(page: Page) {
  return {
    root: page.locator('.wb-sidebar'),
    /** The sidebar's resizable slot: its box is the sidebar's width. */
    slot: page.locator('[data-wb-slot=sidebar]'),
    /** The one pane: the plot's properties. */
    pane: page.locator('.wb-sidebar__pane[data-pane=properties]'),
    content: page.locator('.wb-sidebar__pane[data-pane=properties] .wb-sidebar__content'),
    /** The pane header's collapse button. */
    collapse: page.locator('.wb-sidebar__collapse'),
    rail: page.locator('.wb-sidebar__rail'),
    /** The rail's one target, which expands the pane again. */
    railTarget: page.locator('.wb-sidebar__rail-target[data-pane=properties]'),
    /** The sidebar/canvas separator. */
    edge: page.locator('.wb-split__edge'),
  };
}

// ── The properties panel (Outline.tsx, PlotSettings.tsx, FieldBlock.tsx) ───

/** The properties panel: the Outline's cards on top, the plot-wide sections below. */
export function panel(page: Page): Locator {
  return page.locator('.wb-sidebar__pane[data-pane=properties] .wb-panel');
}

/** An Outline section (a drop target for card drags) by its section id. */
export function outlineSection(page: Page, id: string): Locator {
  return panel(page).locator(`.wb-outline [data-section-id="${id}"]`);
}

/** The card of the Outline row `rowId`. */
export function card(page: Page, rowId: string): Locator {
  return panel(page).locator(`li[data-card-id="${rowId}"]`);
}

/** The cards whose head name matches `name`. */
export function cardNamed(page: Page, name: string | RegExp): Locator {
  return panel(page)
    .locator('li[data-card-id]')
    .filter({ has: page.locator('.wb-outline-row__name', { hasText: name }) });
}

/**
 * The cards of the drawings whose head name matches `name`. A `has` locator
 * is matched inside each card, so it is built from `page`, not the panel.
 */
export function drawingCard(page: Page, name: string | RegExp): Locator {
  return panel(page)
    .locator('li[data-card-id]')
    .filter({
      has: page.locator('.wb-card__head[data-section="annotations"]').filter({
        has: page.locator('.wb-outline-row__name', { hasText: name }),
      }),
    });
}

/**
 * The colour a colour field's swatch shows, as `#rrggbb`. A drawing in the
 * theme's ink stores `ink`, and its swatch resolves the ink through a theme
 * token, so the swatch, not the hidden native input, is what is drawn.
 */
export async function swatchHex(field: Locator): Promise<string> {
  return field
    .locator('.wb-swatch')
    .first()
    .evaluate((el) => {
      const rgb = getComputedStyle(el).backgroundColor.match(/\d+(\.\d+)?/g) ?? [];
      return `#${rgb
        .slice(0, 3)
        .map((v) => Math.round(Number(v)).toString(16).padStart(2, '0'))
        .join('')}`;
    });
}

/** Opens `target` (a card) in place by a click on its head's name, unless it is open already. */
export async function openCard(target: Locator): Promise<void> {
  const name = target.locator('.wb-card__head .wb-outline-row__name');
  if ((await name.getAttribute('aria-expanded')) !== 'true') await name.click();
  await expect(target).toHaveClass(/wb-card--open/);
}

/** A plot-wide section (acquisition, axes, display, statistics) by its id. */
export function plotSection(page: Page, id: string): Locator {
  return panel(page).locator(`.wb-plot-section[data-section="${id}"]`);
}

/** Opens the plot-wide section `id` by its head, unless it is open already; returns it. */
export async function openPlotSection(page: Page, id: string): Promise<Locator> {
  const section = plotSection(page, id);
  const head = section.locator('.wb-plot-section__head');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  return section;
}

/** Opens every closed "More" disclosure (the L3 fields) inside `scope`. */
export async function openMore(scope: Locator): Promise<void> {
  const closed = scope.locator('.wb-block__more-toggle[aria-expanded="false"]');
  while ((await closed.count()) > 0) await closed.first().click();
}

/** Opens the "Show chart source" link, unless it is open already; returns the source's body. */
export async function openChartSource(page: Page): Promise<Locator> {
  const link = panel(page).locator('.wb-plot__source-link');
  if ((await link.getAttribute('aria-expanded')) !== 'true') await link.click();
  await expect(link).toHaveAttribute('aria-expanded', 'true');
  return panel(page).locator('.wb-plot__source-body');
}

/** The sidebar's shown width in CSS px. */
export async function sidebarWidth(page: Page): Promise<number> {
  const box = await sidebar(page).slot.boundingBox();
  if (!box) throw new Error('the sidebar slot has no box');
  return box.width;
}

async function centre(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no box for ${locator}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A pointer drag from `source`'s centre to `target`'s centre (or to a point):
 * press, pass dnd-kit's 6 px activation distance, step to the target, release.
 */
export async function pointerDrag(
  page: Page,
  source: Locator,
  target: Locator | { x: number; y: number }
): Promise<void> {
  const from = await centre(source);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 4, from.y + 4, { steps: 2 });
  await page.mouse.move(from.x + 12, from.y + 12, { steps: 3 });
  const to = 'x' in target ? target : await centre(target);
  await page.mouse.move(to.x, to.y, { steps: 12 });
  // dnd-kit resolves the drop target on the last move; one more at the spot settles it.
  await page.mouse.move(to.x, to.y + 1, { steps: 1 });
  await page.mouse.up();
}

/** Drags the sidebar/canvas separator by `dx` px (a pointer-armed resize). */
export async function dragEdge(page: Page, dx: number): Promise<void> {
  const from = await centre(sidebar(page).edge);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y, { steps: 10 });
  await page.mouse.up();
}
