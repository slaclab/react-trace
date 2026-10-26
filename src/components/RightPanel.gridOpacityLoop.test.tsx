// @vitest-environment jsdom
//
// The Gridline Opacity slider could get stuck swapping between two steps: after
// a few quick ArrowLeft presses, the chart's gridline opacity flipped between
// 0.5 and 0.55 forever with no further input. Carbon's Slider syncs its
// `value` prop into its own state in one effect and reports that state through
// onChange in another; when a keypress renders in the same batch as the store
// update for the previous key, those effects keep handing each other's value
// back. A real keypress hits that window only by timing, so these tests send
// the second keypress from inside the store update (or its commit) to force
// the same ordering.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { useLayoutEffect, useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function pressArrowLeft() {
  // A native event, so it can be sent from inside a React update without
  // nesting act().
  document
    .querySelector('[role="slider"]')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
}

// Stops applying store updates past this many, so a loop ends the test
// instead of hanging it.
const MAX_APPLIED = 20;

/**
 * Holds the plot like TraceApp does and records every gridOpacity the slider
 * sends. `secondKey` says when to press ArrowLeft again after the first press:
 * - 'with-store-update': while the first store update is still pending, so
 *   React renders the two together.
 * - 'after-store-commit': once that update has rendered, before the slider's
 *   effects for it have run.
 */
function Harness({
  updates,
  secondKey,
}: {
  updates: number[];
  secondKey?: 'with-store-update' | 'after-store-commit';
}) {
  const [plot, setPlot] = useState(() => makePlot(0.6));
  const sentSecondKey = useRef(false);
  useLayoutEffect(() => {
    if (secondKey !== 'after-store-commit' || updates.length !== 1 || sentSecondKey.current) {
      return;
    }
    sentSecondKey.current = true;
    pressArrowLeft();
  }, [plot.gridOpacity, secondKey, updates]);
  return (
    <>
      <button onClick={() => setPlot((p) => ({ ...p, gridOpacity: 0.6 }))}>Reset opacity</button>
      <button onClick={() => setPlot((p) => ({ ...p, gridOpacity: 0.8 }))}>
        Set opacity to 80%
      </button>
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
        onUpdatePlot={(u) => {
          updates.push(u.gridOpacity!);
          if (updates.length > MAX_APPLIED) return;
          setPlot((p) => ({ ...p, ...u }));
          if (secondKey === 'with-store-update' && updates.length === 1) pressArrowLeft();
        }}
        onApplyPalette={vi.fn()}
        onInspectTrace={vi.fn()}
        onCreateFormula={vi.fn()}
        onCollapse={vi.fn()}
        onExpand={vi.fn()}
        getAxisRange={() => undefined}
      />
    </>
  );
}

describe('Gridline Opacity slider', () => {
  afterEach(cleanup);
  afterAll(() => vi.unstubAllGlobals());

  it('settles when a keypress renders together with the previous store update', () => {
    const updates: number[] = [];
    render(<Harness updates={updates} secondKey="with-store-update" />);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowLeft' });

    expect(updates).toEqual([0.55, 0.5]);
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('50');
    // The label shows the stored value, so it has to end on the same step.
    expect(screen.getByRole('slider', { name: 'Gridline Opacity (50%)' })).toBeTruthy();
  });

  it("keeps a keypress that lands before the slider's effects for a store update", () => {
    const updates: number[] = [];
    render(<Harness updates={updates} secondKey="after-store-commit" />);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowLeft' });

    expect(updates).toEqual([0.55, 0.5]);
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('50');
    // The label shows the stored value, so it has to end on the same step.
    expect(screen.getByRole('slider', { name: 'Gridline Opacity (50%)' })).toBeTruthy();
  });

  it('follows a change made outside the slider', () => {
    const updates: number[] = [];
    render(<Harness updates={updates} />);
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowLeft' });
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('55');

    // Back to the value the slider started with.
    fireEvent.click(screen.getByRole('button', { name: 'Reset opacity' }));
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('60');

    // And to one it hasn't had.
    fireEvent.click(screen.getByRole('button', { name: 'Set opacity to 80%' }));
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('80');
    expect(screen.getByRole('slider', { name: 'Gridline Opacity (80%)' })).toBeTruthy();
    expect(updates).toEqual([0.55]);
  });
});
