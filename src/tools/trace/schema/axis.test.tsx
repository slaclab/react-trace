// @vitest-environment jsdom
//
// Trace's Y-axis section schema, rendered through the properties
// panel: listed under Signals, its fields in the Axes section as one sub-block
// per axis; Min/Max are absent while Auto-scale is on; Label lights its dot
// after an edit and resets to `axis.units`; Unit is its own optional
// `unitLabel`, shown from the EGU until overridden; Side never shows a dot;
// Remove axis removes the axis (and refuses the last one).
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { axisTitle, axisUnitText } from '../../../embed/plotConfig';
import type { Axis, Plot, PVTrace } from '../../../types';
import { PanelHarness } from '../../../workbench/__fixtures__/PanelHarness';
import { SelectionProvider, createSelectionStore } from '../../../workbench/selection';
import type { ToolDefinition, ToolUi } from '../../../workbench/types';
import { GROUPS } from '../../vocabulary';
import type { TraceDotState } from '../dots';
import { assignCurveToUnitAxis } from './curve';
import { AXIS_SECTION_KIND, LAST_AXIS_REASON, removeAxis, traceAxisSchema } from './axis';

type State = TraceDotState;
type Model = object;

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
    color: '#0f62fe',
    visible: true,
    axisId: 'ax1',
    useLive: false,
    useArchive: false,
    lineWidth: 2,
    lineType: 'step',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'circle',
    symbolSize: 4,
    data: [],
    ...overrides,
  } as PVTrace;
}

function makePlot(axes: Axis[], traces: PVTrace[] = []): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces,
    axes,
    backgroundColor: 'default',
    showLegend: true,
    showXGridlines: false,
    showYGridlines: true,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '1h' },
  };
}

const MODEL: Model = {};

const axisSchema = traceAxisSchema<State, Model>();

const definition: ToolDefinition<State, Model, ToolUi> = {
  schema: {
    // The Axes section the axis sub-blocks render in.
    tool: { tabs: [{ id: 'axes', label: 'Axes', fields: [] }] },
    sections: { [AXIS_SECTION_KIND]: axisSchema },
    items: {},
  },
  binding: {
    outline: (state) => {
      const plot = state.plots.find((p) => p.id === state.activePlotId) ?? state.plots[0];
      return {
        sections: (plot?.axes ?? []).map((a) => ({
          id: a.id,
          kind: AXIS_SECTION_KIND,
          title: a.name,
          unit: axisUnitText(a),
          count: plot!.traces.filter((t) => t.axisId === a.id).length,
          muted: !a.visible,
          rows: [],
        })),
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

function Harness({ store }: { store: Store }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return (
    <PanelHarness
      definition={definition}
      state={state}
      model={MODEL}
      ui={{}}
      update={store.update}
      capabilities={{ elog: true }}
      toolId="trace"
    />
  );
}

/** The axis whose Axes sub-block the helpers below read. */
let scope = 'ax1';

function mount(axes: Axis[], traces: PVTrace[] = [], axisId = axes[0].id): Store {
  scope = axisId;
  const store = createStore({ plots: [makePlot(axes, traces)], activePlotId: 'p1' });
  const selection = createSelectionStore({
    initial: { level: 'section', kind: AXIS_SECTION_KIND, id: axisId },
  });
  render(
    <SelectionProvider store={selection}>
      <Harness store={store} />
    </SelectionProvider>
  );
  return store;
}

function block(axisId = scope): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-axes-section="${axisId}"]`);
}

function byId(id: string): HTMLElement | null {
  // The first axis sub-block carries the bare field id, later ones `<id>--<axis id>`.
  const el = block();
  return (
    el?.querySelector<HTMLElement>(`[id="${id}"], [id="${id}--${el.dataset.axesSection}"]`) ?? null
  );
}

function axisIn(store: Store, id: string): Axis | undefined {
  return store.getState().plots[0].axes.find((a) => a.id === id);
}

function dot(label: string): HTMLElement | null {
  return within(block()!).queryByRole('img', { name: `${label} modified` });
}

function button(name: string): HTMLButtonElement {
  return within(block()!).getByRole('button', { name }) as HTMLButtonElement;
}

afterEach(cleanup);

describe('Trace axis schema — placement', () => {
  it('sits under Signals and shows its fields in Axes', () => {
    expect(axisSchema.group).toBe(GROUPS.signals);
    expect(axisSchema.placement).toBe('axes');
    expect(axisSchema.tabs.map((t) => t.id)).toEqual(['axis']);
  });

  it('renders one Axes sub-block per axis, headed by its name and unit text', () => {
    mount([
      makeAxis({ name: 'mA', units: 'mA', unitLabel: 'milliamp' }),
      makeAxis({ id: 'ax2', name: 'Y-Axis 2' }),
    ]);
    const axes = document.querySelector('.wb-plot-section[data-section="axes"]')!;
    const blocks = [...axes.querySelectorAll<HTMLElement>('[data-axes-section]')];
    expect(blocks.map((b) => b.dataset.axesSection)).toEqual(['ax1', 'ax2']);
    expect(blocks[0].querySelector('.wb-axes-block__heading')?.textContent).toBe('mAmilliamp');
    expect(blocks[1].querySelector('.wb-axes-block__unit')).toBeNull();
  });

  it('shows Label, Unit, Side, Visible, Auto-scale, Log scale and Remove axis', () => {
    mount([makeAxis()]);
    const ids = [...block()!.querySelectorAll<HTMLElement>('[data-field]')].map(
      (el) => el.dataset.field
    );
    expect(ids).toEqual([
      'axis-label',
      'axis-unit',
      'axis-orientation',
      'axis-visible',
      'axis-autoscale',
      'axis-logscale',
      'axis-remove',
    ]);
    expect(button('Remove axis')).toBeTruthy();
  });

  it('carries no chart source of its own', () => {
    mount([makeAxis()]);
    expect(document.getElementById('axis-code')).toBeNull();
  });
});

describe('Trace axis schema — fields', () => {
  it('hides Min and Max while Auto-scale is on and shows them once it is off', () => {
    const store = mount([makeAxis()]);
    expect(byId('axis-min')).toBeNull();
    expect(byId('axis-max')).toBeNull();

    fireEvent.click(byId('axis-autoscale')!);
    expect(axisIn(store, 'ax1')?.autoScale).toBe(false);
    expect(byId('axis-min')).not.toBeNull();
    expect(byId('axis-max')).not.toBeNull();

    fireEvent.click(byId('axis-autoscale')!);
    expect(axisIn(store, 'ax1')?.autoScale).toBe(true);
    expect(byId('axis-min')).toBeNull();
  });

  it('writes Min/Max and dots them as optional paths; reset clears the value', () => {
    const store = mount([makeAxis({ autoScale: false })]);
    expect(dot('Min')).toBeNull();
    fireEvent.change(byId('axis-min')!, { target: { value: '-5' } });
    expect(axisIn(store, 'ax1')?.min).toBe(-5);
    expect(dot('Min')).not.toBeNull();
    fireEvent.click(button('Reset Min'));
    expect(axisIn(store, 'ax1')?.min).toBeUndefined();
    expect(dot('Min')).toBeNull();

    fireEvent.change(byId('axis-max')!, { target: { value: '10' } });
    expect(axisIn(store, 'ax1')?.max).toBe(10);
  });

  it('lights the Label dot after an edit and resets back to axis.units', () => {
    const store = mount([makeAxis({ name: 'mA', units: 'mA' })]);
    expect(dot('Label')).toBeNull();
    fireEvent.change(byId('axis-label')!, { target: { value: 'Beam current' } });
    expect(axisIn(store, 'ax1')?.name).toBe('Beam current');
    expect(dot('Label')).not.toBeNull();
    fireEvent.click(button('Reset Label'));
    expect(axisIn(store, 'ax1')?.name).toBe('mA');
    expect(dot('Label')).toBeNull();
  });

  it('resets a unitless Label to Y-Axis <n> at the axis position', () => {
    const store = mount([makeAxis(), makeAxis({ id: 'ax2', name: 'Custom' })], [], 'ax2');
    expect(dot('Label')).not.toBeNull();
    fireEvent.click(button('Reset Label'));
    expect(axisIn(store, 'ax2')?.name).toBe('Y-Axis 2');
  });

  it('never shows a dot on Side, whatever it is set to', () => {
    const store = mount([makeAxis()]);
    expect(dot('Side')).toBeNull();
    fireEvent.change(byId('axis-orientation')!, { target: { value: 'right' } });
    expect(axisIn(store, 'ax1')?.orientation).toBe('right');
    expect(dot('Side')).toBeNull();
    fireEvent.change(byId('axis-orientation')!, { target: { value: 'left' } });
    expect(axisIn(store, 'ax1')?.orientation).toBe('left');
    expect(dot('Side')).toBeNull();
    expect(within(block()!).queryByRole('button', { name: 'Reset Side' })).toBeNull();
  });

  it('toggles Visible and Log scale without a dot; Visible is the header eye', () => {
    const store = mount([makeAxis()]);
    fireEvent.click(byId('axis-visible')!);
    expect(axisIn(store, 'ax1')?.visible).toBe(false);
    fireEvent.click(byId('axis-logscale')!);
    expect(axisIn(store, 'ax1')?.logScale).toBe(true);
    expect(dot('Visible')).toBeNull();
    expect(dot('Log scale')).toBeNull();
    const visible = axisSchema.tabs[0].fields.find((f) => f.id === 'axis-visible');
    expect(visible?.kind === 'toggle' && visible.row).toBe('eye');
  });
});

describe('Trace axis schema — Unit', () => {
  it('shows the stamped EGU automatically, with no dot', () => {
    mount([makeAxis({ name: 'mA', units: 'mA' })]);
    expect((byId('axis-unit') as HTMLInputElement).value).toBe('mA');
    expect(dot('Unit')).toBeNull();
  });

  it('writes unitLabel, lights its own dot and not the Label dot, and keeps units', () => {
    const store = mount([makeAxis({ name: 'mA', units: 'mA' })]);
    fireEvent.change(byId('axis-unit')!, { target: { value: 'milliamp' } });
    const axis = axisIn(store, 'ax1');
    expect(axis?.unitLabel).toBe('milliamp');
    expect(axis?.units).toBe('mA');
    expect(axis?.name).toBe('mA');
    expect(dot('Unit')).not.toBeNull();
    expect(dot('Label')).toBeNull();
    expect((byId('axis-unit') as HTMLInputElement).value).toBe('milliamp');
  });

  it('routes a new curve of the axis EGU to it after an override', () => {
    const store = mount(
      [makeAxis(), makeAxis({ id: 'ax2', name: 'mA', units: 'mA' })],
      [makeTrace({ id: 't1', axisId: 'ax1' })],
      'ax2'
    );
    fireEvent.change(byId('axis-unit')!, { target: { value: 'milliamp' } });
    act(() => store.update((s) => assignCurveToUnitAxis(s, 't1', 'mA', 'ax1', 'ax-new')));
    const plot = store.getState().plots[0];
    expect(plot.traces[0].axisId).toBe('ax2');
    expect(plot.axes.map((a) => a.id)).toEqual(['ax1', 'ax2']);
  });

  it('reset returns the Unit to the EGU', () => {
    const store = mount([makeAxis({ name: 'mA', units: 'mA', unitLabel: 'milliamp' })]);
    expect(dot('Unit')).not.toBeNull();
    fireEvent.click(button('Reset Unit'));
    expect(axisIn(store, 'ax1')?.unitLabel).toBeUndefined();
    expect(axisIn(store, 'ax1')?.units).toBe('mA');
    expect((byId('axis-unit') as HTMLInputElement).value).toBe('mA');
    expect(dot('Unit')).toBeNull();
  });

  it('titles the chart axis with the unit text while its Label is the EGU', () => {
    expect(axisTitle(makeAxis({ name: 'mA', units: 'mA', unitLabel: 'milliamp' }))).toBe(
      'milliamp'
    );
    expect(axisTitle(makeAxis({ name: 'mA', units: 'mA' }))).toBe('mA');
    expect(axisTitle(makeAxis({ name: 'Beam', units: 'mA', unitLabel: 'milliamp' }))).toBe('Beam');
  });

  it('clearing the Unit returns it to the EGU', () => {
    const store = mount([makeAxis({ units: 'mA', unitLabel: 'milliamp' })]);
    fireEvent.change(byId('axis-unit')!, { target: { value: '' } });
    expect(axisIn(store, 'ax1')?.unitLabel).toBeUndefined();
    expect(dot('Unit')).toBeNull();
  });
});

describe('Trace axis schema — Remove axis', () => {
  it('removes the axis and moves its curves to the first other axis', () => {
    const store = mount(
      [makeAxis(), makeAxis({ id: 'ax2', name: 'Y-Axis 2' })],
      [makeTrace({ id: 't1', axisId: 'ax1' }), makeTrace({ id: 't2', axisId: 'ax2' })],
      'ax2'
    );
    fireEvent.click(button('Remove axis'));
    const plot = store.getState().plots[0];
    expect(plot.axes.map((a) => a.id)).toEqual(['ax1']);
    expect(plot.traces.map((t) => t.axisId)).toEqual(['ax1', 'ax1']);
    // The removed axis has no sub-block any more.
    expect(block('ax2')).toBeNull();
    expect(block('ax1')).not.toBeNull();
  });

  it('refuses to remove a plot’s only axis, with the reason', () => {
    const store = mount([makeAxis()]);
    expect(button('Remove axis').disabled).toBe(true);
    expect(within(block()!).getByText(LAST_AXIS_REASON)).toBeTruthy();
    act(() => store.update((s) => removeAxis(s, 'ax1')));
    expect(store.getState().plots[0].axes).toHaveLength(1);
  });
});
