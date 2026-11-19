// @vitest-environment jsdom
//
// The panel's distribution block: shown only with Show
// distribution on, one chart per shown row (hidden rows and rows without a
// value get none / a note), the panel open for it even without a metric on.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('echarts-for-react', () => ({
  default: (props: { option: { title: { text: string } } }) => (
    <div data-testid="echarts" data-title={props.option.title.text} />
  ),
}));

const { StatisticsPanel } = await import('./StatisticsPanel');
const { CORRELATION_METRICS } = await import('../tools/correlation/metrics');
const { defaultMetrics } = await import('./model');
const { evaluateMetrics } = await import('./evaluate');
const { densitySteps, histogram } = await import('./histogram');

afterEach(cleanup);

const frame = {
  rows: [
    {
      id: 'a',
      label: 'A',
      color: '#f00',
      columns: { x: [0, 1, 2, 3], y: [1, 2, 2, 5], t: [0, 0, 0, 0] },
    },
    { id: 'b', label: 'B', hidden: true, columns: { x: [0], y: [9], t: [0] } },
    { id: 'c', label: 'C', columns: { x: [], y: [], t: [] } },
  ],
};

function mount(distribution: boolean, metrics = defaultMetrics(CORRELATION_METRICS)) {
  const table = evaluateMetrics(CORRELATION_METRICS, frame, metrics);
  return render(
    <StatisticsPanel
      show
      catalog={CORRELATION_METRICS}
      metrics={metrics}
      table={table}
      strips={{ points: [] }}
      unitOf={(_row, unit) => (unit === 'y' ? 'mA' : '')}
      distribution={distribution}
      frame={frame}
    />
  );
}

describe('StatisticsPanel distribution', () => {
  it('is absent while Show distribution is off', () => {
    mount(false);
    expect(screen.queryByTestId('stats-distribution')).toBeNull();
  });

  it('draws one density per shown row, titled with n, mean and σ in the value unit', () => {
    mount(true);
    const block = screen.getByTestId('stats-distribution');
    const charts = [...block.querySelectorAll('[data-testid="echarts"]')];
    expect(charts).toHaveLength(1);
    expect(charts[0].getAttribute('data-title')).toBe('A — n 4, mean 2.500 mA, σ 1.732 mA');
    expect(screen.getByTestId('dist-empty-c').textContent).toBe('C: no values');
    expect(block.querySelector('[data-testid="dist-b"]')).toBeNull();
  });

  it('opens the panel for the distribution even with every metric off', () => {
    const off = defaultMetrics(CORRELATION_METRICS).map((m) => ({ ...m, on: false }));
    mount(true, off);
    expect(screen.getByTestId('stats-panel')).toBeTruthy();
    expect(screen.getByTestId('stats-distribution')).toBeTruthy();
  });

  it('steps hold each bin density to the next edge and close at the last edge', () => {
    const h = histogram([1, 2, 2, 5])!;
    const steps = densitySteps(h);
    expect(steps).toHaveLength(h.density.length + 1);
    expect(steps[0]).toEqual([h.edges[0], h.density[0]]);
    expect(steps[steps.length - 1]).toEqual([5, h.density[h.density.length - 1]]);
  });
});
