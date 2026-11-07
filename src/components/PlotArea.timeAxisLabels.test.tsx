// @vitest-environment jsdom
//
// Issue 117: in narrow grid cells the time-axis labels ran together, because
// ECharts keeps its time-tick spacing however little room each label has. The
// x-axis must let ECharts drop labels that would overlap.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SinglePlot } from './PlotArea';
import type { Plot } from '../types';

// Every option SinglePlot hands to the chart, newest last.
const { options } = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component<{ option: Record<string, unknown> }> {
    // No instance: SinglePlot's effects bail out early without one.
    getEchartsInstance() {
      return undefined;
    }
    render() {
      options.push(this.props.option);
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

function makePlot(): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [],
    axes: [
      {
        id: 'ax1',
        name: 'Y',
        orientation: 'left',
        autoScale: true,
        logScale: false,
        visible: true,
      },
    ],
    backgroundColor: 'default',
    showLegend: false,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
  };
}

describe('time axis labels', () => {
  afterEach(() => {
    cleanup();
    options.length = 0;
  });

  it('hides labels that would overlap', () => {
    render(
      <SinglePlot
        plot={makePlot()}
        endMs={0}
        archiveResults={new Map()}
        liveResults={new Map()}
        formulaResults={new Map()}
      />
    );
    const xAxis = options.at(-1)?.xAxis as { type: string; axisLabel: { hideOverlap?: boolean } };
    expect(xAxis.type).toBe('time');
    expect(xAxis.axisLabel.hideOverlap).toBe(true);
  });
});
