// @vitest-environment jsdom
//
// The crosshair tooltip is HTML. A workspace file can carry any text in a
// trace's label, colour or samples; none of it may become markup. Mounts
// SinglePlot with a mocked echarts-for-react and renders the tooltip it builds.
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SinglePlot } from './PlotArea';
import type { Plot, PVTrace } from '../types';
import { deserializeWorkspace, serializeWorkspace } from '../io/serialize';

interface Option {
  tooltip: { formatter: (p: { axisValue: number }[]) => string };
}

const { lastOption } = vi.hoisted(() => ({ lastOption: { current: null as unknown } }));

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component<{ option: unknown }> {
    getEchartsInstance() {
      return undefined;
    }
    render() {
      lastOption.current = this.props.option;
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

// A fixed custom window, so the x-axis end (and a trailing stretch) is exact.
const FROM_MS = Date.UTC(2026, 9, 1, 12, 0, 0);
const TO_MS = FROM_MS + 60_000;
const COLOR = '#ff00aa';

function makeTrace(over: Partial<PVTrace> = {}): PVTrace {
  return {
    id: 't1',
    pvName: 'AV:TEMP',
    displayName: 'AV:TEMP',
    color: COLOR,
    visible: true,
    axisId: 'ax1',
    useLive: false,
    updateRate: '1s',
    useArchive: false,
    lineWidth: 2,
    lineType: 'direct',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'circle',
    symbolSize: 4,
    data: [],
    ...over,
  };
}

const AX1: Plot['axes'][number] = {
  id: 'ax1',
  name: 'Y',
  orientation: 'left',
  autoScale: true,
  logScale: false,
  visible: true,
};

function makePlot(traces: PVTrace[], axes: Plot['axes'] = [AX1]): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces,
    axes,
    backgroundColor: 'default',
    showLegend: false,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: {
      timeRange: 'custom',
      timeFrom: new Date(FROM_MS).toISOString(),
      timeTo: new Date(TO_MS).toISOString(),
    },
  };
}

const PAYLOAD = '<img src=x onerror="window.__pwned=1">';

// The tooltip at a sample on a trace that shows its own samples (no live, no
// archive), rendered into a detached element.
function tooltipFor(trace: PVTrace): HTMLElement {
  const { unmount } = render(
    <SinglePlot
      plot={makePlot([trace])}
      endMs={TO_MS}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
    />
  );
  unmount();
  const html = (lastOption.current as Option).tooltip.formatter([{ axisValue: FROM_MS + 10_000 }]);
  const box = document.createElement('div');
  box.innerHTML = html;
  return box;
}

const sample = (over: Record<string, unknown>) =>
  ({
    time: FROM_MS + 10_000,
    value: 1.5,
    severity: 'NO_ALARM',
    ...over,
  }) as PVTrace['data'][number];

describe('tooltip markup', () => {
  it('names a known severity and drops any other text in its place', () => {
    expect(tooltipFor(makeTrace({ data: [sample({ severity: 'MAJOR' })] })).textContent).toContain(
      'MAJOR'
    );
    const box = tooltipFor(makeTrace({ data: [sample({ severity: PAYLOAD })] }));
    expect(box.querySelector('img')).toBeNull();
    expect(box.textContent).not.toContain('onerror');
  });

  it('shows a non-numeric value as text, not markup', () => {
    const box = tooltipFor(makeTrace({ data: [sample({ value: PAYLOAD })] }));
    expect(box.querySelector('img')).toBeNull();
    expect(box.textContent).toContain(PAYLOAD);
  });

  it('shows a label as text and uses only a colour literal as the swatch', () => {
    const box = tooltipFor(
      makeTrace({ displayName: PAYLOAD, color: `red"><img src=x>`, data: [sample({})] })
    );
    expect(box.querySelector('img')).toBeNull();
    expect(box.textContent).toContain(PAYLOAD);
    expect(box.querySelector('[style*="red"]')).toBeNull();
    expect(
      tooltipFor(makeTrace({ data: [sample({})] })).querySelector(`[style*="${COLOR}"]`)
    ).not.toBeNull();
  });
});

describe('loading a workspace file', () => {
  it('drops samples a file carries, so they never reach the tooltip', () => {
    const saved = JSON.parse(
      serializeWorkspace({ theme: 'dark', plots: [makePlot([makeTrace()])] })
    );
    saved.plots[0].traces[0].data = [sample({ severity: PAYLOAD, value: PAYLOAD })];
    const result = deserializeWorkspace(JSON.stringify(saved));
    expect(result.plots[0].traces[0].data).toEqual([]);
  });
});
