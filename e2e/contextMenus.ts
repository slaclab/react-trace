// The right-click menus' page openers and locators, shared by the menus spec:
// each tool on its backend doubles, the open menu, its header and items, the
// toast, and the clipboard.

import { expect, type Locator, type Page, type WebSocketRoute } from '@playwright/test';

import {
  FORMULA_ENGINE_PATH,
  mockHare,
  mockMole,
  pathEndsWith,
  type HareMock,
  type HareWaveform,
} from './mocks';
import { waitForWorkbench } from './workbench';

/** Rows in the Correlation table double. */
const ROWS = 30;

/** Grants the clipboard, so a spec can read what was copied. */
export async function grantClipboard(page: Page): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
}

/** What is on the clipboard. */
export async function clipboardText(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** The Waveform page on its Hare double. */
export async function openWaveformPage(
  page: Page,
  pvs: readonly string[],
  waveforms: Record<string, HareWaveform>,
  extra = ''
): Promise<HareMock> {
  await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
  const hare = await mockHare(page, { waveforms, units: () => 'mm' });
  await mockMole(page);
  const q = pvs.map((pv) => `pv=${encodeURIComponent(pv)}`).join('&');
  await page.goto(`/waveform.html?${q}${extra}`);
  await waitForWorkbench(page);
  await expect(page.getByTestId('waveform-app')).toBeVisible();
  return hare;
}

function tableFrame(serverId: string, columns: string[], bindings: string[]): string {
  const t0 = Date.now() * 1_000_000 - ROWS * 1_000_000_000;
  const tsNs = Array.from({ length: ROWS }, (_, i) => t0 + i * 1_000_000_000);
  const data: Record<string, number[]> = {};
  columns.forEach((name, c) => {
    data[name] = tsNs.map((_, i) => (name === 'x' ? i : i * (c + 1) + Math.sin(i)));
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

/** The Correlation page on Hare, Mole and a Formula Engine double that answers every table subscribe. */
export async function openCorrelationPage(
  page: Page,
  x: string,
  ys: readonly string[]
): Promise<void> {
  await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
  await mockHare(page);
  await mockMole(page);
  let counter = 0;
  await page.routeWebSocket(pathEndsWith(FORMULA_ENGINE_PATH), (ws: WebSocketRoute) => {
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as {
        type?: string;
        spec?: {
          kind?: string;
          columns?: Record<string, unknown>;
          bindings?: Record<string, unknown>;
        };
      };
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
  const q = new URLSearchParams();
  q.set('x', x);
  for (const y of ys) q.append('y', y);
  q.set('dt', '1');
  q.set('lookback', '1h');
  await page.goto(`/correlation.html?${q.toString()}`);
  await waitForWorkbench(page);
  await expect(page.locator('.correlation-plot__chart')).toBeVisible();
}

/** The open right-click menu. */
export function contextMenu(page: Page): Locator {
  return page.locator('[data-plot-menu="context"]');
}

/** The open menu's header line. */
export function menuHeader(page: Page): Locator {
  return contextMenu(page).locator('.wb-context-menu__header');
}

/** An item of the open menu (or of an open submenu), by its label (a shortcut hint may follow it). */
export function menuItem(page: Page, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.getByRole('menuitem', { name: new RegExp(`^${escaped}( (⌘C|Ctrl\\+C))?$`) });
}

/** The labels of the open menu's top-level items, in order. */
export async function menuLabels(page: Page): Promise<string[]> {
  return contextMenu(page)
    .locator(
      ':scope > li[role="menuitem"], :scope > li > [role="menuitem"], :scope > [role="menuitem"]'
    )
    .evaluateAll((els) =>
      els.map((el) => (el.querySelector('.cds--menu-item__label')?.textContent ?? '').trim())
    );
}

/** The toast. */
export function toast(page: Page): Locator {
  return page.locator('.wb-context-toast');
}

/** An Outline row head by its item id. */
export function outlineRow(page: Page, rowId: string): Locator {
  return page.locator(`.wb-outline-row[data-row-id="${rowId}"]`);
}

/** Right-click `target` at its centre (or at fractions of its box). */
export async function rightClick(target: Locator, fx = 0.5, fy = 0.5): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error(`no box for ${target}`);
  await target
    .page()
    .mouse.click(box.x + box.width * fx, box.y + box.height * fy, { button: 'right' });
}

/** Closes the open menu with Escape and waits until it is gone. */
export async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(contextMenu(page)).toHaveCount(0);
}
