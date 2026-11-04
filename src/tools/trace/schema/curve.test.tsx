// @vitest-environment jsdom
//
// Trace's PV-curve item schema, rendered as an open card of the properties
// panel:
// - Signal, Style and Data blocks, each within the L1 budget; Live/Archive
//   status sit in the Status group, outside it;
// - the PV name commits through `#pv-name` and a changed PV re-assigns the
//   curve to its unit's axis (a re-commit of the same PV does not);
// - Data's More shows Live retention only with Live on, and Archiver, Min/max
//   band and Optimized bins only with Archive on;
// - Colour is the card swatch (`trace-color-swatch` in the body) with a
//   stamped dot, Visible the card eye;
// - Style edits, and the actions;
// - curves carry no `updateRate`: new curves, `plot=` and the .trc conversion
//   never write it, while older views and files that still carry it parse.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { drawingThemeFor } from '../../../annotationTheme';
import {
  TRACE_DEFAULTS,
  applyPlotConfig,
  newFormula,
  newTrace,
  parsePlotConfig,
  plotConfigOf,
} from '../../../embed/plotConfig';
import type { ArchiveSeriesResult } from '../../../hooks/useArchiveSeries';
import type { LiveSeriesResult } from '../../../hooks/useLiveSeries';
import { deserializeWorkspace } from '../../../io/serialize';
import { DEFAULT_PALETTE_ID, colorForIndex, getPalette } from '../../../palettes';
import type { Axis, Plot, PVTrace } from '../../../types';
import { PanelHarness } from '../../../workbench/__fixtures__/PanelHarness';
import { SelectionProvider, createSelectionStore } from '../../../workbench/selection';
import type { Capabilities, ToolDefinition, ToolUi } from '../../../workbench/types';
import type { TraceFragmentInput } from '../codeFragments';
import type { TraceDotState } from '../dots';
import {
  NO_PV_REASON,
  PV_CURVE_ITEM_KIND,
  archiveStatusLabel,
  assignCurveToUnitAxis,
  liveStatusLabel,
  pvCurveSchema,
  type TraceCurveModel,
} from './curve';
import { WithCanopy } from '../../../test/canopy';

const fetchMetadata = vi.hoisted(() =>
  vi.fn(
    async (
      ...args: [pv: string, archiver?: string, signal?: AbortSignal]
    ): Promise<{ units?: string; args: typeof args }> => ({ units: 'mA', args })
  )
);

// The SDK calls take the connection first; the mocks see the rest.
vi.mock('@slaclab/canopy-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@slaclab/canopy-client')>();
  return {
    ...actual,
    fetchMetadata: (_conn: unknown, ...args: Parameters<typeof fetchMetadata>) =>
      fetchMetadata(...args),
    listArchivers: vi.fn(async () => ({
      default: 'main-archiver',
      archivers: [{ name: 'arch-a', healthy: true }],
    })),
  };
});

vi.mock('../../../pvSearch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../pvSearch')>();
  return { ...actual, moleSearch: () => async () => [] as string[] };
});

type State = TraceDotState;
type Model = TraceCurveModel;

const PALETTE = getPalette(DEFAULT_PALETTE_ID);

function makeAxis(overrides: Partial<Axis> = {}): Axis {
  return {
    id: 'ax1',
    name: 'Y-Axis 1',
    orientation: 'left',
    autoScale: true,
    logScale: false,
    visible: true,
    ...overrides,
  };
}

function makeTrace(overrides: Partial<PVTrace> = {}): PVTrace {
  return {
    id: 't1',
    pvName: 'TEST:CURRENT',
    displayName: '',
    color: colorForIndex(PALETTE, 0),
    visible: true,
    axisId: 'ax1',
    useLive: true,
    useArchive: true,
    lineWidth: 2,
    lineType: 'step',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'circle',
    symbolSize: 10,
    data: [],
    ...overrides,
  };
}

function makePlot(axes: Axis[], traces: PVTrace[], id = 'p1'): Plot {
  return {
    id,
    title: 'Plot 1',
    traces,
    axes,
    backgroundColor: '#161616',
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
  };
}

let liveResults = new Map<string, LiveSeriesResult>();
let archiveResults = new Map<string, ArchiveSeriesResult>();

function fragmentInput(plot: Plot): TraceFragmentInput {
  return {
    plot,
    archiveResults,
    liveResults,
    formulaResults: new Map(),
    theme: drawingThemeFor('light'),
  };
}

const inspect = vi.fn();
const createFormula = vi.fn();
const MODEL: Model = { palette: PALETTE, fragmentInput, inspect, createFormula };

const definition: ToolDefinition<State, Model, ToolUi> = {
  schema: {
    tool: { tabs: [] },
    sections: { axis: { tabs: [] } },
    items: { [PV_CURVE_ITEM_KIND]: pvCurveSchema },
  },
  binding: {
    outline: (state) => {
      const plot = state.plots.find((p) => p.id === state.activePlotId) ?? state.plots[0];
      return {
        sections: (plot?.axes ?? []).map((a) => {
          const rows = plot!.traces.filter((t) => t.axisId === a.id);
          return {
            id: a.id,
            kind: 'axis',
            title: a.name,
            count: rows.length,
            rows: rows.map((t) => ({
              id: t.id,
              kind: PV_CURVE_ITEM_KIND,
              label: t.displayName || t.pvName,
              status: 'ok' as const,
            })),
          };
        }),
      };
    },
    ops: { add: async () => undefined, remove: () => {}, move: () => {} },
    moveRefusal: () => null,
  },
};

function createStore(initial: State) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(fn: (s: State) => State) {
      state = fn(state);
      listeners.forEach((l) => l());
    },
  };
}

type Store = ReturnType<typeof createStore>;

function Harness({ store, capabilities }: { store: Store; capabilities: Capabilities }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return (
    <PanelHarness
      definition={definition}
      state={state}
      model={MODEL}
      ui={{}}
      update={store.update}
      capabilities={capabilities}
      toolId="trace"
    />
  );
}

function mount(
  traces: PVTrace[] = [makeTrace()],
  {
    axes = [makeAxis()],
    capabilities = { elog: true },
    curveId = traces[0].id,
  }: { axes?: Axis[]; capabilities?: Capabilities; curveId?: string } = {}
): Store {
  const store = createStore({ plots: [makePlot(axes, traces)], activePlotId: 'p1' });
  const selection = createSelectionStore({
    initial: { level: 'item', kind: PV_CURVE_ITEM_KIND, id: curveId },
  });
  render(
    <SelectionProvider store={selection}>
      <Harness store={store} capabilities={capabilities} />
    </SelectionProvider>,
    { wrapper: WithCanopy }
  );
  return store;
}

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/** The open card's body (the selected curve). */
function cardBody(): HTMLElement {
  return document.querySelector<HTMLElement>('.wb-card--open .wb-card__body')!;
}

/** The open card's head: swatch, name, eye. */
function cardHead(): HTMLElement {
  return document.querySelector<HTMLElement>('.wb-card--open .wb-card__head')!;
}

function curveIn(store: Store, id = 't1'): PVTrace | undefined {
  return store.getState().plots[0].traces.find((t) => t.id === id);
}

function dot(label: string): HTMLElement | null {
  return screen.queryByRole('img', { name: `${label} modified` });
}

/** Opens the Data block's More disclosure. */
function openMore() {
  const data = cardBody().querySelector<HTMLElement>('.wb-block[data-block="data"]')!;
  fireEvent.click(within(data).getByRole('button', { name: 'More' }));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  liveResults = new Map();
  archiveResults = new Map();
  fetchMetadata.mockClear();
  fetchMetadata.mockImplementation(async (...args) => ({ units: 'mA', args }));
  inspect.mockClear();
  createFormula.mockClear();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {}))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ shape --

const blockFields = (id: string, level?: string) =>
  pvCurveSchema.tabs
    .find((t) => t.id === id)!
    .fields.filter((f) => f.group !== 'status' && (level === undefined || f.level === level))
    .map((f) => f.id);

describe('PV-curve schema — shape', () => {
  it('opens as a card with Signal, Style and Data blocks, and no chart source', () => {
    mount();
    const body = cardBody();
    const blocks = [...body.querySelectorAll<HTMLElement>('.wb-block')].map((b) => b.dataset.block);
    expect(blocks).toEqual(['signal', 'style', 'data']);
    expect([...body.querySelectorAll('.wb-block__heading')].map((h) => h.textContent)).toEqual([
      'Signal',
      'Style',
      'Data',
    ]);
    expect(byId('curve-code')).toBeNull();
  });

  it('Signal holds PV name, Label, Plot on and Visible (the card eye)', () => {
    expect(blockFields('signal', 'L1')).toEqual([
      'pv-name',
      'display-name',
      'y-axis',
      'trace-visible',
    ]);
  });

  it('Style holds seven L1 fields, then Extend to now and Alarm colouring at L2', () => {
    expect(blockFields('style', 'L1')).toEqual([
      'trace-color',
      'line-type',
      'line-width',
      'line-style',
      'show-symbols',
      'symbol-shape',
      'symbol-size',
    ]);
    expect(blockFields('style', 'L2')).toEqual(['extend-to-now', 'alarm-coloring']);
  });

  it('Data holds Live and Archive, the Status group, the actions, and More', () => {
    expect(blockFields('data', 'L1')).toEqual(['use-live', 'use-archive']);
    expect(blockFields('data', 'L2')).toEqual(['inspect-data', 'create-formula']);
    expect(blockFields('data', 'L3')).toEqual([
      'live-retention',
      'curve-archiver',
      'show-archive-band',
      'optimized-bins',
    ]);
    const data = pvCurveSchema.tabs.find((t) => t.id === 'data')!;
    const status = data.fields.filter((f) => f.group === 'status');
    expect(status.map((f) => [f.id, f.kind])).toEqual([
      ['live-status', 'readonly'],
      ['archive-status', 'readonly'],
    ]);
  });

  it('labels the fields with the shared words', () => {
    mount();
    const label = (id: string) =>
      cardBody().querySelector(`[data-field="${id}"] .wb-field__label`)?.textContent ??
      cardBody().querySelector(`[data-field="${id}"]`)?.textContent;
    expect(label('display-name')).toContain('Label');
    expect(label('y-axis')).toContain('Plot on');
    expect(label('line-type')).toContain('Line');
    expect(label('line-width')).toContain('Width');
    expect(label('line-style')).toContain('Dash');
    expect(label('show-symbols')).toContain('Markers');
    expect((byId('display-name') as HTMLInputElement).placeholder).toBe('Follows the PV name');
  });

  it('lists line types as Line, Step and dashes in the shared words', () => {
    mount();
    const options = (id: string) =>
      Array.from((byId(id) as HTMLSelectElement).options).map((o) => [o.value, o.textContent]);
    expect(options('line-type')).toEqual([
      ['direct', 'Line'],
      ['step', 'Step'],
    ]);
    expect(options('line-style')).toEqual([
      ['none', 'None'],
      ['solid', 'Solid'],
      ['dashed', 'Dashed'],
      ['dotted', 'Dotted'],
      ['dashDot', 'Dash-dot'],
      ['dashDotDot', 'Dash-dot-dot'],
    ]);
    expect((byId('line-type') as HTMLSelectElement).value).toBe('step');
  });

  it('renders every field with its hook; Visible is on the card head, Colour carries trace-color-swatch', () => {
    mount();
    for (const id of ['pv-name', 'display-name', 'y-axis', 'use-live', 'use-archive']) {
      expect(byId(id), id).not.toBeNull();
    }
    expect(byId('trace-visible')).toBeNull();
    expect(cardHead().querySelector('.wb-eye')).not.toBeNull();
    expect(byId('trace-color')).toBeNull();
    expect(within(cardBody()).getByTestId('trace-color-swatch')).toBeTruthy();
    expect((byId('pv-name') as HTMLInputElement).value).toBe('TEST:CURRENT');
  });

  it('puts Visible on the row eye and Colour on the row swatch', () => {
    const fields = pvCurveSchema.tabs.flatMap((t) => t.fields);
    const visible = fields.find((f) => f.id === 'trace-visible');
    const colour = fields.find((f) => f.id === 'trace-color');
    expect(visible?.kind === 'toggle' && visible.row).toBe('eye');
    expect(colour?.kind === 'colour' && colour.row).toBe('swatch');
  });

  it('has no Update rate field anywhere', () => {
    const ids = pvCurveSchema.tabs.flatMap((t) => t.fields.map((f) => f.id));
    expect(ids.some((id) => /update.?rate/i.test(id))).toBe(false);
  });
});

// ----------------------------------------------------------------- status --

describe('PV-curve schema — Status group', () => {
  it('shows Live and Archive status from the result maps', () => {
    liveResults.set('t1', {
      status: 'connected',
      connected: true,
      severity: null,
      latest: null,
      error: null,
      points: [],
      breaks: [],
    });
    archiveResults.set('t1', { status: 'ready', mode: 'binned', mean: [], band: [] } as never);
    mount();
    const status = screen.getByRole('region', { name: 'Status' });
    expect(status.querySelector('#live-status')?.textContent).toBe('Connected');
    expect(status.querySelector('#archive-status')?.textContent).toBe('Loaded (binned)');
  });

  it('reads Disabled for a source that is off', () => {
    mount([makeTrace({ useLive: false, useArchive: false })]);
    expect(byId('live-status')?.textContent).toBe('Disabled');
    expect(byId('archive-status')?.textContent).toBe('Disabled');
  });

  it('labels every live and archive state as today', () => {
    const live = (status: LiveSeriesResult['status'], connected = false) =>
      liveStatusLabel({ useLive: true }, { status, connected });
    expect(live('connecting')).toBe('Connecting…');
    expect(live('connected')).toBe('Waiting for value');
    expect(live('idle')).toBe('Disconnected');
    expect(liveStatusLabel({ useLive: true }, undefined)).toBe('Disconnected');
    const on = { useArchive: true };
    expect(archiveStatusLabel(on, undefined)).toBe('Idle');
    expect(archiveStatusLabel(on, { status: 'loading' } as never)).toBe('Loading…');
    expect(
      archiveStatusLabel(on, { status: 'error', error: { code: 'TIMEOUT', detail: '' } } as never)
    ).toBe('TIMEOUT');
    expect(archiveStatusLabel(on, { status: 'error' } as never)).toBe('Error');
    expect(
      archiveStatusLabel(on, {
        status: 'error',
        error: { code: 'pv_not_found_in_archiver', detail: '' },
      } as never)
    ).toBe('Not archived');
    expect(archiveStatusLabel(on, { status: 'ready', mode: 'raw', decimated: true } as never)).toBe(
      'Loaded (raw) · decimated'
    );
  });
});

// ---------------------------------------------------------------- PV name --

describe('PV-curve schema — PV name', () => {
  it('commits a new PV on Enter and re-assigns the curve to a new axis for its unit', async () => {
    const store = mount();
    const input = byId('pv-name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'TEST:NEW' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(curveIn(store)?.pvName).toBe('TEST:NEW');
    await flush();
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    expect(fetchMetadata.mock.calls[0][0]).toBe('TEST:NEW');
    const plot = store.getState().plots[0];
    expect(plot.axes).toHaveLength(2);
    expect(plot.axes[1]).toMatchObject({ name: 'mA', units: 'mA', orientation: 'right' });
    expect(curveIn(store)?.axisId).toBe(plot.axes[1].id);
  });

  it('looks the unit up on the curve archiver, else the plot default', async () => {
    const store = createStore({
      plots: [{ ...makePlot([makeAxis()], [makeTrace()]), archiver: 'plot-arch' }],
      activePlotId: 'p1',
    });
    const selection = createSelectionStore({
      initial: { level: 'item', kind: PV_CURVE_ITEM_KIND, id: 't1' },
    });
    render(
      <SelectionProvider store={selection}>
        <Harness store={store} capabilities={{ elog: true }} />
      </SelectionProvider>,
      { wrapper: WithCanopy }
    );
    const input = byId('pv-name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'TEST:OTHER' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flush();
    expect(fetchMetadata.mock.calls[0][1]).toBe('plot-arch');
  });

  it('does not re-run the lookup when the same PV is committed again', async () => {
    const store = mount();
    const input = byId('pv-name') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Enter' });
    await flush();
    expect(fetchMetadata).not.toHaveBeenCalled();
    expect(curveIn(store)?.pvName).toBe('TEST:CURRENT');
  });

  it('leaves the curve on its axis when the PV has no units', async () => {
    fetchMetadata.mockImplementation(async (...args) => ({ units: undefined, args }));
    const store = mount();
    const input = byId('pv-name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'TEST:NOUNIT' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flush();
    expect(curveIn(store)?.axisId).toBe('ax1');
    expect(store.getState().plots[0].axes).toHaveLength(1);
  });
});

describe('assignCurveToUnitAxis', () => {
  const state = (axes: Axis[], traces = [makeTrace()]): State => ({
    plots: [makePlot([makeAxis({ id: 'other' })], [], 'p0'), makePlot(axes, traces)],
    activePlotId: 'p0',
  });

  it('matches an axis by its recorded units, case-insensitively', () => {
    const next = assignCurveToUnitAxis(
      state([makeAxis(), makeAxis({ id: 'ax2', name: 'Current', units: 'MA' })]),
      't1',
      'mA',
      'ax1',
      'new'
    );
    expect(next.plots[1].traces[0].axisId).toBe('ax2');
    expect(next.plots[1].axes).toHaveLength(2);
  });

  it('matches a parenthesised unit in the name and stamps the units', () => {
    const next = assignCurveToUnitAxis(
      state([makeAxis(), makeAxis({ id: 'ax2', name: 'Vacuum (kV)' })]),
      't1',
      'kV',
      'ax1',
      'new'
    );
    expect(next.plots[1].traces[0].axisId).toBe('ax2');
    expect(next.plots[1].axes[1].units).toBe('kV');
  });

  it('never matches a bare unit inside a longer name', () => {
    const next = assignCurveToUnitAxis(
      state([makeAxis(), makeAxis({ id: 'ax2', name: 'kV' })]),
      't1',
      'V',
      'ax1',
      'new'
    );
    expect(next.plots[1].traces[0].axisId).toBe('new');
    expect(next.plots[1].axes[2]).toMatchObject({ id: 'new', name: 'V', units: 'V' });
  });

  it('respects a manual move made while the lookup ran', () => {
    const before = state([makeAxis(), makeAxis({ id: 'ax2' })], [makeTrace({ axisId: 'ax2' })]);
    expect(assignCurveToUnitAxis(before, 't1', 'mA', 'ax1', 'new')).toBe(before);
  });

  it('finds the curve in a plot that is not the active one', () => {
    const next = assignCurveToUnitAxis(state([makeAxis()]), 't1', 'mA', 'ax1', 'new');
    expect(next.plots[0].axes.map((a) => a.id)).toEqual(['other']);
    expect(next.plots[1].traces[0].axisId).toBe('new');
  });
});

// ---------------------------------------------------------------- general --

describe('PV-curve schema — Signal and Data edits', () => {
  it('writes Label, Plot on, Visible (the card eye), Live and Archive', () => {
    const store = mount([makeTrace()], {
      axes: [makeAxis(), makeAxis({ id: 'ax2', name: 'Second' })],
    });
    fireEvent.change(byId('display-name')!, { target: { value: 'Beam' } });
    expect(curveIn(store)?.displayName).toBe('Beam');

    const select = byId('y-axis') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Y-Axis 1', 'Second']);
    fireEvent.change(select, { target: { value: 'ax2' } });
    expect(curveIn(store)?.axisId).toBe('ax2');

    fireEvent.click(within(cardHead()).getByRole('button', { name: 'Hide visible' }));
    expect(curveIn(store)?.visible).toBe(false);
    fireEvent.click(byId('use-live')!);
    expect(curveIn(store)?.useLive).toBe(false);
    fireEvent.click(byId('use-archive')!);
    expect(curveIn(store)?.useArchive).toBe(false);
  });

  it('dots a pinned Colour and resets it to the palette colour at its position', () => {
    const store = mount(
      [
        makeTrace({ id: 't0', color: colorForIndex(PALETTE, 0) }),
        makeTrace({ id: 't1', color: '#123456' }),
      ],
      { curveId: 't1' }
    );
    expect(dot('Colour')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Colour' }));
    expect(curveIn(store, 't1')?.color).toBe(colorForIndex(PALETTE, 1));
    expect(dot('Colour')).toBeNull();
  });
});

// ------------------------------------------------------------ data › more --

describe('PV-curve schema — Data › More', () => {
  it('shows Live retention only with Live on, the archive fields only with Archive on', () => {
    const store = mount([makeTrace({ useLive: true, useArchive: false })]);
    openMore();
    expect(byId('live-retention')).not.toBeNull();
    expect(byId('curve-archiver')).toBeNull();
    expect(byId('show-archive-band')).toBeNull();
    expect(byId('optimized-bins')).toBeNull();

    fireEvent.click(byId('use-live')!);
    fireEvent.click(byId('use-archive')!);
    expect(curveIn(store)).toMatchObject({ useLive: false, useArchive: true });
    expect(byId('live-retention')).toBeNull();
    expect(byId('curve-archiver')).not.toBeNull();
    expect(byId('show-archive-band')).not.toBeNull();
    expect(byId('optimized-bins')).not.toBeNull();
  });

  it('writes Live retention in seconds as ms, dots it, and resets to automatic', () => {
    const store = mount();
    openMore();
    expect((byId('live-retention') as HTMLInputElement).value).toBe('');
    expect(dot('Live retention')).toBeNull();
    fireEvent.change(byId('live-retention')!, { target: { value: '60' } });
    expect(curveIn(store)?.liveRetentionMs).toBe(60_000);
    expect(dot('Live retention')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Live retention' }));
    expect(curveIn(store)?.liveRetentionMs).toBeUndefined();
    expect(dot('Live retention')).toBeNull();
  });

  it('stores only an off Min/max band, and Optimized bins as an optional path', () => {
    const store = mount();
    openMore();
    expect(dot('Min/max band')).toBeNull();
    fireEvent.click(byId('show-archive-band')!);
    expect(curveIn(store)?.showArchiveBand).toBe(false);
    expect(dot('Min/max band')).not.toBeNull();
    fireEvent.click(byId('show-archive-band')!);
    expect(curveIn(store)?.showArchiveBand).toBeUndefined();

    fireEvent.change(byId('optimized-bins')!, { target: { value: '500' } });
    expect(curveIn(store)?.optimizedDataBins).toBe(500);
    expect(dot('Optimized bins')).not.toBeNull();
    fireEvent.change(byId('optimized-bins')!, { target: { value: '' } });
    expect(curveIn(store)?.optimizedDataBins).toBeUndefined();
  });
});

// ------------------------------------------------------------------ style --

describe('PV-curve schema — Style', () => {
  it('edits Line, Width, Dash and Extend to now', () => {
    const store = mount();
    fireEvent.change(byId('line-type')!, { target: { value: 'direct' } });
    fireEvent.change(byId('line-width')!, { target: { value: '3' } });
    fireEvent.change(byId('line-style')!, { target: { value: 'dashed' } });
    expect(curveIn(store)).toMatchObject({ lineType: 'direct', lineWidth: 3, lineStyle: 'dashed' });
    expect(dot('Extend to now')).toBeNull();
    fireEvent.click(byId('extend-to-now')!);
    expect(curveIn(store)?.showExtensionLine).toBe(false);
    expect(dot('Extend to now')).not.toBeNull();
  });

  it('shows Marker and Marker size once #show-symbols (Markers) is on', () => {
    const store = mount();
    expect(byId('symbol-shape')).toBeNull();
    expect(byId('symbol-size')).toBeNull();
    fireEvent.click(byId('show-symbols')!);
    expect(curveIn(store)?.showSymbol).toBe(true);
    fireEvent.change(byId('symbol-shape')!, { target: { value: 'diamond' } });
    fireEvent.change(byId('symbol-size')!, { target: { value: '6' } });
    expect(curveIn(store)).toMatchObject({ symbolShape: 'diamond', symbolSize: 6 });
    fireEvent.click(byId('show-symbols')!);
    expect(byId('symbol-shape')).toBeNull();
    expect(byId('symbol-size')).toBeNull();
  });
});

// ---------------------------------------------------------------- actions --

describe('PV-curve schema — actions', () => {
  it('Inspect data and Create formula go through the model', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect data' }));
    expect(inspect).toHaveBeenCalledWith('t1');
    fireEvent.click(screen.getByRole('button', { name: 'Create formula from this curve' }));
    expect(createFormula).toHaveBeenCalledWith('t1');
  });

  it('disables both actions on a curve with no PV', () => {
    mount([makeTrace({ pvName: '' })]);
    for (const name of ['Inspect data', 'Create formula from this curve']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getAllByText(NO_PV_REASON).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------- updateRate --

describe('a legacy updateRate key', () => {
  it('new curves and formulas carry no updateRate', () => {
    expect('updateRate' in TRACE_DEFAULTS).toBe(false);
    expect('updateRate' in newTrace('t', 'PV', 'ax', '#000000', [])).toBe(false);
    expect('updateRate' in newFormula('f', 'ax', '#000000')).toBe(false);
  });

  it('plot= never writes it, even for a curve that still carries one', () => {
    const trace = { ...makeTrace({ displayName: 'X' }), updateRate: '1hz' };
    const config = plotConfigOf({ traces: [trace] }, PALETTE);
    expect(JSON.stringify(config)).not.toContain('updateRate');
  });

  it('an old view carrying updateRate still parses, without a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = parsePlotConfig(
      JSON.stringify({ v: 1, traces: [{ updateRate: 'monitor', displayName: 'Old' }] })
    );
    expect(config?.traces).toEqual([{ displayName: 'Old' }]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    const applied = applyPlotConfig(makePlot([makeAxis()], [makeTrace()]), config!);
    expect(applied.traces[0].displayName).toBe('Old');
  });

  it('a legacy .trc converts without updateRate; a saved file carrying it still loads', () => {
    const legacy = deserializeWorkspace(
      JSON.stringify({
        plot: { title: 'T' },
        'y-axes': [{ name: 'Axis 1', orientation: 'left' }],
        curves: [{ channel: 'TEST:A', yAxisName: 'Axis 1' }],
        formula: [{ formula: 'f://{x1}', curveDict: { x1: 'TEST:A' }, yAxisName: 'Axis 1' }],
      })
    );
    expect(legacy.plots[0].traces).toHaveLength(2);
    for (const t of legacy.plots[0].traces) expect('updateRate' in t).toBe(false);

    const plot = makePlot([makeAxis()], [makeTrace()]);
    const withKey = { ...plot, traces: [{ ...plot.traces[0], updateRate: 'monitor' }] };
    const saved = deserializeWorkspace(
      JSON.stringify({ schemaVersion: 1, theme: 'dark', plots: [withKey] })
    );
    expect(saved.source).toBe('native');
    expect(saved.plots[0].traces[0].pvName).toBe('TEST:CURRENT');
  });
});
