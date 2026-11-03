// @vitest-environment jsdom
//
// The Search PVs dialog (#43): matches come from the target plot's archiver,
// ticks survive a change of pattern and are added in the order ticked, a
// double-click adds the selection plus that match, and PVs already on the
// plot are marked.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { PVSearchModal, PV_SEARCH_LIMIT } from './PVSearchModal';
import type { Plot, PVTrace } from '../types';

interface SearchCall {
  pattern: string;
  options: { archiver?: string; limit?: number };
  resolve: (pvs: string[]) => void;
  reject: (err: Error) => void;
}

const { searchCalls } = vi.hoisted(() => ({ searchCalls: [] as SearchCall[] }));

vi.mock('../api/mole', () => ({
  searchPVs: (pattern: string, options: SearchCall['options'], signal: AbortSignal) =>
    new Promise((resolve, reject) => {
      searchCalls.push({ pattern, options, resolve: (pvs) => resolve({ pvs }), reject });
      signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      );
    }),
}));

function trace(pvName: string): PVTrace {
  return {
    id: `trace-${pvName}`,
    pvName,
    displayName: '',
    color: '#4589ff',
    visible: true,
    axisId: 'axis-1',
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

function makePlot(id: string, title: string, extra: Partial<Plot> = {}): Plot {
  return {
    id,
    title,
    traces: [],
    axes: [],
    backgroundColor: '#161616',
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
    ...extra,
  };
}

// Plot 1 already shows KLYS:B.
const plot1 = makePlot('plot-1', 'Plot 1', { archiver: 'lcls', traces: [trace('KLYS:B')] });
const plot2 = makePlot('plot-2', 'Plot 2', { archiver: 'facet' });
// Plot 3 reads the same archiver as plot 1.
const plot3 = makePlot('plot-3', 'Plot 3', { archiver: 'lcls' });

function renderModal(props: Partial<ComponentProps<typeof PVSearchModal>> = {}) {
  const onAdd = vi.fn();
  const onClose = vi.fn();
  const element = (next: Partial<ComponentProps<typeof PVSearchModal>>) => (
    <PVSearchModal
      open
      plots={[plot1]}
      initialPlotId="plot-1"
      onAdd={onAdd}
      onClose={onClose}
      {...props}
      {...next}
    />
  );
  const view = render(element({}));
  const rerender = (next: Partial<ComponentProps<typeof PVSearchModal>>) =>
    view.rerender(element(next));
  return { onAdd, onClose, rerender };
}

async function typePattern(text: string) {
  fireEvent.change(screen.getByLabelText('Pattern'), { target: { value: text } });
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
}

async function resolveSearch(index: number, pvs: string[]) {
  await act(async () => searchCalls[index].resolve(pvs));
}

function tick(pv: string) {
  fireEvent.click(screen.getByLabelText(pv));
}

// The names as listed, without the "on plot" tag text.
const listed = () =>
  screen.getAllByRole('listitem').map((li) => li.querySelector('label')?.textContent);

const addButton = () => screen.getByRole('button', { name: /^Add/ }) as HTMLButtonElement;

// jsdom lacks the layout APIs Carbon calls: the modal measures itself on
// mount, and the Dropdown scrolls its highlighted item into view.
Element.prototype.scrollIntoView = () => {};
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

beforeEach(() => {
  vi.useFakeTimers();
  searchCalls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

afterAll(() => vi.unstubAllGlobals());

describe('PVSearchModal', () => {
  it("searches the target plot's archiver with the bulk limit and lists the matches", async () => {
    renderModal();
    // Nothing to tick until there are matches: no list, no select-all.
    expect(screen.queryByRole('checkbox')).toBeNull();
    await typePattern('KLYS');
    expect(searchCalls[0].pattern).toBe('.*(?:KLYS).*');
    expect(searchCalls[0].options).toEqual({ archiver: 'lcls', limit: PV_SEARCH_LIMIT });

    await resolveSearch(0, ['KLYS:A', 'KLYS:B', 'KLYS:C']);
    // The status line is a live region, so the count is announced.
    expect(screen.getByRole('status').textContent).toBe('3 matches');
    expect(listed()).toEqual(['KLYS:A', 'KLYS:B', 'KLYS:C']);
  });

  it('lists matches alphabetically, with numbers in numeric order', async () => {
    renderModal();
    await typePattern('KLYS');
    await resolveSearch(0, ['KLYS:A', 'KLYS:11', 'KLYS:2']);
    expect(listed()).toEqual(['KLYS:2', 'KLYS:11', 'KLYS:A']);

    await typePattern('NOPE');
    await resolveSearch(1, []);
    expect(screen.getByText('0 matches')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('adds the ticked matches in the order ticked', async () => {
    const { onAdd, onClose } = renderModal();
    await typePattern('KLYS');
    await resolveSearch(0, ['KLYS:A', 'KLYS:B', 'KLYS:C']);
    expect(addButton().textContent).toContain('Add PVs');
    expect(addButton().disabled).toBe(true);

    tick('KLYS:C');
    tick('KLYS:A');
    expect(addButton().textContent).toContain('Add 2 PVs');
    fireEvent.click(addButton());

    expect(onAdd).toHaveBeenCalledWith('plot-1', ['KLYS:C', 'KLYS:A']);
    // Closing is the parent's call, after it has added the traces.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ticks and unticks the listed matches from Select all, leaving earlier ticks alone', async () => {
    const { onAdd } = renderModal();
    await typePattern('ROOM');
    await resolveSearch(0, ['ROOM:X']);
    tick('ROOM:X');

    await typePattern('KLYS');
    await resolveSearch(1, ['KLYS:A', 'KLYS:B']);
    fireEvent.click(screen.getByLabelText('Select all'));
    expect(addButton().textContent).toContain('Add 3 PVs');
    fireEvent.click(screen.getByLabelText('Select all'));
    expect(addButton().textContent).toContain('Add 1 PV');

    fireEvent.click(screen.getByLabelText('Select all'));
    fireEvent.click(addButton());
    expect(onAdd).toHaveBeenCalledWith('plot-1', ['ROOM:X', 'KLYS:A', 'KLYS:B']);
  });

  it('adds the selection together with the double-clicked match', async () => {
    const { onAdd } = renderModal();
    // A selected name also shows in the strip, so target the row's checkbox.
    await typePattern('KLYS');
    await resolveSearch(0, ['KLYS:A', 'KLYS:B']);

    fireEvent.doubleClick(screen.getByLabelText('KLYS:B'));
    expect(onAdd).toHaveBeenLastCalledWith('plot-1', ['KLYS:B']);

    tick('KLYS:A');
    fireEvent.doubleClick(screen.getByLabelText('KLYS:B'));
    expect(onAdd).toHaveBeenLastCalledWith('plot-1', ['KLYS:A', 'KLYS:B']);
    // Already selected: no duplicate.
    fireEvent.doubleClick(screen.getByLabelText('KLYS:A'));
    expect(onAdd).toHaveBeenLastCalledWith('plot-1', ['KLYS:A']);
  });

  it('marks PVs already on the target plot', async () => {
    renderModal();
    await typePattern('KLYS');
    await resolveSearch(0, ['KLYS:A', 'KLYS:B']);

    expect(screen.getAllByText('on plot')).toHaveLength(1);
    expect(screen.getByText('KLYS:B').closest('li')?.textContent).toContain('on plot');
    expect(screen.getByText('KLYS:A').closest('li')?.textContent).not.toContain('on plot');
  });

  it('keeps ticks across searches in the Selected strip, with remove and clear', async () => {
    const { onAdd } = renderModal();
    expect(screen.queryByText(/^Selected/)).toBeNull();
    await typePattern('KLYS');
    await resolveSearch(0, ['KLYS:A', 'KLYS:B']);
    tick('KLYS:A');
    tick('KLYS:B');

    await typePattern('ROOM');
    await resolveSearch(1, ['ROOM:X']);
    expect(screen.getByText('Selected (2)')).toBeTruthy();
    expect(addButton().textContent).toContain('Add 2 PVs');

    fireEvent.click(screen.getByRole('button', { name: 'Remove KLYS:A' }));
    expect(addButton().textContent).toContain('Add 1 PV');
    fireEvent.click(addButton());
    expect(onAdd).toHaveBeenCalledWith('plot-1', ['KLYS:B']);

    // Back on the first pattern the surviving tick shows in the list again.
    await typePattern('KLYS');
    await resolveSearch(2, ['KLYS:A', 'KLYS:B']);
    expect((screen.getByLabelText('KLYS:B') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('KLYS:A') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(addButton().disabled).toBe(true);
    expect(screen.queryByText(/^Selected/)).toBeNull();
  });

  it('reports a failed search and says when the list is cut off', async () => {
    renderModal();
    await typePattern('KLYS');
    await act(async () => searchCalls[0].reject(new Error('archiver unreachable')));
    expect(screen.getByText('Search failed: archiver unreachable')).toBeTruthy();

    await typePattern('KLYS:');
    await resolveSearch(
      1,
      Array.from({ length: PV_SEARCH_LIMIT }, (_, i) => `KLYS:${i}`)
    );
    expect(screen.getByText(/Showing the first 500 matches/)).toBeTruthy();
  });

  it('offers a target picker only with several plots and adds to the chosen one', async () => {
    const { onAdd } = renderModal({ plots: [plot1, plot2] });
    expect(screen.getByText('Add to Plot 1')).toBeTruthy();

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'Plot 2' }));
    expect(screen.getByText('Add to Plot 2')).toBeTruthy();

    await typePattern('KLYS');
    expect(searchCalls[0].options.archiver).toBe('facet');
    await resolveSearch(0, ['KLYS:A']);
    tick('KLYS:A');
    fireEvent.click(addButton());
    expect(onAdd).toHaveBeenCalledWith('plot-2', ['KLYS:A']);
  });

  it("drops the matches and ticks, but keeps the pattern, when the new target's archiver differs", async () => {
    const { onAdd } = renderModal({ plots: [plot1, plot2] });
    await typePattern('KLYS');
    await resolveSearch(0, ['KLYS:A', 'KLYS:B']);
    tick('KLYS:A');

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'Plot 2' }));
    expect(screen.queryByText('KLYS:A')).toBeNull();
    expect(addButton().disabled).toBe(true);
    expect((screen.getByLabelText('Pattern') as HTMLInputElement).value).toBe('KLYS');

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(searchCalls[1].options.archiver).toBe('facet');
    await resolveSearch(1, ['KLYS:A', 'KLYS:F']);
    // KLYS:A exists on both archivers, but the earlier tick is gone.
    expect(addButton().disabled).toBe(true);
    tick('KLYS:F');
    fireEvent.click(addButton());
    expect(onAdd).toHaveBeenCalledWith('plot-2', ['KLYS:F']);
  });

  it('drops the ticks when the target plot itself moves to another archiver', async () => {
    const { onAdd, rerender } = renderModal();
    await typePattern('KLYS');
    await resolveSearch(0, ['KLYS:A', 'KLYS:B']);
    tick('KLYS:A');
    expect(addButton().textContent).toContain('Add 1 PV');

    rerender({ plots: [makePlot('plot-1', 'Plot 1', { archiver: 'facet' })] });
    expect(addButton().disabled).toBe(true);
    expect(screen.queryByText(/^Selected/)).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await resolveSearch(1, ['KLYS:A']);
    expect((screen.getByLabelText('KLYS:A') as HTMLInputElement).checked).toBe(false);
    tick('KLYS:A');
    fireEvent.click(addButton());
    expect(onAdd).toHaveBeenCalledWith('plot-1', ['KLYS:A']);
  });

  it("keeps the matches and ticks when the new target's archiver is the same", async () => {
    const { onAdd } = renderModal({ plots: [plot1, plot3] });
    await typePattern('KLYS');
    await resolveSearch(0, ['KLYS:A', 'KLYS:B']);
    tick('KLYS:A');

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'Plot 3' }));
    expect(searchCalls).toHaveLength(1);
    expect(addButton().textContent).toContain('Add 1 PV');
    // The "on plot" marks follow the target: plot 3 has nothing on it.
    expect(screen.queryByText('on plot')).toBeNull();
    fireEvent.click(addButton());
    expect(onAdd).toHaveBeenCalledWith('plot-3', ['KLYS:A']);
  });

  it('has no target picker with a single plot', () => {
    renderModal();
    expect(screen.queryByText('Add to plot')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('closes on Cancel without adding', () => {
    const { onAdd, onClose } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
  });
});
