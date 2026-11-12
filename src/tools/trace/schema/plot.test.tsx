// @vitest-environment jsdom
//
// Trace's tool-level schema rendered through the properties panel: the
// plot-wide sections in order with their summaries, every field in its section
// and at its level, fields bind to the active plot, the dots and resets come from `trace-dot-adapters`, and the
// chart source is the plot's fragment.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';

vi.mock('@slaclab/canopy-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@slaclab/canopy-client')>();
  return {
    ...actual,
    listArchivers: vi.fn(async () => ({
      default: 'main-archiver',
      archivers: [{ name: 'arch-a', healthy: true }],
    })),
  };
});

import { drawingThemeFor } from '../../../annotationTheme';
import { DEFAULT_PALETTE_ID, PALETTES, colorForIndex, getPalette } from '../../../palettes';
import type { Plot, PVTrace } from '../../../types';
import { PanelHarness } from '../../../workbench/__fixtures__/PanelHarness';
import { SelectionProvider, createSelectionStore } from '../../../workbench/selection';
import type { ToolDefinition } from '../../../workbench/types';
import { plotCodeFragment } from '../codeFragments';
import type { TraceDotState } from '../dots';
import { plotMetrics } from '../metrics';
import { plotSchema, timeRangeSummary, type TracePlotModel } from './plot';
import { WithCanopy } from '../../../test/canopy';

// ---------------------------------------------------------------- fixture --

function trace(id: string, color: string): PVTrace {
  return {
    id,
    pvName: `PV:${id}`,
    displayName: '',
    color,
    axisId: 'ax1',
    visible: true,
    useLive: true,
    useArchive: true,
  } as PVTrace;
}

function plot(id: string, index: number, extra: Partial<Plot> = {}): Plot {
  return {
    id,
    title: `Plot ${index + 1}`,
    traces: [],
    axes: [
      {
        id: `${id}-ax1`,
        name: 'Y-Axis 1',
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
    autoScroll: true,
    ...extra,
  };
}

const model: TracePlotModel = {
  palette: getPalette(DEFAULT_PALETTE_ID),
  fragmentInput: (p) => ({
    plot: p,
    archiveResults: new Map(),
    liveResults: new Map(),
    formulaResults: new Map(),
    theme: drawingThemeFor('light'),
  }),
};

function createStore(initial: TraceDotState) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    update: (fn: (s: TraceDotState) => TraceDotState) => {
      state = fn(state);
      for (const l of listeners) l();
    },
  };
}
type Store = ReturnType<typeof createStore>;

const definition: ToolDefinition<TraceDotState, TracePlotModel> = {
  schema: { tool: plotSchema, sections: {}, items: {} },
  binding: {
    outline: () => ({ sections: [] }),
    ops: { add: async () => undefined, remove: () => {}, move: () => {} },
    moveRefusal: () => null,
  },
};

function Harness({ store }: { store: Store }) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  return (
    <PanelHarness
      definition={definition}
      state={state}
      model={model}
      ui={{}}
      update={store.update}
      capabilities={{ elog: false }}
      toolId="trace"
    />
  );
}

function mount(plots: Plot[] = [plot('p1', 0), plot('p2', 1)], activePlotId = 'p1'): Store {
  const store = createStore({ plots, activePlotId });
  render(
    <SelectionProvider store={createSelectionStore({ initial: null })}>
      <Harness store={store} />
    </SelectionProvider>,
    { wrapper: WithCanopy }
  );
  return store;
}

const byId = (id: string) => document.getElementById(id);
const fieldEl = (id: string) => document.querySelector<HTMLElement>(`[data-field="${id}"]`);
const plotOf = (store: Store, id: string) => store.get().plots.find((p) => p.id === id)!;
const section = (id: string) =>
  document.querySelector<HTMLElement>(`.wb-plot-section[data-section="${id}"]`)!;
const summaryOf = (id: string) =>
  section(id).querySelector('.wb-plot-section__summary')?.textContent ?? '';
const fieldsIn = (id: string) =>
  [...section(id).querySelectorAll<HTMLElement>('[data-field]')].map((el) => el.dataset.field);
const openMore = (id: string) =>
  fireEvent.click(within(section(id)).getByRole('button', { name: 'More' }));
const dot = (label: string) => screen.queryByRole('img', { name: `${label} modified` });
const typeInto = (id: string, text: string) =>
  fireEvent.change(byId(id) as HTMLInputElement, { target: { value: text } });

afterEach(() => {
  cleanup();
});

// ------------------------------------------------------------------ tests --

describe('plot schema — sections, levels, summaries', () => {
  it('shows Acquisition, Axes, Display and Statistics in that order, then the chart source', () => {
    mount();
    const sections = [...document.querySelectorAll<HTMLElement>('.wb-plot-section')].map(
      (s) => s.dataset.section
    );
    expect(sections).toEqual(['acquisition', 'axes', 'display', 'statistics']);
    expect(screen.getByRole('button', { name: 'Hide chart source' })).not.toBeNull();
  });

  it('summarises each section from the active plot', () => {
    const store = mount();
    expect(summaryOf('acquisition')).toBe('refresh 5 s');
    expect(summaryOf('axes')).toBe('last 1 h · 1 Y axis');
    expect(summaryOf('display')).toBe('legend · grid · crosshair · tooltip');
    expect(summaryOf('statistics')).toBe('off');
    act(() =>
      store.update((s) => ({
        ...s,
        plots: s.plots.map((p) =>
          p.id === 'p1'
            ? {
                ...p,
                autoScroll: false,
                showCrosshair: false,
                showXGridlines: false,
                showYGridlines: false,
                showStats: true,
                axes: [...p.axes, { ...p.axes[0], id: 'p1-ax2' }],
                xAxis: { timeRange: '-90m' },
              }
            : p
        ),
      }))
    );
    expect(summaryOf('acquisition')).toBe('no refresh');
    expect(summaryOf('axes')).toBe('last 90 min · 2 Y axes');
    expect(summaryOf('display')).toBe('legend · tooltip');
    expect(summaryOf('statistics')).toBe(`on · ${plotMetrics({}).length} metrics`);
  });

  it('words a time range for the summary', () => {
    expect(timeRangeSummary('-30s')).toBe('last 30 s');
    expect(timeRangeSummary('-1d')).toBe('last 1 d');
    expect(timeRangeSummary('-1.5h')).toBe('last 1.5 h');
    expect(timeRangeSummary('-1M')).toBe('last 1 mo');
    expect(timeRangeSummary('custom')).toBe('custom range');
  });

  it('puts Refresh interval and Default archiver at L1 in Acquisition', () => {
    mount();
    expect(fieldsIn('acquisition')).toEqual(['refresh-interval', 'default-archiver']);
    for (const id of ['refresh-interval', 'default-archiver']) {
      expect(fieldEl(id)?.getAttribute('data-level')).toBe('L1');
      expect(byId(id)).not.toBeNull();
    }
  });

  it('puts Time range and Autoscroll under an X axis sub-heading in Axes', () => {
    mount();
    expect(fieldsIn('axes')).toEqual(['time-range', 'autoscroll']);
    for (const id of ['time-range', 'autoscroll']) {
      expect(fieldEl(id)?.getAttribute('data-level')).toBe('L1');
    }
    const headings = [...section('axes').querySelectorAll('.wb-block__subheading')].map(
      (h) => h.textContent
    );
    expect(headings).toEqual(['X axis']);
  });

  it('orders Display: Title, Legend … Data tooltip at L1, then Mouse drag, Status line, Pin data window', () => {
    mount();
    const main = [
      'plot-title',
      'show-legend',
      'show-legend-value',
      'show-x-gridlines',
      'show-y-gridlines',
      'show-crosshair',
      'show-tooltip',
    ];
    const second = ['drag-mode', 'show-status-line', 'pin-data-window'];
    expect(fieldsIn('display')).toEqual([...main, ...second]);
    for (const id of main) expect(fieldEl(id)?.getAttribute('data-level')).toBe('L1');
    for (const id of second) expect(fieldEl(id)?.getAttribute('data-level')).toBe('L2');
    expect(fieldEl('show-tooltip')?.textContent).toContain('Data tooltip');
    expect(fieldEl('drag-mode')?.textContent).toContain('Mouse drag');
  });

  it('puts Grid style, Grid opacity, Tick font size, Background and Palette under More in Display', () => {
    mount();
    const more = [
      'grid-style',
      'grid-opacity',
      'tick-font-size',
      'plot-background',
      'plot-palette',
    ];
    for (const id of more) expect(fieldEl(id)).toBeNull();
    openMore('display');
    for (const id of more) {
      expect(fieldEl(id)?.getAttribute('data-level')).toBe('L3');
      expect(fieldEl(id)?.closest('.wb-block__more-body')).not.toBeNull();
    }
    expect(screen.getByTestId('trace-color-swatch')).not.toBeNull();
  });
});

describe('plot schema — binding', () => {
  it('edits the active plot title; the stamped dot lights and reset writes Plot <n>', () => {
    const store = mount([plot('p1', 0), plot('p2', 1)], 'p2');
    expect(dot('Title')).toBeNull();
    typeInto('plot-title', 'Magnets');
    expect(plotOf(store, 'p2').title).toBe('Magnets');
    expect(plotOf(store, 'p1').title).toBe('Plot 1');
    expect(dot('Title')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Title' }));
    expect(plotOf(store, 'p2').title).toBe('Plot 2');
    expect(dot('Title')).toBeNull();
  });

  it('follows a plot switch', () => {
    const store = mount();
    typeInto('plot-title', 'Beam current');
    expect((byId('plot-title') as HTMLInputElement).value).toBe('Beam current');
    act(() => store.update((s) => ({ ...s, activePlotId: 'p2' })));
    expect((byId('plot-title') as HTMLInputElement).value).toBe('Plot 2');
  });
});

describe('plot schema — Statistics', () => {
  it('stores Show statistics and the metric list only off their defaults', () => {
    const store = mount();
    expect(plotOf(store, 'p1').showStats).toBeUndefined();
    fireEvent.click(byId('stats-show')!);
    expect(plotOf(store, 'p1').showStats).toBe(true);
    fireEvent.click(byId('stats-show')!);
    expect(plotOf(store, 'p1').showStats).toBeUndefined();
    expect((byId('metrics-reset') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Strip chart for mean' }));
    expect(plotOf(store, 'p1').metrics?.find((m) => m.id === 'mean')?.strip).toBe(true);
    expect(plotOf(store, 'p2').metrics).toBeUndefined();
    fireEvent.click(byId('metrics-reset')!);
    expect(plotOf(store, 'p1').metrics).toBeUndefined();
  });
});

describe('plot schema — Axes (X axis)', () => {
  it('picks a time range preset into xAxis (range=)', () => {
    const store = mount();
    fireEvent.change(byId('time-range') as HTMLSelectElement, { target: { value: '-1d' } });
    expect(plotOf(store, 'p1').xAxis.timeRange).toBe('-1d');
    expect((byId('time-span') as HTMLInputElement).value).toBe('1d');
  });

  it('commits a free-text span on Enter and rejects a bad one', () => {
    const store = mount();
    typeInto('time-span', '90m');
    fireEvent.keyDown(byId('time-span') as HTMLInputElement, { key: 'Enter' });
    expect(plotOf(store, 'p1').xAxis.timeRange).toBe('-90m');
    // A non-preset span gets its own option, so the Select shows it.
    expect((byId('time-range') as HTMLSelectElement).value).toBe('-90m');

    typeInto('time-span', 'soon');
    fireEvent.blur(byId('time-span') as HTMLInputElement);
    expect(
      screen.getByText('Use a number plus s, m, h, d, w, or M (e.g. 30s, 90m, 1.5h, 2w).')
    ).not.toBeNull();
    expect(plotOf(store, 'p1').xAxis.timeRange).toBe('-90m');
  });

  it('shows From/To and the resolver error for a custom range, and hides Autoscroll and Refresh interval', () => {
    const store = mount();
    fireEvent.change(byId('time-range') as HTMLSelectElement, { target: { value: 'custom' } });
    expect(byId('time-span')).toBeNull();
    expect(fieldEl('autoscroll')).toBeNull();
    const rangeError = () => document.querySelector('.trace-time-range__error');
    expect(rangeError()?.textContent).toBe('Enter a valid "From" date and time.');
    typeInto('time-from', '2026-01-01T00:00');
    typeInto('time-to', '2026-01-02T00:00');
    expect(plotOf(store, 'p1').xAxis).toEqual({
      timeRange: 'custom',
      timeFrom: '2026-01-01T00:00',
      timeTo: '2026-01-02T00:00',
    });
    expect(rangeError()).toBeNull();
    expect(fieldEl('refresh-interval')).toBeNull();
    expect(summaryOf('axes')).toBe('custom range · 1 Y axis');
  });

  it('toggles Autoscroll (session state, no dot); undefined reads as on', () => {
    const store = mount([plot('p1', 0, { autoScroll: undefined })]);
    const toggle = byId('autoscroll') as HTMLElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(plotOf(store, 'p1').autoScroll).toBe(false);
    expect(dot('Autoscroll (track now)')).toBeNull();
  });
});

describe('plot schema — Acquisition', () => {
  it('Refresh interval says what it controls when the span allows it', () => {
    mount([plot('p1', 0, { refreshIntervalS: 60 })]);
    expect(
      within(fieldEl('refresh-interval')!).getByText(
        'How often archive and formula data refresh. The axis scrolls continuously.'
      )
    ).not.toBeNull();
    expect(fieldEl('refresh-cap')).toBeNull();
  });

  it('gives the capped interval on a short span and keeps the one the user set', () => {
    mount([plot('p1', 0, { xAxis: { timeRange: '-30s' }, refreshIntervalS: 60 })]);
    expect(fieldsIn('acquisition')).toEqual([
      'refresh-interval',
      'refresh-cap',
      'default-archiver',
    ]);
    expect(fieldEl('refresh-cap')?.textContent).toMatch(/refresh every 5 s at this span/);
    expect((byId('refresh-interval') as HTMLInputElement).value).toBe('60');
    expect(summaryOf('acquisition')).toBe('refresh 5 s');
  });

  it('shows no capped interval with Autoscroll off', () => {
    mount([
      plot('p1', 0, { xAxis: { timeRange: '-30s' }, refreshIntervalS: 60, autoScroll: false }),
    ]);
    expect(fieldEl('refresh-cap')).toBeNull();
  });

  it('Default archiver shows its optional-path dot and reset clears it', async () => {
    const store = mount([plot('p1', 0, { archiver: 'arch-a' })]);
    expect(dot('Default archiver')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Default archiver' }));
    expect(plotOf(store, 'p1').archiver).toBeUndefined();
    expect(dot('Default archiver')).toBeNull();
    await act(async () => {});
  });

  it('Refresh interval writes within bounds, dots, resets, and disables with Autoscroll off', async () => {
    const store = mount();
    const input = byId('refresh-interval') as HTMLInputElement;
    expect(input.value).toBe('5');
    expect(dot('Refresh interval')).toBeNull();
    typeInto('refresh-interval', '12');
    expect(plotOf(store, 'p1').refreshIntervalS).toBe(12);
    expect(dot('Refresh interval')).not.toBeNull();
    expect(summaryOf('acquisition')).toBe('refresh 12 s');
    typeInto('refresh-interval', '600');
    expect(plotOf(store, 'p1').refreshIntervalS).toBe(12);
    fireEvent.click(screen.getByRole('button', { name: 'Reset Refresh interval' }));
    expect(plotOf(store, 'p1').refreshIntervalS).toBeUndefined();

    act(() =>
      store.update((s) => ({
        ...s,
        plots: s.plots.map((p) => ({ ...p, autoScroll: false })),
      }))
    );
    expect((byId('refresh-interval') as HTMLInputElement).disabled).toBe(true);
    expect(fieldEl('refresh-interval')?.textContent).toContain('Autoscroll is off');
    await act(async () => {});
  });
});

describe('plot schema — Display', () => {
  it('toggles the flags of the active plot with no dot', () => {
    const store = mount([plot('p1', 0), plot('p2', 1)], 'p2');
    const flags = {
      'show-legend': 'showLegend',
      'show-x-gridlines': 'showXGridlines',
      'show-y-gridlines': 'showYGridlines',
      'show-crosshair': 'showCrosshair',
    } as const;
    for (const [id, key] of Object.entries(flags)) {
      fireEvent.click(byId(id) as HTMLElement);
      expect(plotOf(store, 'p2')[key]).toBe(false);
      expect(plotOf(store, 'p1')[key]).toBe(true);
    }
    for (const label of ['Legend', 'X gridlines', 'Y gridlines', 'Crosshair']) {
      expect(dot(label)).toBeNull();
    }
  });

  it('Mouse drag is a Zoom box / Pan choice: zoom by default, only pan is stored', () => {
    const store = mount();
    const group = byId('drag-mode') as HTMLElement;
    expect(group.getAttribute('role')).toBe('radiogroup');
    const option = (name: string) => within(group).getByRole('radio', { name });
    expect(option('Zoom box').getAttribute('aria-checked')).toBe('true');
    expect(dot('Mouse drag')).toBeNull();
    fireEvent.click(option('Pan'));
    expect(plotOf(store, 'p1').dragMode).toBe('pan');
    expect(dot('Mouse drag')).not.toBeNull();
    fireEvent.click(option('Zoom box'));
    expect(plotOf(store, 'p1').dragMode).toBeUndefined();
    expect(dot('Mouse drag')).toBeNull();
  });

  it('reads a stored zoom as the default choice', () => {
    mount([plot('p1', 0, { dragMode: 'zoom' })]);
    const group = byId('drag-mode') as HTMLElement;
    expect(
      within(group).getByRole('radio', { name: 'Zoom box' }).getAttribute('aria-checked')
    ).toBe('true');
  });

  it('sets grid style and grid opacity (percent shown, 0..1 stored)', () => {
    const store = mount();
    openMore('display');
    fireEvent.change(byId('grid-style') as HTMLSelectElement, { target: { value: 'dashed' } });
    expect(plotOf(store, 'p1').gridStyle).toBe('dashed');
    expect((byId('grid-opacity') as HTMLInputElement).value).toBe('100');
    typeInto('grid-opacity', '40');
    expect(plotOf(store, 'p1').gridOpacity).toBeCloseTo(0.4);
    expect(dot('Grid style')).toBeNull();
    expect(dot('Grid opacity')).toBeNull();
  });

  it('Tick font size writes within 6..48 and has no dot', async () => {
    const store = mount();
    openMore('display');
    typeInto('tick-font-size', '14');
    expect(plotOf(store, 'p1').tickFontSize).toBe(14);
    typeInto('tick-font-size', '99');
    expect(plotOf(store, 'p1').tickFontSize).toBe(14);
    expect(dot('Tick font size')).toBeNull();
    await act(async () => {});
  });

  it('Palette writes the bound plot: recolours palette curves by slot, dots, resets', () => {
    const def = getPalette(DEFAULT_PALETTE_ID);
    const other = PALETTES.find((p) => p.id !== DEFAULT_PALETTE_ID)!;
    const store = mount([
      plot('p1', 0, {
        traces: [trace('a', colorForIndex(def, 1)), trace('b', '#123456')],
      }),
      plot('p2', 1, { traces: [trace('c', colorForIndex(def, 0))] }),
    ]);
    openMore('display');
    expect((byId('plot-palette') as HTMLSelectElement).value).toBe(DEFAULT_PALETTE_ID);
    expect(dot('Palette')).toBeNull();
    expect(screen.queryByRole('button', { name: /Apply to/ })).toBeNull();
    fireEvent.change(byId('plot-palette') as HTMLSelectElement, { target: { value: other.id } });
    expect(plotOf(store, 'p1').palette).toBe(other.id);
    expect((byId('plot-palette') as HTMLSelectElement).value).toBe(other.id);
    expect(dot('Palette')).not.toBeNull();
    // Slot 1 stays slot 1; a user-set colour stays; the other plot is untouched.
    expect(plotOf(store, 'p1').traces.map((t) => t.color)).toEqual([
      colorForIndex(other, 1),
      '#123456',
    ]);
    expect(plotOf(store, 'p2').palette).toBeUndefined();
    expect(plotOf(store, 'p2').traces[0].color).toBe(colorForIndex(def, 0));
    fireEvent.click(screen.getByRole('button', { name: 'Reset Palette' }));
    expect(plotOf(store, 'p1').palette).toBeUndefined();
    expect(plotOf(store, 'p1').traces.map((t) => t.color)).toEqual([
      colorForIndex(def, 1),
      '#123456',
    ]);
    expect(dot('Palette')).toBeNull();
  });
});

describe('plot schema — chart source', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prints the active plot fragment and follows edits', () => {
    // The x-axis window is anchored to now: freeze the clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    const store = mount([plot('p1', 0), plot('p2', 1, { backgroundColor: '#0a0b0c' })], 'p2');
    const code = () => byId('plot-code')?.textContent;
    expect(code()).toBe(plotCodeFragment(model.fragmentInput(plotOf(store, 'p2'))));
    expect(code()).toContain('#0a0b0c');
    act(() =>
      store.update((s) => ({
        ...s,
        plots: s.plots.map((p) => (p.id === 'p2' ? { ...p, showLegend: false } : p)),
      }))
    );
    expect(code()).toBe(plotCodeFragment(model.fragmentInput(plotOf(store, 'p2'))));
  });
});
