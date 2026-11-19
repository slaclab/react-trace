// Browser tests for the built app, served by `vite preview`. Preview serves
// only a prior build, so the web server builds first.
//
// Specs are named *.e2e.ts so vitest's default include (*.test.* / *.spec.*)
// never collects them. `vite preview` inherits the dev proxy (`/mole`, `/hare`,
// `/formula-engine`), so every spec must mock the sockets it opens with
// `page.routeWebSocket`, or they reach whatever CANOPY_BASE_URL points at.
//
// A spec that asserts on wall-clock timing is tagged `@perf` (Playwright's
// `{ tag: '@perf' }`). Gates that share the host run `--grep-invert @perf`;
// the perf gate alone runs `--grep @perf`, with nothing beside it.

import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 4183);
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts$/,
  // The render benchmark times the main thread: one worker, nothing beside it.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: origin,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm build && pnpm preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${origin}/correlation.html`,
    // Always a fresh build: a stale server would benchmark old code.
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
