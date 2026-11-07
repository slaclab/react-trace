// @vitest-environment jsdom
//
// Issue 114: the Gridline Opacity slider's number input sat past the right edge
// of the Properties panel at its default width. The slider now hides that
// input and shows the value in its label instead. (The CSS that lets the track
// shrink can't be checked here: jsdom has no layout.)
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RightPanel } from './RightPanel';
import type { Plot } from '../types';

// ArchiverPicker fetches the archiver list on mount; keep it pending so the
// test needs no backend.
vi.mock('../api/mole', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/mole')>()),
  listArchivers: () => new Promise(() => {}),
}));

// Carbon's Tabs query media features; jsdom doesn't implement matchMedia.
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

function makePlot(gridOpacity: number): Plot {
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
    gridOpacity,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
  };
}

function plotSettingsPanel(plot: Plot) {
  return (
    <RightPanel
      selectedItem={{ type: 'plot', id: plot.id, plotId: plot.id }}
      activePlot={plot}
      nowMs={0}
      archiveResults={new Map()}
      liveResults={new Map()}
      collapsed={false}
      onUpdateTrace={vi.fn()}
      onSelectPv={vi.fn()}
      onUpdateAxis={vi.fn()}
      onUpdatePlot={vi.fn()}
      onApplyPalette={vi.fn()}
      onInspectTrace={vi.fn()}
      onCreateFormula={vi.fn()}
      onCollapse={vi.fn()}
      onExpand={vi.fn()}
      getAxisRange={() => undefined}
    />
  );
}

describe('Gridline Opacity slider', () => {
  afterEach(cleanup);
  afterAll(() => vi.unstubAllGlobals());

  it('hides the number input that overflowed the panel', () => {
    const { container } = render(plotSettingsPanel(makePlot(0.4)));
    const input = container.querySelector('#grid-opacity-input-for-slider');
    expect(input).not.toBeNull();
    expect(input!.getAttribute('type')).toBe('hidden');
  });

  it('shows the current value in the label', () => {
    const { rerender } = render(plotSettingsPanel(makePlot(0.4)));
    expect(screen.getByRole('slider', { name: 'Gridline Opacity (40%)' })).toBeTruthy();

    rerender(plotSettingsPanel(makePlot(0.75)));
    expect(screen.getByRole('slider', { name: 'Gridline Opacity (75%)' })).toBeTruthy();
  });
});
