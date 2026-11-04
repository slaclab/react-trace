// The three tools under the host bar (`embedded=true&hostbar=1`) in a real
// browser, framed by a same-origin stand-in for a host that draws the tool's
// tile bar (e2e/hostBar.ts). The stand-in records what the tool posts and
// posts back what a host would.
//
// What is asserted, and why it matters:
//
//   * under the host bar no tool renders its actions bar: the host's tile bar
//     carries those verbs instead;
//   * each tool reports its actions as `canopy:tool-actions` from its real
//     spec table: bar entries in display order, then menu entries, with their
//     labels (Import…, Export trace file), kinds, shortcuts, placements and
//     icon names, plus the state and the Docs / Report a bug links. The
//     production build reports real Carbon icon names (minified builds lose
//     component names, so the names are declared). Post to E-Log is absent:
//     embedded there is no logbook;
//   * Trace's plot row draws only the time window and Add plot;
//   * a `canopy:tool-invoke` for `export-csv` downloads the CSV, one for
//     `import` opens the file chooser even though it arrives in a message
//     handler with no user gesture in the frame, one for a bar verb runs it,
//     and one for an id the report does not list does nothing;
//   * ⌘S inside each of the three frames posts `canopy:save-view` and
//     downloads nothing; ⌘P, ⌘O, ⌘I and Alt+D still act with the bar absent;
//   * Correlation's and Waveform's Pause, invoked by the host, flips the
//     reported state, and Waveform's Snapshot adds a reference curve;
//   * the same pages with `embedded=true` alone keep the actions bar and the
//     standalone plot row, and post no report.

import { expect, test, type Page } from '@playwright/test';

import {
  installHost,
  invokeTool,
  messagesOfType,
  openInHost,
  primaryKey,
  printCount,
  SAVE_VIEW,
  TOOL_ACTIONS,
  waitForToolActions,
  type HostedTool,
  type ToolActionEntry,
} from './hostBar';
import { mockFormulaEngine, mockHare, mockMole, MOLE_PV } from './mocks';

test.use({ viewport: { width: 1280, height: 800 } });
test.describe.configure({ timeout: 60_000 });

const WAVEFORM_PV = 'TEST:WF';
// The app's links, as src/tools/standardActionsOptions.ts defines them.
const DOCS_URL = 'https://fuzzy-adventure-4qvly8m.pages.github.io/';
const BUG_URL = 'https://forms.office.com/r/qV7BmK2xi9';
/** How long a spec watches for something that must not happen. */
const QUIET_MS = 1_000;

/** The icon names a host tile bar draws. */
const ICON_ALLOWLIST = new Set([
  'Renew',
  'DataTable',
  'SendAlt',
  'Download',
  'Image',
  'Grid',
  'ColumnDependency',
  'Pause',
  'Erase',
  'Camera',
  'Save',
  'Printer',
  'Upload',
]);

type ToolName = 'trace' | 'correlation' | 'waveform';

/** The report fields the spec tables fix (`disabled` follows the data and is checked apart). */
type Reported = Pick<
  ToolActionEntry,
  'id' | 'label' | 'kind' | 'shortcut' | 'pressed' | 'placement'
>;

interface ToolCase {
  name: ToolName;
  /** The page with `embedded=true` (and its own query); `hostbar=1` is added for the host bar. */
  path: string;
  /** Shown once the tool's canvas is up. */
  ready: string;
  /** Inside the frame, a click target that changes nothing (it gives the frame focus). */
  focus: string;
  actions: Reported[];
  state: RegExp;
}

const TOOLS: readonly ToolCase[] = [
  {
    name: 'trace',
    path: `/?embedded=true&pv=${encodeURIComponent(MOLE_PV)}&range=-10m`,
    ready: '.plot-tab-bar',
    focus: '.plot-tab--active > span',
    actions: [
      { id: 'refresh-archive', label: 'Refresh archive data', kind: 'button', placement: 'bar' },
      {
        id: 'data-insight',
        label: 'Data Insight',
        kind: 'button',
        shortcut: 'alt+D',
        placement: 'bar',
      },
      { id: 'export-csv', label: 'Export CSV', kind: 'button', placement: 'bar' },
      {
        id: 'export-png',
        label: 'Export PNG',
        kind: 'button',
        shortcut: 'primary+I',
        placement: 'bar',
      },
      { id: 'view-mode', label: 'Plots as grid', kind: 'toggle', pressed: false, placement: 'bar' },
      { id: 'import', label: 'Import…', kind: 'button', shortcut: 'primary+O', placement: 'menu' },
      { id: 'save', label: 'Export trace file', kind: 'button', placement: 'menu' },
      { id: 'print', label: 'Print', kind: 'button', shortcut: 'primary+P', placement: 'menu' },
    ],
    state: /^1 curve · (live|paused)$/,
  },
  {
    name: 'correlation',
    path: '/correlation.html?embedded=true&x=TEST%3AX&y=TEST%3AY1&dt=1&lookback=1h',
    ready: '.correlation-health',
    focus: '.correlation-health p',
    actions: [
      { id: 'pause', label: 'Pause', kind: 'toggle', pressed: false, placement: 'bar' },
      { id: 'clear', label: 'Clear', kind: 'button', placement: 'bar' },
      { id: 'export-csv', label: 'Export CSV', kind: 'button', placement: 'bar' },
      {
        id: 'export-png',
        label: 'Export PNG',
        kind: 'button',
        shortcut: 'primary+I',
        placement: 'bar',
      },
    ],
    state: /^live$/,
  },
  {
    name: 'waveform',
    path: `/waveform.html?embedded=true&pv=${encodeURIComponent(WAVEFORM_PV)}`,
    ready: '[data-testid=waveform-app]',
    focus: '[data-testid=waveform-health]',
    actions: [
      { id: 'pause', label: 'Pause', kind: 'toggle', pressed: false, placement: 'bar' },
      { id: 'snapshot', label: 'Snapshot → reference', kind: 'button', placement: 'bar' },
      { id: 'export-csv', label: 'Export CSV', kind: 'button', placement: 'bar' },
      {
        id: 'export-png',
        label: 'Export PNG',
        kind: 'button',
        shortcut: 'primary+I',
        placement: 'bar',
      },
    ],
    state: /^live$/,
  },
];

const byName = (name: ToolName): ToolCase => TOOLS.find((t) => t.name === name)!;

/** The page path under the host bar. */
const hostBarPath = (tool: ToolCase): string => `${tool.path}&hostbar=1`;

/** Every backend double the three tools need: unmocked paths 503, then Hare, Mole, the Formula Engine. */
async function mockBackends(page: Page): Promise<void> {
  await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
  await mockHare(page, { waveforms: { [WAVEFORM_PV]: { length: 64, hz: 5 } } });
  await mockMole(page);
  await mockFormulaEngine(page);
  await installHost(page);
}

/** Opens `tool` in the host, under the host bar unless `plain`, and waits for its workbench. */
async function open(page: Page, tool: ToolCase, plain = false): Promise<HostedTool> {
  await mockBackends(page);
  const host = await openInHost(page, plain ? tool.path : hostBarPath(tool));
  await expect(host.frame.locator('.wb-sidebar')).toBeVisible();
  await expect(host.frame.locator(tool.ready).first()).toBeVisible();
  return host;
}

/** Every download the page starts from now on. */
function recordDownloads(page: Page): string[] {
  const names: string[] = [];
  page.on('download', (d) => names.push(d.suggestedFilename()));
  return names;
}

const reported = (entries: readonly ToolActionEntry[]): Reported[] =>
  entries.map(({ id, label, kind, shortcut, pressed, placement }) => {
    const r: Reported = { id, label, kind, placement };
    if (shortcut !== undefined) r.shortcut = shortcut;
    if (pressed !== undefined) r.pressed = pressed;
    return r;
  });

/** Waits until Trace has its archive answer, so its exports have data. */
async function traceDataLoaded(page: Page, host: HostedTool): Promise<void> {
  await expect(host.frame.locator('.plot-content canvas').first()).toBeVisible();
  await expect
    .poll(() =>
      host.content.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .some((e) => e.name.includes('/mole/') && e.name.includes('/data/'))
      )
    )
    .toBe(true);
  // One render past the answer, so the CSV builder sees the series.
  await page.waitForTimeout(300);
}

for (const tool of TOOLS) {
  test.describe(`${tool.name} under the host bar`, () => {
    test('shows no actions bar and reports its actions with real icon names', async ({ page }) => {
      const host = await open(page, tool);

      await expect(host.frame.locator('[data-testid=actions-bar]')).toHaveCount(0);
      await expect(host.frame.locator('.wb-workbench__actions')).toHaveCount(0);

      const report = await waitForToolActions(page, (m) => tool.state.test(m.state ?? ''));
      expect(report.version).toBe(1);
      expect(reported(report.actions)).toEqual(tool.actions);
      for (const a of report.actions) {
        expect(ICON_ALLOWLIST.has(a.icon ?? ''), `${a.id} icon ${a.icon}`).toBe(true);
      }
      expect(report.links).toEqual({ docs: DOCS_URL, bug: BUG_URL });
    });

    test('⌘S inside the frame posts save-view and downloads nothing', async ({ page }) => {
      const host = await open(page, tool);
      await waitForToolActions(page);
      const downloads = recordDownloads(page);
      const primary = await primaryKey(host.content);

      await host.frame.locator(tool.focus).first().click();
      await page.keyboard.press(`${primary}+s`);

      await expect.poll(async () => (await messagesOfType(page, SAVE_VIEW)).length).toBe(1);
      await page.waitForTimeout(QUIET_MS);
      expect(downloads).toEqual([]);
      expect(await messagesOfType(page, SAVE_VIEW)).toEqual([{ type: SAVE_VIEW }]);
    });

    test('with embedded=true alone keeps the actions bar and posts no report', async ({ page }) => {
      const host = await open(page, tool, true);

      await expect(host.frame.locator('[data-testid=actions-bar]')).toBeVisible();
      if (tool.name === 'trace') {
        const titles = await host.frame
          .locator('.plot-tab-bar__controls > button.view-mode-btn')
          .evaluateAll((els) => els.map((el) => el.getAttribute('title')));
        expect(titles).toEqual(['Tab view', 'Grid view', 'Add plot']);
      }
      await expect
        .poll(async () => (await messagesOfType(page, 'canopy:trace-ready')).length)
        .toBeGreaterThan(0);
      await page.waitForTimeout(QUIET_MS);
      expect(await messagesOfType(page, TOOL_ACTIONS)).toEqual([]);
    });
  });
}

test.describe('trace under the host bar', () => {
  const trace = byName('trace');

  test('the plot row draws only the time window and Add plot', async ({ page }) => {
    const host = await open(page, trace);
    const controls = host.frame.locator('.plot-tab-bar__controls');

    await expect(controls.locator(':scope > [data-range-site=tab]')).toBeVisible();
    const titles = await controls
      .locator(':scope > button')
      .evaluateAll((els) => els.map((el) => el.getAttribute('title')));
    expect(titles).toEqual(['Add plot']);
  });

  test('a tool-invoke for export-csv downloads the CSV', async ({ page }) => {
    const host = await open(page, trace);
    await waitForToolActions(page, (m) =>
      m.actions.some((a) => a.id === 'export-csv' && !a.disabled)
    );
    await traceDataLoaded(page, host);
    page.on('dialog', (d) => {
      throw new Error(`unexpected dialog: ${d.message()}`);
    });

    const download = page.waitForEvent('download');
    await invokeTool(page, 'export-csv');

    expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  });

  test('a tool-invoke for import opens the file chooser', async ({ page }) => {
    await open(page, trace);
    await waitForToolActions(page, (m) => m.actions.some((a) => a.id === 'import' && !a.disabled));

    const chooser = page.waitForEvent('filechooser', { timeout: 10_000 });
    await invokeTool(page, 'import');

    expect((await chooser).isMultiple()).toBe(false);
  });

  test('a tool-invoke for a bar verb runs it', async ({ page }) => {
    const host = await open(page, trace);
    await waitForToolActions(page, (m) =>
      m.actions.some((a) => a.id === 'data-insight' && !a.disabled)
    );
    await invokeTool(page, 'data-insight');
    await expect(host.frame.locator('.insight-tool').first()).toBeVisible();
  });

  test('a tool-invoke for an id the report does not list does nothing', async ({ page }) => {
    const downloads = recordDownloads(page);
    await open(page, trace);
    await waitForToolActions(page);

    // `post-elog` is registered but hidden embedded (no logbook), so never reported.
    await invokeTool(page, 'post-elog');
    await invokeTool(page, 'no-such-action');

    await page.waitForTimeout(QUIET_MS);
    expect(downloads).toEqual([]);
  });

  test('⌘P, ⌘O, ⌘I and Alt+D act with the bar absent', async ({ page }) => {
    const host = await open(page, trace);
    await traceDataLoaded(page, host);
    const primary = await primaryKey(host.content);
    await host.frame.locator(trace.focus).click();

    await page.keyboard.press(`${primary}+p`);
    await expect.poll(() => printCount(host.content)).toBeGreaterThan(0);

    const chooser = page.waitForEvent('filechooser', { timeout: 10_000 });
    await page.keyboard.press(`${primary}+o`);
    await chooser;

    await host.frame.locator(trace.focus).click();
    const png = page.waitForEvent('download');
    await page.keyboard.press(`${primary}+i`);
    expect((await png).suggestedFilename()).toMatch(/\.png$/);

    await host.frame.locator(trace.focus).click();
    await page.keyboard.press('Alt+d');
    await expect(host.frame.locator('.insight-tool')).toBeVisible();
  });
});

test.describe('correlation under the host bar', () => {
  test('a tool-invoke for pause flips the reported state', async ({ page }) => {
    await open(page, byName('correlation'));
    await waitForToolActions(page, (m) => m.state === 'live');

    await invokeTool(page, 'pause');

    const report = await waitForToolActions(
      page,
      (m) => m.state === 'paused',
      'state paused after Pause'
    );
    expect(report.actions.find((a) => a.id === 'pause')?.pressed).toBe(true);
  });
});

test.describe('waveform under the host bar', () => {
  test('tool-invokes for snapshot and pause both act', async ({ page }) => {
    const host = await open(page, byName('waveform'));

    // Snapshot is enabled once a live frame has arrived, and adds a reference.
    await waitForToolActions(page, (m) =>
      m.actions.some((a) => a.id === 'snapshot' && !a.disabled)
    );
    await invokeTool(page, 'snapshot');
    await expect(host.frame.locator('.wb-outline-row[data-row-id="snapshot"]')).toBeVisible();

    await invokeTool(page, 'pause');
    const report = await waitForToolActions(
      page,
      (m) => m.state === 'paused',
      'state paused after Pause'
    );
    expect(report.actions.find((a) => a.id === 'pause')?.pressed).toBe(true);
  });
});
