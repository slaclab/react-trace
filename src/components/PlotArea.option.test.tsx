// @vitest-environment jsdom
//
// Renders SinglePlot with echarts-for-react replaced by a recorder and checks
// the ECharts option it builds: canopy-charts' g10/g100 chart theme, the
// plot-background override, trace's own sizing on top, and the canopy-charts
// number formatters in the axis ticks and tooltip.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { CHART_THEMES, formatAxisTick } from '@slaclab/canopy-charts';
import { setColorMode } from '@slaclab/canopy-shell/color-mode';
import { memoryStorage } from '../test/dom';
import { setupColorMode } from '../state/colorMode';
import { SinglePlot } from './PlotArea';
import type { Plot, PVTrace } from '../types';

// Loose view of the option object; the tests only read a few fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Option = Record<string, any>;

const h = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component<{ option: Record<string, unknown> }> {
    getEchartsInstance() {
      return undefined;
    }
    render() {
      h.options.push(this.props.option);
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

const lastOption = (): Option => h.options[h.options.length - 1] as Option;

const NOW = Date.now();

function makeTrace(values: number[]): PVTrace {
  return {
    id: 't1',
    pvName: 'TEST:PV',
    displayName: 'TEST:PV',
    color: '#33b1ff',
    visible: true,
    axisId: 'ax1',
    useLive: false,
    updateRate: '1s',
    useArchive: false,
    lineWidth: 1,
    lineType: 'direct',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'none',
    symbolSize: 4,
    // Mock samples (no live/archive source), one per second ending now.
    data: values.map((value, i) => ({ time: NOW - (values.length - 1 - i) * 1000, value })),
  };
}

function makePlot(overrides: Partial<Plot> = {}): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [makeTrace([1, 2, 3])],
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
    backgroundColor: '#161616',
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
    ...overrides,
  };
}

function renderPlot(plot: Plot) {
  return render(
    <SinglePlot
      plot={plot}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
    />
  );
}

beforeEach(() => {
  h.options.length = 0;
  vi.stubGlobal('localStorage', memoryStorage());
  setupColorMode(); // nothing stored: dark
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SinglePlot chart theme', () => {
  it('uses the g100 chart theme in dark mode', () => {
    renderPlot(makePlot());
    const opt = lastOption();
    const dark = CHART_THEMES.dark;
    expect(opt.animation).toBe(false);
    expect(opt.backgroundColor).toBe(dark.bg);
    expect(opt.xAxis.axisLabel.color).toBe(dark.axisLabel);
    expect(opt.xAxis.axisLine.lineStyle.color).toBe(dark.axisLine);
    expect(opt.xAxis.splitLine.lineStyle.color).toBe(dark.splitLine);
    expect(opt.yAxis[0].axisLabel.color).toBe(dark.axisLabel);
    expect(opt.yAxis[0].axisLine).toMatchObject({
      show: true,
      lineStyle: { color: dark.axisLine },
    });
    expect(opt.yAxis[0].nameTextStyle.color).toBe(dark.axisName);
    expect(opt.tooltip.backgroundColor).toBe(dark.tooltipBg);
    expect(opt.tooltip.borderColor).toBe(dark.tooltipBorder);
    expect(opt.tooltip.axisPointer.lineStyle.color).toBe(dark.crosshair);
    expect(opt.legend.textStyle.color).toBe(dark.legend);
  });

  it('follows the color mode to the g10 chart theme', () => {
    renderPlot(makePlot());
    act(() => setColorMode('light'));
    const opt = lastOption();
    const light = CHART_THEMES.light;
    expect(opt.backgroundColor).toBe(light.bg);
    expect(opt.yAxis[0].axisLabel.color).toBe(light.axisLabel);
    expect(opt.xAxis.splitLine.lineStyle.color).toBe(light.splitLine);
    expect(opt.tooltip.backgroundColor).toBe(light.tooltipBg);
    expect(opt.legend.textStyle.color).toBe(light.legend);
  });

  it('keeps a user-chosen plot background', () => {
    renderPlot(makePlot({ backgroundColor: '#123456' }));
    expect(lastOption().backgroundColor).toBe('#123456');
  });

  it("keeps trace's own sizes and gridline style on top of the shared styling", () => {
    renderPlot(makePlot({ tickFontSize: 13, gridStyle: 'dashed', gridOpacity: 0.5 }));
    const opt = lastOption();
    expect(opt.xAxis.axisLabel.fontSize).toBe(13);
    expect(opt.yAxis[0].axisLabel.fontSize).toBe(13);
    expect(opt.yAxis[0].nameTextStyle.fontSize).toBe(11);
    expect(opt.xAxis.splitLine.lineStyle).toMatchObject({ type: 'dashed', opacity: 0.5 });
    expect(opt.tooltip.textStyle.fontSize).toBe(11);
    expect(opt.legend.textStyle.fontSize).toBe(11);
    expect(opt.legend.bottom).toBe(8);
  });
});

describe('SinglePlot number formatting', () => {
  // The tooltip line for the trace's sample nearest the cursor (at NOW).
  function tooltipFor(value: number): string {
    renderPlot(makePlot({ traces: [makeTrace([value])] }));
    return lastOption().tooltip.formatter([{ axisValue: NOW }]);
  }

  it('formats y-axis ticks with canopy-charts formatAxisTick', () => {
    const formatter = lastOptionAfterRender().yAxis[0].axisLabel.formatter;
    expect(formatter).toBe(formatAxisTick);
    expect(formatter(5e-4)).toBe('5.0e-4');
    expect(formatter(1_500_000)).toBe('1.5e+6');
    expect(formatter(12.5)).toBe('12.5');
  });

  it('shows tooltip values with trailing zeros trimmed', () => {
    const html = tooltipFor(0.5);
    expect(html).toMatch(/: 0\.5 <span/);
    expect(html).not.toContain('0.5000000');
  });

  it('shows small and large tooltip values in trimmed exponential form', () => {
    expect(tooltipFor(1.23456789e-5)).toMatch(/: 1\.234568e-5 <span/);
    expect(tooltipFor(2e7)).toMatch(/: 2e\+7 <span/);
  });

  it('formats the crosshair y readout the same way', () => {
    const label = lastOptionAfterRender().tooltip.axisPointer.label;
    expect(label.formatter({ value: 12.3, axisDimension: 'y' })).toBe('12.3');
  });

  function lastOptionAfterRender(): Option {
    renderPlot(makePlot());
    return lastOption();
  }
});
