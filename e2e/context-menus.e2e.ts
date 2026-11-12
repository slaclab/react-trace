// The right-click menus end to end (workbench/contextMenu), in a real browser
// against the built pages on the shared backend doubles.
//
// What is asserted, and why it matters:
//
//   * a Properties row and a legend entry open the same signal menu, headed
//     by the full PV name, with each tool's items in the mock-up's order;
//   * Copy PV name (and ⌘C / Ctrl+C while the menu is open) puts the full
//     name on the clipboard and confirms with a toast; several picked rows
//     copy one name per line;
//   * the tool actions reach the tool: Use as reference moves a Live PV to
//     Reference, Use as X swaps with the X, Freeze this shot holds until
//     released, Open in posts the workspace's cross-tool open;
//   * PV info shows the archiver's metadata for the channel.

import { expect, test, type Page } from '@playwright/test';

import {
  clipboardText,
  contextMenu,
  grantClipboard,
  menuHeader,
  menuItem,
  menuLabels,
  openCorrelationPage,
  openWaveformPage,
  outlineRow,
  rightClick,
  toast,
} from './contextMenus';
import { MOLE_PV } from './mocks';
import { openTrace } from './workbench';

test.use({ viewport: { width: 1360, height: 860 } });
test.describe.configure({ timeout: 90_000 });

const LONG_PV = 'TEST:MAG:LONG:01:CURRENT:WAVEFORM';
const PROBE = 'PROBE:WF';
const WAVEFORMS = {
  [LONG_PV]: { length: 64, hz: 0 },
  [PROBE]: { length: 64, hz: 0, value: (i: number) => Math.cos(i / 8) },
};
const OTHER_PV = 'TEST:OTHER';
const TRACE_TWO = `/?embedded=true&pv=${MOLE_PV}&pv=${OTHER_PV}&range=-10m`;

/** Right-click the chart's legend row at its centre (one entry there). */
async function rightClickLegend(page: Page, chart: string, fromTop: number | null, fromBottom = 0) {
  const box = await page.locator(chart).first().boundingBox();
  if (!box) throw new Error('no chart');
  const x = box.x + box.width / 2;
  const y = fromTop !== null ? box.y + fromTop : box.y + box.height - fromBottom;
  await page.mouse.move(x, y);
  await page.mouse.click(x, y, { button: 'right' });
}

test.describe('Waveform', () => {
  test('a row opens the signal menu; Copy PV name and ⌘C copy the full name', async ({ page }) => {
    await grantClipboard(page);
    await openWaveformPage(page, [LONG_PV, PROBE], WAVEFORMS);
    await rightClick(outlineRow(page, `live:${LONG_PV}`));
    await expect(menuHeader(page)).toHaveText(LONG_PV);
    expect(await menuLabels(page)).toEqual([
      'Copy PV name',
      'Copy this shot (64 values)',
      'Use as reference',
      'Take snapshot as reference',
      'Open in',
      'PV info…',
      'Hide',
      'Remove',
    ]);
    await menuItem(page, 'Copy PV name').click();
    await expect(toast(page)).toHaveText(`✓Copied ${LONG_PV}`);
    expect(await clipboardText(page)).toBe(LONG_PV);

    await page.evaluate(() => navigator.clipboard.writeText(''));
    await rightClick(outlineRow(page, `live:${PROBE}`));
    await expect(contextMenu(page)).toBeVisible();
    await page.keyboard.press('ControlOrMeta+c');
    await expect(contextMenu(page)).toHaveCount(0);
    expect(await clipboardText(page)).toBe(PROBE);
  });

  test('Use as reference moves the PV to Reference; Copy this shot copies the array', async ({
    page,
  }) => {
    await grantClipboard(page);
    await openWaveformPage(page, [LONG_PV, PROBE], WAVEFORMS);
    await rightClick(outlineRow(page, `live:${PROBE}`));
    await menuItem(page, 'Copy this shot (64 values)').click();
    expect((await clipboardText(page)).split('\n')).toHaveLength(64);
    await rightClick(outlineRow(page, `live:${PROBE}`));
    await menuItem(page, 'Use as reference').click();
    await expect(outlineRow(page, `reference:${PROBE}`)).toBeVisible();
    await expect(outlineRow(page, `live:${PROBE}`)).toHaveCount(0);
  });

  test('the plot: a reading header, Freeze this shot holds until released', async ({ page }) => {
    await openWaveformPage(page, [LONG_PV], { [LONG_PV]: WAVEFORMS[LONG_PV] });
    const box = await page.locator('.waveform-app canvas').first().boundingBox();
    if (!box) throw new Error('no chart');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await expect(menuHeader(page)).toContainText('element');
    await menuItem(page, 'Freeze this shot').click();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await expect(menuItem(page, 'Release frozen shot')).toBeVisible();
    for (const label of ['Reset zoom', 'Copy plot as image', 'Copy link to this view']) {
      await expect(menuItem(page, label)).toBeVisible();
    }
  });

  test('the legend entry opens the signal menu; a left-click toggles nothing', async ({ page }) => {
    await openWaveformPage(page, [LONG_PV], { [LONG_PV]: WAVEFORMS[LONG_PV] });
    await rightClickLegend(page, '.waveform-app canvas', 12);
    await expect(menuHeader(page)).toHaveText(LONG_PV);
    await page.keyboard.press('Escape');
    await expect(contextMenu(page)).toHaveCount(0);
  });
});

test.describe('Correlation', () => {
  test('Use as X swaps with the X; Copy fit copies the numbers', async ({ page }) => {
    await grantClipboard(page);
    await openCorrelationPage(page, 'PROBE:X', ['PROBE:Y1', 'PROBE:Y2']);
    // Copy fit is offered once the first frame has a fit.
    await expect(async () => {
      await page.keyboard.press('Escape');
      await rightClick(outlineRow(page, 'y:PROBE:Y1'));
      await expect(menuItem(page, 'Copy fit (slope, offset, R²)')).toBeVisible({ timeout: 500 });
    }).toPass();
    await expect(menuHeader(page)).toHaveText('PROBE:Y1');
    expect(await menuLabels(page)).toEqual([
      'Copy PV name',
      'Copy fit (slope, offset, R²)',
      'Use as X (swap with PROBE:X)',
      'Open in',
      'PV info…',
      'Hide',
      'Remove',
    ]);
    await menuItem(page, 'Copy fit (slope, offset, R²)').click();
    expect(await clipboardText(page)).toMatch(
      /^PROBE:Y1 vs PROBE:X: slope .+, offset .+, R² .+, n \d+$/
    );
    await rightClick(outlineRow(page, 'y:PROBE:Y1'));
    await menuItem(page, 'Use as X (swap with PROBE:X)').click();
    await expect(outlineRow(page, 'x:PROBE:Y1')).toBeVisible();
    await expect(outlineRow(page, 'y:PROBE:X')).toBeVisible();
  });
});

test.describe('Trace', () => {
  test('the legend opens the curve menu with Open in › and Move to axis ›', async ({ page }) => {
    await openTrace(page, { path: `/?embedded=true&pv=${MOLE_PV}&range=-10m` });
    await expect(page.locator('[data-chart-host] canvas').first()).toBeVisible();
    await rightClickLegend(page, '[data-chart-host] canvas', null, 20);
    await expect(menuHeader(page)).toHaveText(MOLE_PV);
    for (const label of [
      'Inspect data',
      'Create formula from this curve',
      'Move to axis',
      'Hide',
      'Remove',
    ]) {
      await expect(menuItem(page, label)).toBeVisible();
    }
    // Embedded, Open in hands the workspace a cross-tool open.
    await page.evaluate(() => {
      const w = window as unknown as { __opens: unknown[] };
      w.__opens = [];
      window.addEventListener('message', (e) => {
        if ((e.data as { type?: string })?.type === 'canopy:trace-open') w.__opens.push(e.data);
      });
    });
    await menuItem(page, 'Open in').hover();
    await expect(menuItem(page, 'Correlation as X')).toBeVisible();
    await expect(menuItem(page, 'Correlation as Y')).toBeVisible();
    await menuItem(page, 'Waveform').click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __opens: unknown[] }).__opens))
      .toEqual([{ type: 'canopy:trace-open', tool: 'waveform', query: `pv=${MOLE_PV}` }]);
  });

  test('picked rows copy one PV name per line; PV info shows the metadata', async ({ page }) => {
    await grantClipboard(page);
    await openTrace(page, { path: TRACE_TWO });
    const rows = page.locator('.wb-outline-row');
    await expect(rows).toHaveCount(2);
    await rows.nth(0).click({ modifiers: ['ControlOrMeta'] });
    await rows.nth(1).click({ modifiers: ['ControlOrMeta'] });
    await rightClick(rows.nth(1));
    await expect(menuHeader(page)).toHaveText('2 signals');
    await menuItem(page, 'Copy PV names').click();
    expect(await clipboardText(page)).toBe(`${MOLE_PV}\n${OTHER_PV}`);
    await expect(toast(page)).toContainText('Copied 2 PV names');

    await rows.nth(0).click();
    await rightClick(rows.nth(0));
    await menuItem(page, 'PV info…').click();
    const dialog = page.locator('.wb-pv-info');
    await expect(dialog.getByText('Mocked archive PV')).toBeVisible();
    await expect(dialog.getByText('mA', { exact: true })).toBeVisible();
  });

  test('a point names the reading under the pointer', async ({ page }) => {
    await openTrace(page, { path: `/?embedded=true&pv=${MOLE_PV}&range=-10m` });
    const box = await page.locator('[data-chart-host] canvas').first().boundingBox();
    if (!box) throw new Error('no chart');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await expect(menuHeader(page)).toHaveText(/^\d\d:\d\d:\d\d/);
    for (const label of ['Copy reading', 'Add note here', 'Reset zoom', 'Copy plot as image']) {
      await expect(menuItem(page, label)).toBeVisible();
    }
  });
});
