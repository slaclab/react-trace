// @vitest-environment jsdom
//
// The Plot tab's X-Axis (Time) section: the refresh interval's helper text
// says when a short span caps the interval (see refreshIntervalMs), since the
// field still shows the interval the user set.
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

function makePlot(overrides: Partial<Plot> = {}): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [],
    axes: [],
    backgroundColor: 'default',
    showLegend: false,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
    ...overrides,
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

describe('Refresh interval helper text', () => {
  afterEach(cleanup);
  afterAll(() => vi.unstubAllGlobals());

  it('says what the interval controls when the span allows it', () => {
    render(plotSettingsPanel(makePlot({ refreshIntervalS: 60 })));
    expect(
      screen.getByText('How often archive and formula data refresh. The axis scrolls continuously.')
    ).toBeTruthy();
  });

  it('gives the capped interval on a short span', () => {
    render(plotSettingsPanel(makePlot({ xAxis: { timeRange: '-30s' }, refreshIntervalS: 60 })));
    expect(screen.getByText(/refresh every 5 s at this span/)).toBeTruthy();
    // The field keeps the interval the user set.
    expect((screen.getByLabelText('Refresh interval (s)') as HTMLInputElement).value).toBe('60');
  });
});
