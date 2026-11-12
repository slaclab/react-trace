// The smoke gate of Trace's host-stylesheet specs: every trace, correlation and
// waveform row of the shell's probe table (hostProbes.json) still finds its element.
// Each row opens its page with the shared backend doubles (Hare holding
// `HOLD_PV`, Mole, the Formula Engine) and the synthetic host fixture installed after them,
// runs its setups through the shell's setups.mjs in order, and asserts only
// that its selector resolves to at least one element; a `pseudo` row asserts a
// painted pseudo-element. A row whose setup has a postcondition re-checks it
// last. The styling spec assumes this passed, so a renamed class fails here,
// by name, and not as a colour mismatch there.
//
// All three apps draw the workbench (actions bar and sidebar) that the Outline and
// Properties setups open, so every row waits for it first. The correlation
// page draws its plot only once the Formula Engine has answered its table subscription, and
// an embedded page subscribes only after its host has shown it. So a
// correlation row then posts the host's `canopy:trace-visibility` message (a
// top-level page is its own parent) and answers the subscription with one
// small table frame before its setups run. The waveform page reads only Hare
// (no Formula Engine): Hare serves its PV as a waveform, so a waveform row posts the same
// visibility message and waits until the chart has drawn that first frame.
//
// Resolution does not depend on the theme, so one synthetic theme is enough.

import { expect, test } from '@playwright/test';

import { installHost } from './hostFixture';
import {
  hostFixture,
  hostProbes,
  loadRunner,
  loadSetups,
  runSetups,
  traceRows,
} from './hostProbes';
import {
  mockFormulaEngine,
  mockHare,
  mockMole,
  type FormulaEngineSubscription,
  type HareWaveform,
} from './mocks';

const THEME = Object.keys(hostFixture.themes)[0]!;
/** The tool's workbench is drawn: its actions bar and its sidebar (Trace, Correlation and Waveform alike). */
const WB_ACTIONS = '[data-testid=actions-bar]';
const WB_SIDEBAR = '.wb-sidebar';

/** The waveform page's PV (`defaults.page.waveform`): Hare serves it as a waveform, initial frame only. */
const PROBE_WAVEFORMS: Record<string, HareWaveform> = { 'PROBE:WF': { length: 64, hz: 0 } };

/** PV metadata (<= 3 s), spec debounce (300 ms) and socket open, with margin. */
const SUBSCRIBE_TIMEOUT_MS = 20_000;
const ROWS = 16;

/** One small table frame answering the subscription. */
function tableFrame(sub: FormulaEngineSubscription): string {
  const t0 = Date.now() * 1_000_000 - ROWS * 1_000_000_000;
  const tsNs = Array.from({ length: ROWS }, (_, i) => t0 + i * 1_000_000_000);
  const columns: Record<string, number[]> = {};
  sub.columns.forEach((name, c) => {
    columns[name] = tsNs.map((_, i) => (name === 'x' ? i : i * (c + 1)));
  });
  const inputs: Record<string, unknown> = {};
  for (const binding of sub.bindings) {
    inputs[binding] = { history: 'seeded', status: 'ok', lateAfterFinal: false };
  }
  return JSON.stringify({
    type: 'result',
    id: sub.serverId,
    data: { kind: 'table', table: { tsNs, columns, inputs, totalRows: ROWS } },
  });
}

for (const [i, row] of traceRows.entries()) {
  const setup = row.setup.length > 0 ? ` [${row.setup.join(', ')}]` : '';
  test(`${row.app} row ${i}: ${row.selector}${row.pseudo ?? ''}${setup}`, async ({ page }) => {
    const { pageFor } = await loadRunner();
    const { HOLD_PV, postconditions } = await loadSetups();

    if (row.viewport) await page.setViewportSize(row.viewport);
    await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
    await mockHare(page, { hold: new Set([HOLD_PV]), waveforms: PROBE_WAVEFORMS });
    await mockMole(page);
    const engine = await mockFormulaEngine(page);
    await installHost(page);

    await page.goto(pageFor(hostProbes, row, THEME));
    await expect(page.locator(WB_ACTIONS)).toBeVisible();
    await expect(page.locator(WB_SIDEBAR)).toBeVisible();
    if (row.app === 'correlation') {
      await page.evaluate(() =>
        window.postMessage({ type: 'canopy:trace-visibility', visible: true }, location.origin)
      );
      const sub = await Promise.race([
        engine.subscribed,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(`no Formula Engine table subscribe within ${SUBSCRIBE_TIMEOUT_MS} ms`)
              ),
            SUBSCRIBE_TIMEOUT_MS
          )
        ),
      ]);
      sub.ws.send(tableFrame(sub));
      await expect(page.locator('.correlation-plot__chart')).toBeVisible();
    }
    if (row.app === 'waveform') {
      await page.evaluate(() =>
        window.postMessage({ type: 'canopy:trace-visibility', visible: true }, location.origin)
      );
      await expect(page.locator('[data-testid=waveform-chart] canvas').first()).toBeVisible();
      await expect(page.locator('[data-testid=waveform-canvas-message]')).toHaveCount(0);
    }
    await runSetups(page, row, { theme: THEME });

    const target = page.locator(row.selector);
    await expect(target.first()).toBeAttached();
    expect(await target.count()).toBeGreaterThanOrEqual(1);

    if (row.pseudo) {
      const painted = await target.first().evaluate((el, pseudo) => {
        const style = getComputedStyle(el, pseudo);
        const content = style.content !== 'none' && style.content !== 'normal';
        return content || style.backgroundColor !== 'rgba(0, 0, 0, 0)';
      }, row.pseudo);
      expect(painted, `${row.selector}${row.pseudo} is painted`).toBe(true);
    }

    const checks = postconditions as Record<string, (p: typeof page) => Promise<void>>;
    for (const name of row.setup) await checks[name]?.(page);
  });
}
