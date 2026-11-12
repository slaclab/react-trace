// An Outline card head in the narrowest sidebar keeps its PV name readable.
//
// The head (the row) is a flex line: status dot, colour swatch, name, and the
// show/hide and remove controls that hover reveals. The name is the only part
// that gives way, so a long PV must not be squeezed down to a single glyph, nor
// push the status dot or a control out of the row. This spec opens the page
// with the sidebar at its 220 px minimum (seeded once) and a 30-character PV
// whose archive request fails, and checks, at rest and while the row is
// hovered, that
//   - the name keeps at least six characters' width and is the part that
//     ellipsizes,
//   - the status dot is still rendered and visible and names the failure, and
//   - nothing overflows the row.
//
// Hare and Mole are the shared doubles; the archive failure for this PV is a
// route of this spec, registered after them so that it wins.

import { expect, test, type Locator } from '@playwright/test';

import { mockHare, mockMole } from './mocks';
import { panel, seedArrangement, sidebarWidth, waitForWorkbench } from './workbench';

const VIEWPORT = { width: 1000, height: 600 };
/** The sidebar's minimum width (arrangementStore.ts MIN_WIDTH_PX). */
const SIDEBAR_WIDTH_PX = 220;
const WIDTH_TOLERANCE_PX = 2;
const MIN_NAME_CH = 6;

const LONG_PV = 'SIM:LONG:PV:NAME:FOR:LAYER:ROW';
const ARCHIVE_ERROR = 'archiver_unavailable';

test.use({ viewport: VIEWPORT });

/** The row's name, status dot and overflow, measured in the page. */
async function measure(row: Locator) {
  const name = row.locator('.wb-outline-row__name');
  const nameSize = await name.evaluate((el) => {
    const probe = document.createElement('span');
    probe.textContent = '0';
    el.appendChild(probe);
    const chPx = probe.getBoundingClientRect().width;
    probe.remove();
    return {
      chPx,
      width: el.getBoundingClientRect().width,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      textOverflow: getComputedStyle(el).textOverflow,
    };
  });
  const rowSize = await row.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const children = Array.from(el.children).map((child) => child.getBoundingClientRect());
    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      right: box.right,
      maxChildRight: Math.max(...children.map((c) => (c.width > 0 ? c.right : -Infinity))),
    };
  });
  return { nameSize, rowSize };
}

async function expectReadable(row: Locator): Promise<void> {
  const { nameSize, rowSize } = await measure(row);
  expect(nameSize.chPx).toBeGreaterThan(0);
  expect(nameSize.width).toBeGreaterThanOrEqual(MIN_NAME_CH * nameSize.chPx);
  // The name is what gives way: it is clipped, with an ellipsis.
  expect(nameSize.scrollWidth).toBeGreaterThan(nameSize.clientWidth);
  expect(nameSize.textOverflow).toBe('ellipsis');
  // Nothing overflows the row, and no part is pushed past its edge.
  expect(rowSize.scrollWidth).toBeLessThanOrEqual(rowSize.clientWidth);
  expect(rowSize.maxChildRight).toBeLessThanOrEqual(rowSize.right + 0.5);
}

test('a narrow Outline row shows the PV name beside its failed status dot', async ({ page }) => {
  expect(LONG_PV).toHaveLength(30);

  await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
  await mockHare(page);
  await mockMole(page);
  await page.route(
    (url) => url.pathname.endsWith(`/mole/v1/data/${encodeURIComponent(LONG_PV)}`),
    (route) =>
      route.fulfill({
        status: 503,
        json: { code: ARCHIVE_ERROR, detail: 'The mocked archiver is down.' },
      })
  );
  await seedArrangement(page, { widthPx: SIDEBAR_WIDTH_PX });

  await page.goto(`/?embedded=true&pv=${encodeURIComponent(LONG_PV)}&range=-10m`);
  await waitForWorkbench(page);
  expect(Math.abs((await sidebarWidth(page)) - SIDEBAR_WIDTH_PX)).toBeLessThanOrEqual(
    WIDTH_TOLERANCE_PX
  );

  const row = panel(page).locator('.wb-card__head.wb-outline-row');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.wb-outline-row__name')).toHaveText(LONG_PV);

  // The dot reads pending until the archive request fails; measure after.
  const status = row.locator('.wb-outline-row__status');
  await expect(status).toHaveClass(/wb-outline-row__status--error/);
  await expect(status).toHaveAttribute('aria-label', new RegExp(`Archive: ${ARCHIVE_ERROR}`));
  await expect(status).toBeVisible();
  const statusBox = await status.boundingBox();
  expect(statusBox!.width).toBeGreaterThan(0);

  await page.mouse.move(0, 0);
  await expectReadable(row);

  // Hover reveals show/hide and remove; the name still holds its width.
  await row.hover();
  await expect(row.locator('.wb-outline-row__remove')).toBeVisible();
  await expectReadable(row);
  await expect(status).toBeVisible();
});
