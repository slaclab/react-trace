// @vitest-environment jsdom
//
// Pins issue 108: axes created after the Layers panel mounts (Add Axis, a new
// plot's default Y-Axis 1, the axis made for a PV's units) must start
// expanded, showing their traces and Add Trace / Add Formula buttons.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { LeftPanel } from './LeftPanel';
import type { Axis, Plot, PVTrace } from '../types';

function makeAxis(id: string, name = id): Axis {
  return { id, name, orientation: 'left', autoScale: true, logScale: false, visible: true };
}

function makeTrace(id: string, axisId: string): PVTrace {
  return {
    id,
    pvName: `PV:${id}`,
    displayName: '',
    color: '#0f62fe',
    visible: true,
    axisId,
    useLive: false,
    updateRate: 'monitor',
    useArchive: false,
    lineWidth: 2,
    lineType: 'step',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'circle',
    symbolSize: 10,
    data: [],
  };
}

function makePlot(id: string, axes: Axis[], traces: PVTrace[] = []): Plot {
  return {
    id,
    title: id,
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
    xAxis: { timeRange: '1h' },
  };
}

function panel(plots: Plot[]) {
  return (
    <LeftPanel
      plots={plots}
      activePlotId={plots[0].id}
      viewMode="grid"
      archiveResultsByPlot={new Map()}
      collapsed={false}
      onCollapse={vi.fn()}
      onExpand={vi.fn()}
      selectedItem={null}
      onSelectItem={vi.fn()}
      onAddTrace={vi.fn()}
      onAddFormula={vi.fn()}
      onDeleteTrace={vi.fn()}
      onAddAxis={vi.fn()}
      onSearchPvs={vi.fn()}
      onDeleteAxis={vi.fn()}
      onMoveTrace={vi.fn()}
    />
  );
}

describe('LeftPanel axis expansion', () => {
  afterEach(cleanup);

  it('shows axes added after mount expanded', () => {
    const p1 = makePlot('p1', [makeAxis('ax1')], [makeTrace('t1', 'ax1')]);
    const { rerender } = render(panel([p1]));
    expect(screen.getAllByText('Add Trace')).toHaveLength(1);

    // A units axis now holds the trace (it moved there after a PV pick), and a
    // new plot arrived with its default Y-Axis 1.
    const p1WithUnitsAxis = makePlot(
      'p1',
      [makeAxis('ax1'), makeAxis('ax-mj', 'mJ')],
      [makeTrace('t1', 'ax-mj')]
    );
    const p2 = makePlot('p2', [makeAxis('p2-axis-1', 'Y-Axis 1')]);
    rerender(panel([p1WithUnitsAxis, p2]));

    expect(screen.getByText('PV:t1')).toBeTruthy();
    expect(screen.getAllByText('Add Trace')).toHaveLength(3);
    expect(screen.getAllByText('Add Formula')).toHaveLength(3);
    expect(screen.queryAllByTitle('Expand')).toHaveLength(0);
  });

  it('still collapses and re-expands one axis at a time', () => {
    const plot = makePlot(
      'p1',
      [makeAxis('ax1'), makeAxis('ax2')],
      [makeTrace('t1', 'ax1'), makeTrace('t2', 'ax2')]
    );
    render(panel([plot]));

    fireEvent.click(screen.getAllByTitle('Collapse')[0]);
    expect(screen.queryByText('PV:t1')).toBeNull();
    expect(screen.getByText('PV:t2')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Expand'));
    expect(screen.getByText('PV:t1')).toBeTruthy();
  });
});
