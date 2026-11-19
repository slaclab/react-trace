// The render benchmark hook of the context tools (Correlation, Waveform).
//
// With `bench=1` in the page URL, a tool's chart marks `name` in the
// performance timeline each time ECharts reports `finished`. The e2e specs
// time renders against these marks: e2e/correlation-perf.e2e.ts and
// e2e/waveform-perf.e2e.ts pair them with a mark on the incoming socket
// message, and the drawing and gesture specs wait for the first one. Without
// the key nothing is marked, so a page left open for hours does not fill the
// performance timeline. The key is a page key: state writes keep it in the URL.

/** The query key that turns the render marks on. */
export const BENCH_KEY = 'bench';

/** Whether this page marks its renders. */
export function benchMarksOn(): boolean {
  return new URLSearchParams(window.location.search).get(BENCH_KEY) === '1';
}

/** Mark one finished render as `name`, when the page is a benchmark run. */
export function markRendered(name: string): void {
  if (benchMarksOn()) performance.mark(name);
}
