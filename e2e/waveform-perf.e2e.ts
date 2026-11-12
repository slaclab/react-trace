// Render latency of the Waveform canvas: 8 curves × 4096 elements streamed by
// the Hare double at 10 Hz each, at device scale 2 on a plot wide enough that
// minmax sampling stays off, with persistence 1 and 16 (lines), and a bars
// case (persistence 16; bars draw no trails). Over the last 5 s of the run,
// p95 of (drawn-at − the frame's scheduled send time) < 500 ms.
//
// Clocks. The mock records each frame's scheduled and actual send time with
// the test process's `Date.now()` (ms since the epoch). Drawn-at comes from
// the `wf:rendered` marks the Plot sets on ECharts' `finished` event while
// the page URL carries `bench=1` (src/tools/shared/renderMark.ts), put on the
// same epoch clock as `performance.timeOrigin + mark.startTime`; both
// processes run on this host and read the same system clock.
//
// A frame counts as drawn at the first `wf:rendered` mark at or after it was
// sent: from then on the screen shows that frame or a newer one of its PV,
// because the canvas always draws the latest published frame.
//
// Tagged `@perf`: it times the main thread, so it runs alone (`--grep @perf`)
// and every other run excludes it (`--grep-invert @perf`).

import { expect, test, type Page } from '@playwright/test';

import { mockHare, type HareFrameRecord, type HareWaveform } from './mocks';

const CURVES = 8;
const LENGTH = 4096;
const HZ = 10;
/** Streaming before the measured window: chart build, autoscale settling. */
const WARMUP_MS = 3_000;
/** The measured window: the last 5 s of the run. */
const WINDOW_MS = 5_000;
const P95_BUDGET_MS = 500;
/** Streaming after the window, so its last frames have a render to land on. */
const DRAIN_MS = 1_000;
/** Device scale and a viewport whose plot is > 4096 / (2.5 × 2) ≈ 820 CSS px. */
const DEVICE_SCALE = 2;
const VIEWPORT = { width: 1600, height: 900 };
/** The sampling rule's factor (`SAMPLING_FACTOR` in src/tools/waveform/series.ts). */
const SAMPLING_FACTOR = 2.5;
/** The Plot's render mark (`RENDERED_MARK` in src/tools/waveform/Plot.tsx). */
const RENDERED_MARK = 'wf:rendered';

const PVS = Array.from({ length: CURVES }, (_, i) => `WF:PERF:${i + 1}`);

const waveform: HareWaveform = {
  length: LENGTH,
  hz: HZ,
  value: (i, frame) => Math.sin((i + frame) / 8),
};

interface Case {
  name: string;
  persist: number;
  lineType: 'line' | 'bars';
}

const CASES: Case[] = [
  { name: 'lines, persistence 1', persist: 1, lineType: 'line' },
  { name: 'lines, persistence 16', persist: 16, lineType: 'line' },
  { name: 'bars, persistence 16', persist: 16, lineType: 'bars' },
];

function pageUrl(c: Case): string {
  const q = new URLSearchParams();
  q.set('bench', '1');
  for (const pv of PVS) q.append('pv', pv);
  if (c.persist !== 1) q.set('persist', String(c.persist));
  if (c.lineType !== 'line') {
    q.set('plot', JSON.stringify({ v: 1, traces: PVS.map(() => ({ lineType: c.lineType })) }));
  }
  return `/waveform.html?${q.toString()}`;
}

// ── Marks ───────────────────────────────────────────────────────────────────

/** Every `wf:rendered` mark so far, on the epoch clock (ms), oldest first. */
function renderedAt(mark: string): number[] {
  return performance
    .getEntriesByName(mark, 'mark')
    .map((e) => performance.timeOrigin + e.startTime)
    .sort((x, y) => x - y);
}

// ── Analysis ────────────────────────────────────────────────────────────────

/** Nearest-rank percentile. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

interface Analysis {
  latencies: number[];
  /** Frames sent in the window that no later render drew. */
  undrawn: number;
}

function analyse(
  drawn: readonly number[],
  sent: readonly HareFrameRecord[],
  windowStart: number,
  windowEnd: number
): Analysis {
  const latencies: number[] = [];
  let undrawn = 0;
  for (const r of sent) {
    if (!r.connected || r.frame === 0) continue;
    if (r.sentAt < windowStart || r.sentAt > windowEnd) continue;
    // The first render at or after the send (a 1 ms allowance for clock rounding).
    const at = drawn.find((t) => t + 1 >= r.sentAt);
    if (at === undefined) undrawn++;
    else latencies.push(at - r.scheduledAt);
  }
  return { latencies, undrawn };
}

// ── The benchmark ───────────────────────────────────────────────────────────

test.use({ deviceScaleFactor: DEVICE_SCALE, viewport: VIEWPORT });

async function sleep(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

for (const c of CASES) {
  test(
    `waveform ${c.name}: ${CURVES} × ${LENGTH} at ${HZ} Hz, frame scheduled → drawn`,
    { tag: '@perf' },
    async ({ page }) => {
      test.setTimeout(120_000);

      // Nothing may reach a real backend through the preview proxy.
      await page.route(/\/(mole|hare|formula-engine)\//, (route) => route.fulfill({ status: 503 }));
      const hare = await mockHare(page, {
        units: () => 'mm',
        waveforms: Object.fromEntries(PVS.map((pv) => [pv, waveform])),
      });

      try {
        await page.goto(pageUrl(c));
        await expect(page.getByTestId('waveform-chart')).toBeVisible();
        // Every PV streaming before the probe goes in.
        await expect
          .poll(() => new Set(hare.frames.filter((r) => r.frame > 0).map((r) => r.pv)).size, {
            timeout: 20_000,
          })
          .toBe(CURVES);

        // The chart has rendered, and is wide enough that minmax sampling is off.
        await expect
          .poll(() => page.evaluate(renderedAt, RENDERED_MARK).then((m) => m.length), {
            timeout: 20_000,
          })
          .toBeGreaterThan(0);
        const cssWidth = await page.getByTestId('waveform-chart').evaluate((el) => el.clientWidth);
        expect(cssWidth).toBeGreaterThan(LENGTH / (SAMPLING_FACTOR * DEVICE_SCALE));

        await sleep(page, WARMUP_MS + WINDOW_MS);
        const end = Date.now();
        // The window's last frames are drawn by renders just after it.
        await sleep(page, DRAIN_MS);
        const drawn = await page.evaluate(renderedAt, RENDERED_MARK);
        hare.stop();

        const windowStart = end - WINDOW_MS;
        const { latencies, undrawn } = analyse(drawn, hare.frames, windowStart, end);
        const sorted = [...latencies].sort((a, b) => a - b);
        const p95 = sorted.length === 0 ? Number.NaN : percentile(sorted, 95);
        const rendersInWindow = drawn.filter((t) => t >= windowStart && t <= end).length;
        const summary =
          `waveform ${c.name}: p95 ${p95.toFixed(1)} ms, max ${(sorted[sorted.length - 1] ?? NaN).toFixed(1)} ms, ` +
          `${latencies.length} curve-frames drawn, ${undrawn} undrawn, ` +
          `${rendersInWindow} renders in the last ${WINDOW_MS / 1000} s`;
        console.log(summary);
        test.info().annotations.push({ type: 'render-perf', description: summary });

        // Something must have been drawn in the window. A run without renders
        // never completed a frame: each new option restarted the paint (e.g.
        // progressive rendering) before it ended.
        expect(
          rendersInWindow,
          `renders completed in the last ${WINDOW_MS / 1000} s`
        ).toBeGreaterThan(0);
        expect(undrawn, 'frames sent in the window that no render drew').toBe(0);
        expect(latencies.length).toBeGreaterThanOrEqual(CURVES);
        expect(p95, `${c.name} p95 scheduled → drawn`).toBeLessThan(P95_BUDGET_MS);
      } finally {
        hare.stop();
      }
    }
  );
}
