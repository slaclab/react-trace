// A stand-in for canopy-charts' CanopyChart. jsdom has no canvas, so tests that
// mount SinglePlot replace the wrapper and keep the rest of the package:
//
//   vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
//     (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
//   );
//
// The stand-in renders a plain div, hands `chartStub.instance` to `onReady`
// after mount (as CanopyChart does once ECharts is ready) and records the
// props of its latest render. `fireChartEvent` calls a handler the way
// CanopyChart does, with the event params and the chart.
//
// Only types are imported from canopy-charts here: a value import would load
// the mocked module from inside its own mock.
import { Component, createElement, type ReactNode } from 'react';
import type { ECharts } from 'echarts';
import type { CanopyChartProps } from '@slaclab/canopy-charts';

export const chartStub: {
  /** Given to `onReady` after mount. Left undefined, the chart never becomes ready. */
  instance: unknown;
  /** Props of the latest render. */
  props: CanopyChartProps | null;
  /** Called on every render; return an element to render instead, or throw. */
  onRender?: (props: CanopyChartProps) => ReactNode | void;
} = { instance: undefined, props: null };

/** Fire a chart event at the latest render's handler, as CanopyChart would. */
export function fireChartEvent(name: string, params: unknown = {}): void {
  chartStub.props?.onEvents?.[name]?.(params, chartStub.instance as ECharts);
}

// A class, like the echarts-for-react component CanopyChart wraps: it records
// each render's props and reports ready once per mount, like a chart that is
// never re-created.
class StubCanopyChart extends Component<CanopyChartProps> {
  componentDidMount() {
    if (chartStub.instance) this.props.onReady?.(chartStub.instance as ECharts);
  }

  render() {
    chartStub.props = this.props;
    return chartStub.onRender?.(this.props) ?? createElement('div', { 'data-testid': 'chart' });
  }
}

export async function mockCanopyCharts(importOriginal: () => Promise<unknown>) {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, CanopyChart: StubCanopyChart };
}
