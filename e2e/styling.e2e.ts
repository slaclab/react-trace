// Trace's host-stylesheet styling spec, against the shell's synthetic
// host sheet (host.css: three fake themes, probe-a-dark, probe-b-dark and
// probe-light, plus the stand-in color-scheme rules) installed by hostFixture.ts.
//
// What is asserted, and why it matters:
//
//   * every marked host sheet had rules before the first module ran (the
//     fixture's module marker, I-19), on the Trace page and the correlation
//     page, so the first paint already has host colours: no Carbon flash;
//   * exactly 0 / 1 / 1 / 1 `canopy:` warnings for standalone / a 404 sheet /
//     an empty sheet / a sheet declaring contract 2, the document marker
//     dropped in the two dead-sheet cases;
//   * under a light id the body is not painted with the g100 Carbon default
//     (`rgb(22, 22, 22)`), so a light host never shows a dark document;
//   * hosted (probe-a-dark) every trace, correlation and waveform probe row takes the
//     host values; standalone (nothing installed, ?theme=light) every row
//     holds its standalone branch. The rows, their setups and every assertion
//     live in the shell's fixtures; this spec only opens pages and runs them.
//
// Every page opens with the shared backend doubles (Hare with `pong` and the
// held `HOLD_PV`, Mole, the Formula Engine), the host fixture installed after them. The
// correlation page draws its plot only once the Formula Engine has answered its table
// subscription, and an embedded page subscribes only after its host has shown
// it, so a correlation row posts the host's `canopy:trace-visibility` message
// and answers the subscription with one small table frame first. The waveform
// page reads only Hare, which serves its PV as a waveform (no Formula Engine): a waveform
// row posts the same visibility message and waits until the chart has drawn
// that first frame. All three apps draw the workbench (actions bar and sidebar), which every Outline and
// Properties setup needs, so every page waits for it.

import { expect, test, type Page } from '@playwright/test';

import { installHost, type HostScenario } from './hostFixture';
import {
  checkRow,
  hostFixture,
  hostProbes,
  loadRunner,
  loadSetups,
  runSetups,
  traceRows,
  type ProbeApp,
} from './hostProbes';
import {
  mockFormulaEngine,
  mockHare,
  mockMole,
  type FormulaEngineMock,
  type FormulaEngineSubscription,
  type HareWaveform,
} from './mocks';

const DARK = 'probe-a-dark';
const LIGHT = 'probe-light';
/** The id a standalone page is opened with: no host sheet answers it. */
const STANDALONE = 'light';
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

/** Collects every `canopy:` console warning, from before the page loads. */
function canopyWarnings(page: Page): string[] {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' && m.text().startsWith('canopy:')) warnings.push(m.text());
  });
  return warnings;
}

interface OpenOptions {
  /** Install the synthetic host (optionally broken); `false` opens the page standalone. */
  host: false | { scenario?: HostScenario };
  viewport?: { width: number; height: number };
}

/** Installs the backend doubles and, after them, the host fixture. */
async function prepare(page: Page, options: OpenOptions): Promise<FormulaEngineMock> {
  const { HOLD_PV } = await loadSetups();
  if (options.viewport) await page.setViewportSize(options.viewport);
  await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
  await mockHare(page, { hold: new Set([HOLD_PV]), waveforms: PROBE_WAVEFORMS });
  await mockMole(page);
  const engine = await mockFormulaEngine(page);
  if (options.host) await installHost(page, options.host);
  return engine;
}

/** Opens an app's page for a theme and waits until it has drawn what its rows probe. */
async function openApp(
  page: Page,
  app: ProbeApp,
  theme: string,
  options: OpenOptions,
  path?: string
): Promise<void> {
  const { pageFor } = await loadRunner();
  const engine = await prepare(page, options);
  await page.goto(path ?? pageFor(hostProbes, { app }, theme));
  await expect(page.locator(WB_ACTIONS)).toBeVisible();
  await expect(page.locator(WB_SIDEBAR)).toBeVisible();
  if (app === 'waveform') {
    await page.evaluate(() =>
      window.postMessage({ type: 'canopy:trace-visibility', visible: true }, location.origin)
    );
    await expect(page.locator('[data-testid=waveform-chart] canvas').first()).toBeVisible();
    await expect(page.locator('[data-testid=waveform-canvas-message]')).toHaveCount(0);
    return;
  }
  if (app !== 'correlation') return;
  await page.evaluate(() =>
    window.postMessage({ type: 'canopy:trace-visibility', visible: true }, location.origin)
  );
  const sub = await Promise.race([
    engine.subscribed,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(new Error(`no Formula Engine table subscribe within ${SUBSCRIBE_TIMEOUT_MS} ms`)),
        SUBSCRIBE_TIMEOUT_MS
      )
    ),
  ]);
  sub.ws.send(tableFrame(sub));
  await expect(page.locator('.correlation-plot__chart')).toBeVisible();
}

/** Resolves once every running animation and transition (Carbon's hover fades) has ended. */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)))
  );

const htmlAttr = (page: Page, name: string) =>
  page.evaluate((name) => document.documentElement.getAttribute(name), name);

test.describe('host stylesheet mechanics', () => {
  test.describe.configure({ timeout: 60_000 });

  for (const app of ['trace', 'correlation'] as const) {
    test(`${app}: every host sheet is usable before the first module runs (I-19)`, async ({
      page,
    }) => {
      await openApp(page, app, DARK, { host: {} });

      expect(await htmlAttr(page, 'data-canopy-host')).toBe('');
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { __hostSheetLoadedAtModule?: unknown }).__hostSheetLoadedAtModule
        )
      ).toBe(true);
      expect(
        await page.evaluate(() => document.querySelectorAll('link[data-canopy-host-sheet]').length)
      ).toBe(3);
    });
  }

  test('standalone logs no canopy warning', async ({ page }) => {
    const warnings = canopyWarnings(page);
    await openApp(page, 'trace', STANDALONE, { host: false });
    await page.waitForTimeout(250);
    expect(await htmlAttr(page, 'data-canopy-host')).toBeNull();
    expect(warnings).toEqual([]);
  });

  const scenarios: { scenario: HostScenario; cleared: boolean; text: RegExp }[] = [
    { scenario: '404', cleared: true, text: /^canopy: host stylesheet did not load/ },
    { scenario: 'empty-200', cleared: true, text: /^canopy: host stylesheet did not load/ },
    { scenario: 'wrong-major', cleared: false, text: /contract version 2; expected 1\.x/ },
  ];
  for (const { scenario, cleared, text } of scenarios) {
    test(`a ${scenario} host sheet logs exactly one canopy warning`, async ({ page }) => {
      const warnings = canopyWarnings(page);
      await openApp(page, 'trace', DARK, { host: { scenario } });
      await page.waitForTimeout(250);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(text);
      expect(await htmlAttr(page, 'data-canopy-host')).toBe(cleared ? null : '');
    });
  }

  test(`the body is not painted the g100 default under ${LIGHT}`, async ({ page }) => {
    await openApp(page, 'trace', LIGHT, { host: {} });
    expect(await htmlAttr(page, 'data-canopy-host')).toBe('');
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).not.toBe('rgb(22, 22, 22)');
  });
});

for (const hosted of [true, false]) {
  const theme = hosted ? DARK : STANDALONE;
  const title = hosted
    ? `hosted (${DARK}): every trace, correlation and waveform row takes the host values`
    : 'standalone: every trace, correlation and waveform row holds its standalone branch';

  test.describe(title, () => {
    test.describe.configure({ timeout: 60_000 });

    for (const [i, row] of traceRows.entries()) {
      const setup = row.setup.length > 0 ? ` [${row.setup.join(', ')}]` : '';
      const size = row.viewport ? ` @${row.viewport.width}px` : '';
      test(`${row.app} row ${i}: ${row.selector}${row.pseudo ?? ''}${setup}${size}`, async ({
        page,
      }) => {
        const { pageFor } = await loadRunner();
        await openApp(
          page,
          row.app,
          theme,
          { host: hosted ? {} : false, viewport: row.viewport },
          pageFor(hostProbes, row, theme)
        );
        await runSetups(page, row, { theme });
        await expect(page.locator(row.selector).first()).toBeAttached();
        // A clicking setup leaves the pointer on its target, which then paints
        // its hover state; only a hover row reads that.
        if (!row.setup.some((s) => s.startsWith('hover'))) await page.mouse.move(0, 0);
        await settled(page);

        const result = await checkRow(
          page,
          row,
          hosted
            ? { hosted: true, hostValues: hostFixture.themes[DARK]!.values }
            : { hosted: false }
        );
        expect(result.gated).toBe(hosted);
      });
    }
  });
}
