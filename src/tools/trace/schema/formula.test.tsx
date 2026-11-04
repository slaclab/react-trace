// @vitest-environment jsdom
//
// Trace's formula-curve item schema, rendered as an open card of the properties
// panel:
// - Signal is Label · Formula · Plot on · Visible, and the Style block is the
//   PV curve's own definition, Alarm colouring hidden;
// - the editor commits an expression and a binding, validates through the Formula Engine
//   (debounced, with the resolved PV names), shows errors and "Valid";
// - Width edits reach the curve and its series; Width is a required field
//   with no automatic rule, so it carries no dot, while the shared
//   block's Extend to now lights its dot when pinned;
// - Colour is the card swatch (and the body swatch) with its stamped dot.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { drawingThemeFor } from '../../../annotationTheme';
import { buildPlotOption } from '../../../components/plotOption';
import { newFormula } from '../../../embed/plotConfig';
import { DEFAULT_PALETTE_ID, colorForIndex, getPalette } from '../../../palettes';
import type { Axis, Plot, PVTrace } from '../../../types';
import { PanelHarness } from '../../../workbench/__fixtures__/PanelHarness';
import { SelectionProvider, createSelectionStore } from '../../../workbench/selection';
import type { Capabilities, ToolDefinition, ToolUi } from '../../../workbench/types';
import type { TraceFragmentInput } from '../codeFragments';
import type { TraceDotState } from '../dots';
import { FORMULA_VALIDATE_DEBOUNCE_MS, UNBOUND_VARIABLE } from '../fields/formulaEditor';
import { PV_CURVE_ITEM_KIND, pvCurveSchema, type TraceCurveModel } from './curve';
import {
  FORMULA_CURVE_ITEM_KIND,
  FORMULA_EDITOR_FIELD_ID,
  bindableCurves,
  createFormulaCurveSchema,
  formulaCurveSchema,
} from './formula';
import { WithCanopy } from '../../../test/canopy';

const validateFormula = vi.hoisted(() =>
  vi.fn<
    (
      spec: { expression: string; bindings: Record<string, string> },
      signal?: AbortSignal
    ) => Promise<{ valid: boolean; tokens: string[]; errors: string[] }>
  >(async () => ({ valid: true, tokens: [], errors: [] }))
);

// The SDK call takes the connection first; the mock sees the rest.
vi.mock('../../../api/formulaEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/formulaEngine')>();
  return {
    ...actual,
    validateFormula: (_conn: unknown, ...args: Parameters<typeof validateFormula>) =>
      validateFormula(...args),
  };
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

function makePv(overrides: Partial<PVTrace> = {}): PVTrace {
  return {
    id: 'pv1',
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

function makeFormula(overrides: Partial<PVTrace> = {}): PVTrace {
  return { ...newFormula('f1', 'ax1', colorForIndex(PALETTE, 1)), ...overrides };
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

function fragmentInput(plot: Plot): TraceFragmentInput {
  return {
    plot,
    archiveResults: new Map(),
    liveResults: new Map(),
    formulaResults: new Map(),
    theme: drawingThemeFor('light'),
  };
}

const MODEL: Model = { palette: PALETTE, fragmentInput, inspect: vi.fn(), createFormula: vi.fn() };

const definition: ToolDefinition<State, Model, ToolUi> = {
  schema: {
    tool: { tabs: [] },
    sections: { axis: { tabs: [] } },
    items: {
      [PV_CURVE_ITEM_KIND]: pvCurveSchema,
      [FORMULA_CURVE_ITEM_KIND]: createFormulaCurveSchema<State, Model>(),
    },
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
              kind: t.kind === 'formula' ? FORMULA_CURVE_ITEM_KIND : PV_CURVE_ITEM_KIND,
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
  traces: PVTrace[] = [makePv(), makeFormula()],
  {
    capabilities = { elog: true },
    curveId = 'f1',
  }: { capabilities?: Capabilities; curveId?: string } = {}
): Store {
  const store = createStore({
    plots: [makePlot([makeAxis(), makeAxis({ id: 'ax2', name: 'Second' })], traces)],
    activePlotId: 'p1',
  });
  const selection = createSelectionStore({
    initial: { level: 'item', kind: FORMULA_CURVE_ITEM_KIND, id: curveId },
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

function curveIn(store: Store, id = 'f1'): PVTrace | undefined {
  return store.getState().plots[0].traces.find((t) => t.id === id);
}

function dot(label: string): HTMLElement | null {
  return screen.queryByRole('img', { name: `${label} modified` });
}

function expressionInput(): HTMLTextAreaElement {
  return byId(FORMULA_EDITOR_FIELD_ID) as HTMLTextAreaElement;
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  validateFormula.mockReset();
  validateFormula.mockImplementation(async () => ({ valid: true, tokens: [], errors: [] }));
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {}))
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ shape --

describe('formula-curve schema — shape', () => {
  it('opens as a card with Signal and Style blocks, and no chart source', () => {
    mount();
    const body = cardBody();
    const blocks = [...body.querySelectorAll<HTMLElement>('.wb-block')].map((b) => b.dataset.block);
    expect(blocks).toEqual(['signal', 'style']);
    expect(byId('curve-code')).toBeNull();
  });

  it('Signal is Label · Formula · Plot on · Visible, all L1', () => {
    const signal = formulaCurveSchema.tabs[0];
    expect(signal.id).toBe('signal');
    expect(signal.fields.map((f) => [f.id, f.level])).toEqual([
      ['display-name', 'L1'],
      [FORMULA_EDITOR_FIELD_ID, 'L1'],
      ['y-axis', 'L1'],
      ['trace-visible', 'L1'],
    ]);
    expect(signal.fields[1].kind).toBe('custom');
  });

  it('shares the PV curve Style block layout and field ids', () => {
    const style = (s: typeof formulaCurveSchema | typeof pvCurveSchema) =>
      s.tabs
        .filter((t) => t.id === 'style')
        .map((t) => [t.id, t.label, t.fields.map((f) => [f.id, f.kind, f.level])]);
    expect(style(formulaCurveSchema)).toEqual(style(pvCurveSchema));
    expect(style(formulaCurveSchema)).toHaveLength(1);
  });

  it('hides Alarm colouring on a formula', () => {
    mount();
    expect(byId('extend-to-now')).not.toBeNull();
    expect(cardBody().querySelector('[data-field="alarm-coloring"]')).toBeNull();
  });

  it('has no PV-only field (PV name, Live, Archive, actions)', () => {
    const ids = formulaCurveSchema.tabs.flatMap((t) => t.fields.map((f) => f.id));
    for (const id of ['pv-name', 'use-live', 'use-archive', 'inspect-data', 'create-formula']) {
      expect(ids).not.toContain(id);
    }
  });

  it('bindable curves: same plot, not itself, not a formula, with a PV', () => {
    const state: State = {
      plots: [
        makePlot(
          [makeAxis()],
          [
            makePv(),
            makePv({ id: 'pv-empty', pvName: '' }),
            makeFormula(),
            makeFormula({ id: 'f2' }),
          ]
        ),
        makePlot([makeAxis()], [makePv({ id: 'elsewhere' })], 'p2'),
      ],
      activePlotId: 'p1',
    };
    expect(bindableCurves(state, 'f1').map((t) => t.id)).toEqual(['pv1']);
  });
});

// ----------------------------------------------------------------- editor --

describe('formula-curve schema — Formula editor', () => {
  it('commits an expression and a binding to the curve', () => {
    const store = mount();
    expect(expressionInput().value).toBe('');
    fireEvent.change(expressionInput(), { target: { value: '{x1} * 2' } });
    expect(curveIn(store)?.expression).toBe('{x1} * 2');

    const bind = byId('formula-bind-x1') as HTMLSelectElement;
    expect(Array.from(bind.options).map((o) => o.value)).toEqual(['', 'pv1']);
    expect(screen.getByText(UNBOUND_VARIABLE)).toBeTruthy();
    fireEvent.change(bind, { target: { value: 'pv1' } });
    expect(curveIn(store)).toMatchObject({ expression: '{x1} * 2', bindings: { x1: 'pv1' } });
    expect(screen.queryByText(UNBOUND_VARIABLE)).toBeNull();
  });

  it('labels a bindable curve by display name, else PV', () => {
    mount([
      makePv(),
      makePv({ id: 'pv2', pvName: 'TEST:OTHER', displayName: 'Other' }),
      makeFormula({ expression: '{x1}' }),
    ]);
    const bind = byId('formula-bind-x1') as HTMLSelectElement;
    expect(Array.from(bind.options).map((o) => o.textContent)).toEqual([
      '— select curve —',
      'TEST:CURRENT',
      'Other',
    ]);
  });

  it('says so when the plot has no PV curve to reference', () => {
    mount([makeFormula({ expression: '{x1}' })]);
    expect(byId('formula-bind-x1')).toBeNull();
    expect(screen.getByText(/No PV curves on this plot/)).toBeTruthy();
  });

  it('validates through the Formula Engine after the debounce with the resolved PV names, and shows Valid', async () => {
    vi.useFakeTimers();
    mount([makePv(), makeFormula({ expression: '{x1} + 1', bindings: { x1: 'pv1' } })]);
    expect(validateFormula).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(FORMULA_VALIDATE_DEBOUNCE_MS);
    });
    expect(validateFormula).toHaveBeenCalledTimes(1);
    expect(validateFormula.mock.calls[0][0]).toEqual({
      kind: 'timeseries',
      expression: '{x1} + 1',
      bindings: { x1: 'TEST:CURRENT' },
    });
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByText('Valid')).toBeTruthy());
  });

  it('debounces typing into one request for the last expression', async () => {
    vi.useFakeTimers();
    mount();
    fireEvent.change(expressionInput(), { target: { value: '{x1' } });
    fireEvent.change(expressionInput(), { target: { value: '{x1}' } });
    await act(async () => {
      vi.advanceTimersByTime(FORMULA_VALIDATE_DEBOUNCE_MS);
    });
    expect(validateFormula).toHaveBeenCalledTimes(1);
    expect(validateFormula.mock.calls[0][0].expression).toBe('{x1}');
  });

  it('shows Formula Engine errors for an invalid expression', async () => {
    validateFormula.mockImplementation(async () => ({
      valid: false,
      tokens: [],
      errors: ['unexpected token', 'unknown function foo'],
    }));
    mount([makePv(), makeFormula({ expression: 'foo(', bindings: {} })]);
    const errors = await screen.findByText(
      'unexpected token; unknown function foo',
      {},
      { timeout: 2000 }
    );
    expect(errors.getAttribute('role')).toBe('alert');
    expect(screen.queryByText('Valid')).toBeNull();
  });

  it('sends nothing for an empty expression', async () => {
    vi.useFakeTimers();
    mount();
    await act(async () => {
      vi.advanceTimersByTime(FORMULA_VALIDATE_DEBOUNCE_MS * 2);
    });
    expect(validateFormula).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------- signal --

describe('formula-curve schema — Signal edits', () => {
  it('writes Label, Plot on and Visible (the card eye) through the shared fields', () => {
    const store = mount();
    fireEvent.change(byId('display-name')!, { target: { value: 'Sum' } });
    expect(curveIn(store)?.displayName).toBe('Sum');
    fireEvent.change(byId('y-axis')!, { target: { value: 'ax2' } });
    expect(curveIn(store)?.axisId).toBe('ax2');
    fireEvent.click(within(cardHead()).getByRole('button', { name: 'Hide visible' }));
    expect(curveIn(store)?.visible).toBe(false);
  });
});

// ------------------------------------------------------------------ style --

describe('formula-curve schema — Style (shared)', () => {
  it('Width edits reach the curve and its series; Width has no dot', () => {
    const store = mount();
    fireEvent.change(byId('line-width')!, { target: { value: '4' } });
    expect(curveIn(store)?.lineWidth).toBe(4);
    const series = buildPlotOption(fragmentInput(store.getState().plots[0])).series.find(
      (s) => s.id === 'f1'
    ) as { lineStyle?: { width?: number } } | undefined;
    expect(series?.lineStyle?.width).toBe(4);
    expect(dot('Width')).toBeNull();
  });

  it('lights the dot on the shared block once Extend to now is pinned', () => {
    const store = mount();
    expect(dot('Extend to now')).toBeNull();
    fireEvent.click(byId('extend-to-now')!);
    expect(curveIn(store)?.showExtensionLine).toBe(false);
    expect(dot('Extend to now')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Extend to now' }));
    expect(curveIn(store)?.showExtensionLine).toBeUndefined();
    expect(dot('Extend to now')).toBeNull();
  });
});

// ----------------------------------------------------------------- colour --

describe('formula-curve schema — Colour (card swatch)', () => {
  it('puts Visible on the card eye and Colour on the card swatch', () => {
    const fields = formulaCurveSchema.tabs.flatMap((t) => t.fields);
    const visible = fields.find((f) => f.id === 'trace-visible');
    const colour = fields.find((f) => f.id === 'trace-color');
    expect(visible?.kind === 'toggle' && visible.row).toBe('eye');
    expect(colour?.kind === 'colour' && colour.row).toBe('swatch');
  });

  it("renders the formula card's swatch with the curve's colour", () => {
    mount([makePv(), makeFormula({ color: '#abcdef', displayName: 'Sum' })]);
    const row = document.querySelector('[data-row-id="f1"]') as HTMLElement;
    expect(row).not.toBeNull();
    const swatch = within(row).getByRole('button', { name: 'Colour' });
    expect(swatch.style.backgroundColor).toBe('rgb(171, 205, 239)');
    // A pinned (non-palette) colour shows the row's modified mark.
    expect(row.querySelector('.wb-outline-row__modified')).not.toBeNull();
  });

  it('shows the body swatch and resets a pinned colour to its palette slot', () => {
    const store = mount([makePv(), makeFormula({ color: '#123456' })]);
    expect(within(cardBody()).getByTestId('trace-color-swatch')).toBeTruthy();
    expect(dot('Colour')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Colour' }));
    expect(curveIn(store)?.color).toBe(colorForIndex(PALETTE, 1));
    expect(dot('Colour')).toBeNull();
  });
});
