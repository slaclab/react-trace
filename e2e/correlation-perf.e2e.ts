// Render budget of the correlation plot: 20 frames of 10 000 rows × 9
// columns (X + 8 Ys); the time from the Formula Engine WebSocket message to the chart
// having rendered must stay at median < 150 ms, p95 < 250 ms, in the scatter
// and in the density view — and in the scatter with Fade on (`fade=1`: five
// age buckets per Y) at n = 5 000 and n = 10 000, within the same budget. The
// density view ignores Fade, so it has no Fade case.
//
// Timing is one `performance.measure` per frame between two marks:
//   - `corr:msg`, set by this file's init script on the raw `message` event of
//     every socket whose URL ends in `/formula-engine/v1/ws/formulas` — before the SDK's
//     JSON.parse, since the wrapper's listener is added in the constructor,
//     ahead of the SDK's own handler;
//   - `corr:rendered`, set by `Plot` on ECharts' `finished` event when the
//     page URL carries `bench=1`.
// Frames are sent one at a time; each pair is read (and the measure taken)
// before the harness clears both marks and sends the next frame. A frame that
// does not yield exactly one `corr:msg` and at least one later
// `corr:rendered` fails the test, so the run has exactly 20 paired measures
// per view or none.
//
// Both sockets are mocked with `page.routeWebSocket` (the shared doubles of
// `./mocks`): `vite preview` inherits the dev proxy, so an unmocked socket
// would reach a real backend. The mocked Hare answers each subscribe once with
// an `initial` (scalar, connected, one unit per axis) so the PVs are accepted,
// and after that sends only a `pong` per `ping`; Hare messages are not marked.
// The mocked Formula Engine answers no ping: a Formula Engine `pong` would be a stray `corr:msg`.
//
// Tagged `@perf`: it times the main thread, so it runs alone (`--grep @perf`)
// and every other run excludes it (`--grep-invert @perf`).
//
// Order matters: `routeWebSocket` is registered before `addInitScript`, so the
// wrapper subclasses the mocked constructor rather than being replaced by it.

import { expect, test, type Page } from '@playwright/test';

import {
  FORMULA_ENGINE_PATH,
  mockFormulaEngine,
  mockHare,
  type FormulaEngineSubscription,
} from './mocks';

const ROWS = 10_000;
const Y_COUNT = 8;
const MEASURED_FRAMES = 20;
const MEDIAN_BUDGET_MS = 150;
const P95_BUDGET_MS = 250;
/** Per-frame wait for its render; far above the budget, only a hang hits it. */
const FRAME_TIMEOUT_MS = 10_000;
/** PV metadata (≤ 3 s), spec debounce (300 ms) and socket open, with margin. */
const SUBSCRIBE_TIMEOUT_MS = 20_000;

const X_PV = 'PERF:X';
const Y_PVS = Array.from({ length: Y_COUNT }, (_, i) => `PERF:Y${i + 1}`);

interface Case {
  view: 'scatter' | 'density';
  rows: number;
  fade: boolean;
}

const CASES: Case[] = [
  { view: 'scatter', rows: ROWS, fade: false },
  { view: 'density', rows: ROWS, fade: false },
  { view: 'scatter', rows: 5_000, fade: true },
  { view: 'scatter', rows: ROWS, fade: true },
];

function pageUrl(c: Case): string {
  const params = new URLSearchParams();
  params.append('x', X_PV);
  for (const pv of Y_PVS) params.append('y', pv);
  params.append('dt', '1');
  params.append('n', String(c.rows));
  params.append('view', c.view);
  if (c.fade) params.append('fade', '1');
  // The render marks are on only in a benchmark run.
  params.append('bench', '1');
  return `/correlation.html?${params.toString()}`;
}

// A deterministic `rows`-row table frame; frame k's rows end 1 s after frame
// k-1's, so the data clock advances every frame.
function tableFrame(sub: FormulaEngineSubscription, k: number, rows: number): string {
  let seed = 0x9e3779b9 ^ k;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000 - 0.5;
  };
  const t0 = 1_790_000_000_000_000_000 + k * 1_000_000_000;
  const tsNs = Array.from({ length: rows }, (_, i) => t0 + i * 100_000);
  const x = Array.from({ length: rows }, (_, i) => (i / rows) * 10 + noise() * 0.01);
  const columns: Record<string, number[]> = {};
  sub.columns.forEach((name, c) => {
    columns[name] = name === 'x' ? x : x.map((v) => v * (0.1 * c) + noise() * 0.05 + c);
  });
  const inputs: Record<string, unknown> = {};
  for (const binding of sub.bindings) {
    inputs[binding] = { history: 'seeded', status: 'ok', lateAfterFinal: false };
  }
  return JSON.stringify({
    type: 'result',
    id: sub.serverId,
    data: { kind: 'table', table: { tsNs, columns, inputs, totalRows: rows } },
  });
}

// ── Marks ───────────────────────────────────────────────────────────────────

/** The init script: mark `corr:msg` on every raw Formula Engine socket message. */
function markFormulaEngineMessages(formulaEnginePath: string): void {
  const Base = window.WebSocket;
  class MarkedWebSocket extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      if (new URL(String(url), window.location.href).pathname.endsWith(formulaEnginePath)) {
        this.addEventListener('message', () => performance.mark('corr:msg'));
      }
    }
  }
  window.WebSocket = MarkedWebSocket;
}

async function clearMarks(page: Page): Promise<void> {
  await page.evaluate(() => {
    performance.clearMarks('corr:msg');
    performance.clearMarks('corr:rendered');
    performance.clearMeasures('corr:frame');
  });
}

type PairResult = { ok: true; ms: number } | { ok: false; reason: string };

/**
 * Wait for the frame's pair, measure it and clear the marks — all in one page
 * task, so no later mark can slip in between reading and clearing.
 */
async function readPair(page: Page, frame: number): Promise<number> {
  const handle = await page.waitForFunction(
    () => {
      const msgs = performance.getEntriesByName('corr:msg', 'mark');
      if (msgs.length === 0) return null;
      const start = msgs[0].startTime;
      const rendered = performance
        .getEntriesByName('corr:rendered', 'mark')
        .filter((m) => m.startTime >= start);
      if (rendered.length === 0) return null;
      let result: PairResult;
      if (msgs.length !== 1) {
        result = { ok: false, reason: `${msgs.length} corr:msg marks for one frame` };
      } else {
        const measure = performance.measure('corr:frame', {
          start,
          end: rendered[0].startTime,
        });
        result = { ok: true, ms: measure.duration };
      }
      performance.clearMarks('corr:msg');
      performance.clearMarks('corr:rendered');
      performance.clearMeasures('corr:frame');
      return result;
    },
    undefined,
    { timeout: FRAME_TIMEOUT_MS, polling: 'raf' }
  );
  const result = (await handle.jsonValue()) as PairResult;
  if (!result.ok) throw new Error(`frame ${frame}: ${result.reason}`);
  return result.ms;
}

// ── Statistics ──────────────────────────────────────────────────────────────

function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Nearest-rank percentile. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

// ── The benchmark ───────────────────────────────────────────────────────────

for (const c of CASES) {
  const view = `${c.view}${c.fade ? ' + fade' : ''}`;
  test(
    `${view}: WS message → chart rendered, 20 frames of ${c.rows} × ${Y_COUNT + 1}`,
    { tag: '@perf' },
    async ({ page }) => {
      test.setTimeout(120_000);

      // Nothing may reach a real backend through the preview proxy.
      await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
      await mockHare(page, { units: (pv) => (pv === X_PV ? 'A' : 'mm') });
      const engine = await mockFormulaEngine(page);
      // After routeWebSocket, so the wrapper extends the mocked constructor.
      await page.addInitScript(markFormulaEngineMessages, FORMULA_ENGINE_PATH);

      await page.goto(pageUrl(c));

      const sub = await Promise.race([
        engine.subscribed,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `no Formula Engine table subscribe within ${SUBSCRIBE_TIMEOUT_MS} ms: ` +
                    'correlation.html must mount the plot and subscribe its table'
                )
              ),
            SUBSCRIBE_TIMEOUT_MS
          )
        ),
      ]);
      expect(sub.columns).toEqual(['x', ...Y_PVS.map((_, i) => `y${i + 1}`)]);
      await expect(page.locator('.correlation-plot__chart')).toBeVisible();

      // Warm-up: the first frame also builds the chart; it is not measured.
      await clearMarks(page);
      sub.ws.send(tableFrame(sub, 0, c.rows));
      await readPair(page, 0);

      const durations: number[] = [];
      for (let k = 1; k <= MEASURED_FRAMES; k++) {
        const payload = tableFrame(sub, k, c.rows);
        await clearMarks(page);
        sub.ws.send(payload);
        durations.push(await readPair(page, k));
      }

      expect(durations).toHaveLength(MEASURED_FRAMES);
      const sorted = [...durations].sort((a, b) => a - b);
      const med = median(sorted);
      const p95 = percentile(sorted, 95);
      const summary = `${view} (n = ${c.rows}): median ${med.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms over ${durations.length} frames`;
      console.log(summary);
      test.info().annotations.push({ type: 'render-perf', description: summary });

      expect(med, `${view} median`).toBeLessThan(MEDIAN_BUDGET_MS);
      expect(p95, `${view} p95`).toBeLessThan(P95_BUDGET_MS);
    }
  );
}
