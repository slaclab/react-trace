// @vitest-environment jsdom
//
// Correlation's field schemas, rendered
// through the properties panel: the plot sections Acquisition / Axes / Display
// / Statistics with their summaries and the chart source (Statistics: Show
// statistics, the Metrics list editor, Reset metrics); their visibility rules
// (Density Y only in the density view, Layout only in the scatter view; Min/Max
// only while Auto-scale is off); the Trigger group's Source reading
// `mode === 'pv' || ui.pendingTrigger`; and the cards (Label and Colour on Y,
// Label only on X, neither on Trigger; the Plot on select's disabled options
// from the shared move rule; the Y's Style block).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { drawingThemeFor } from '../../annotationTheme';
import { toolCodeFragment, type CorrelationFragmentInput } from './codeFragments';
import { yFullMessage } from './edit';
import { CORRELATION_METRICS } from './metrics';
import { defaultMetrics, metricsAreDefault } from '../../statistics/model';
import { defaultCorrelationState, normalizeCorrelationState, type CorrelationState } from './query';
import { PanelHarness } from '../../workbench/__fixtures__/PanelHarness';
import { SelectionProvider, createSelectionStore } from '../../workbench/selection';
import { CORRELATION_TESTIDS } from './testids';
import type { Selection, ToolDefinition } from '../../workbench/types';
import { AXES, GROUPS, PLOT_SECTIONS } from '../vocabulary';
import { commitLookback, LOOKBACK_ERROR } from './fields/lookbackSpan';
import {
  FADE_OPACITY_REASON,
  correlationItemId,
  correlationMoveRefusal,
  correlationSchema,
  parseCorrelationItemId,
  triggerSource,
  type CorrelationSchemaModel,
  type CorrelationUi,
} from './schema';
import { autoYColor } from '../shared/colors';

type State = CorrelationState;
type Model = CorrelationSchemaModel;

const UNITS: Record<string, string> = { 'X:PV': 'mm', 'Y:A': 'mA', 'Y:B': 'mA', 'T:PV': '' };

function fragmentInput(state: State): CorrelationFragmentInput {
  return {
    frame: null,
    view: state.view,
    axes: state.axes,
    densityPv: state.dy,
    unitsOf: (pv) => UNITS[pv] ?? '',
    theme: drawingThemeFor('light'),
    hidden: new Set(Object.keys(state.hidden)),
    width: 600,
    markers: state.markers,
    fit: state.fit,
    legend: state.legend,
    grid: state.grid,
    crosshair: state.crosshair,
    xScale: state.xScale,
    yScale: state.yScale,
    fade: state.fade,
  };
}

const MODEL: Model = { fragmentInput, unitsOf: (pv) => UNITS[pv] ?? '' };

const schema = correlationSchema<Model, CorrelationUi>();

const definition: ToolDefinition<State, Model, CorrelationUi> = {
  schema,
  binding: {
    // Just enough outline for the panel to list the cards, in the tool's order.
    outline: (state) => {
      const rows = (role: 'x' | 'y' | 'trig', pvs: string[]) =>
        pvs.map((pv) => ({
          id: correlationItemId(role, pv),
          kind: role,
          label: pv,
          status: 'ok' as const,
        }));
      const trig = state.trigger.mode === 'pv' ? [state.trigger.pv] : [];
      const x = state.x === '' ? [] : [state.x];
      return {
        sections: [
          { id: 'y', kind: 'y', title: 'Y', count: state.ys.length, rows: rows('y', state.ys) },
          { id: 'x', kind: 'x', title: 'X', count: x.length, rows: rows('x', x) },
          {
            id: 'trig',
            kind: 'trig',
            title: 'Trigger',
            count: trig.length,
            rows: rows('trig', trig),
          },
        ],
      };
    },
    ops: { add: async () => undefined, remove: () => {}, move: () => {} },
    moveRefusal: () => null,
  },
};

function makeState(overrides: Partial<State> = {}): State {
  return normalizeCorrelationState({
    ...defaultCorrelationState(),
    x: 'X:PV',
    ys: ['Y:A', 'Y:B'],
    ...overrides,
  });
}

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

function Harness({ store, ui }: { store: Store; ui: CorrelationUi }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return (
    <PanelHarness
      definition={definition}
      state={state}
      model={MODEL}
      ui={ui}
      update={store.update}
      capabilities={{ elog: true }}
      toolId="correlation"
    />
  );
}

function mount(state: State, selection: Selection = null, ui: CorrelationUi = {}): Store {
  const store = createStore(state);
  render(
    <SelectionProvider store={createSelectionStore({ initial: selection })}>
      <Harness store={store} ui={ui} />
    </SelectionProvider>
  );
  return store;
}

const item = (role: 'x' | 'y' | 'trig', pv: string): Selection => ({
  level: 'item',
  kind: role,
  id: correlationItemId(role, pv),
});

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function dot(label: string): HTMLElement | null {
  return screen.queryByRole('img', { name: `${label} modified` });
}

function radio(name: string, scope: HTMLElement = document.body): HTMLElement {
  return within(scope).getByRole('radio', { name });
}

/** A plot-wide section of the panel by its id. */
function plotSection(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.wb-plot-section[data-section="${id}"]`);
  if (el === null) throw new Error(`no plot section ${id}`);
  return el;
}

/** The ids of the fields shown in `scope`, in order. */
function fieldIds(scope: ParentNode): string[] {
  return [...scope.querySelectorAll('[data-field]')].map((f) => f.getAttribute('data-field') ?? '');
}

/** The open card's body. */
function cardBody(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.wb-card__body');
  if (el === null) throw new Error('no open card');
  return el;
}

/** The open card's blocks: id and heading (empty when the card shows none). */
function blocks(): [string, string][] {
  return [...cardBody().querySelectorAll('[data-block]')].map((b) => [
    b.getAttribute('data-block') ?? '',
    b.querySelector('.wb-block__heading')?.textContent ?? '',
  ]);
}

function group(slug: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.wb-group[data-group="${slug}"]`);
  if (el === null) throw new Error(`no group ${slug}`);
  return el;
}

function summaryOf(id: string): string {
  return plotSection(id).querySelector('.wb-plot-section__summary')?.textContent ?? '';
}

afterEach(cleanup);

// ------------------------------------------------------------------- tool --

describe('Correlation schema — plot sections', () => {
  it('has Acquisition, Axes, Display and Statistics, then the chart source', () => {
    mount(makeState());
    const sections = [...document.querySelectorAll('.wb-plot-section')].map((s) =>
      s.getAttribute('data-section')
    );
    expect(sections).toEqual(['acquisition', 'axes', 'display', 'statistics']);
    expect(schema.tool.tabs.map((t) => [t.id, t.label])).toEqual(
      Object.values(PLOT_SECTIONS).map((s) => [s.id, s.label])
    );
    // The harness opens every plot-wide part, the chart source included.
    expect(screen.getByRole('button', { name: 'Hide chart source' })).toBeTruthy();
  });

  it('summarizes each section in one short line', () => {
    mount(makeState());
    expect(summaryOf('acquisition')).toBe('1000 points · 1h');
    expect(summaryOf('axes')).toBe('Y auto · X auto');
    expect(summaryOf('display')).toBe('scatter · fit · legend · grid · tooltip');
    expect(summaryOf('statistics')).toBe('off');
  });

  it('the summaries follow the state', () => {
    mount(
      makeState({
        n: 250,
        lookback: '30m',
        yScale: { auto: false, min: 0, max: 10 },
        view: 'density',
        fit: false,
        legend: false,
        grid: false,
        crosshair: true,
        tooltip: false,
        readout: true,
      })
    );
    expect(summaryOf('acquisition')).toBe('250 points · 30m');
    expect(summaryOf('axes')).toBe('Y 0–10 · X auto');
    expect(summaryOf('display')).toBe('density · crosshair');
    expect(summaryOf('statistics')).toBe('on · 5 metrics');
  });

  it('Acquisition holds Max points and Lookback', () => {
    mount(makeState());
    expect(fieldIds(plotSection('acquisition'))).toEqual(['max-points', 'lookback']);
  });

  it('Display lists what to draw, then the shared toggles, in order', () => {
    mount(makeState());
    expect(fieldIds(plotSection('display'))).toEqual([
      'view',
      'fit-line',
      'fade',
      'legend',
      'grid',
      'crosshair',
      'tooltip',
      'drag',
    ]);
    const display = plotSection('display');
    expect(within(display).getByRole('radiogroup', { name: 'Plot as' })).toBeTruthy();
    expect(within(display).getByRole('radiogroup', { name: 'Mouse drag' })).toBeTruthy();
    expect(display.querySelector('[data-field="tooltip"] .wb-field__label')?.textContent).toBe(
      'Data tooltip'
    );
  });

  it('shows Layout only in the scatter view and Density Y only in the density view', () => {
    const store = mount(makeState());
    expect(byId('y-layout')).not.toBeNull();
    expect(byId('density-y')).toBeNull();
    expect(byId('fit-line')).not.toBeNull();

    fireEvent.click(radio('Density', plotSection('display')));
    expect(store.getState().view).toBe('density');
    expect(byId('density-y')).not.toBeNull();
    expect(byId('y-layout')).toBeNull();
    expect(fieldIds(plotSection('display')).slice(0, 3)).toEqual(['view', 'density-y', 'fit-line']);
  });

  it('writes Layout through the segmented control in Axes', () => {
    const store = mount(makeState());
    const layout = within(plotSection('axes')).getByRole('radiogroup', { name: 'Layout' });
    fireEvent.click(radio('Split', layout));
    expect(store.getState().axes).toBe('split');
  });

  it('defaults Density Y to the first Y; picking one pins it and reset unpins it', () => {
    const store = mount(makeState({ view: 'density' }));
    const select = byId('density-y') as HTMLSelectElement;
    expect(select.value).toBe('Y:A');
    expect(dot('Density Y')).toBeNull();
    fireEvent.change(select, { target: { value: 'Y:B' } });
    expect(store.getState().dy).toBe('Y:B');
    expect(dot('Density Y')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Density Y' }));
    expect(store.getState().dy).toBe('');
    expect(dot('Density Y')).toBeNull();
  });

  it('toggles the Fit line off without a dot', () => {
    const store = mount(makeState());
    fireEvent.click(byId('fit-line')!);
    expect(store.getState().fit).toBe(false);
    expect(dot('Fit line')).toBeNull();
  });

  it('writes Max points within [1, 10000] and ignores an out-of-range value', () => {
    const store = mount(makeState());
    fireEvent.change(byId('max-points')!, { target: { value: '250' } });
    expect(store.getState().n).toBe(250);
    fireEvent.change(byId('max-points')!, { target: { value: '20000' } });
    expect(store.getState().n).toBe(250);
  });

  it('commits a valid Lookback on blur and refuses an invalid one with the reason', () => {
    const store = mount(makeState());
    const input = byId('lookback') as HTMLInputElement;
    expect(input.value).toBe('1h');
    fireEvent.change(input, { target: { value: '90m' } });
    expect(store.getState().lookback).toBe('1h');
    fireEvent.blur(input);
    expect(store.getState().lookback).toBe('90m');

    fireEvent.change(input, { target: { value: 'soon' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(store.getState().lookback).toBe('90m');
    expect(screen.getByText(LOOKBACK_ERROR)).toBeTruthy();
  });

  it('clamps a committed Lookback to [1m, 24h]', () => {
    expect(commitLookback(' 30 m')).toBe('30m');
    expect(commitLookback('2d')).toBe('24h');
    expect(commitLookback('10s')).toBe('1m');
    expect(commitLookback('nope')).toBeNull();
    expect(commitLookback('')).toBeNull();
  });

  it('writes every Display toggle and Mouse drag without a dot; Show statistics is not there', () => {
    const store = mount(makeState());
    const display = plotSection('display');
    expect(display.querySelector('#stats-show')).toBeNull();
    for (const id of ['legend', 'grid', 'crosshair', 'fade', 'tooltip']) {
      fireEvent.click(byId(id)!);
    }
    fireEvent.click(radio('Pan', display));
    const s = store.getState();
    expect([s.legend, s.grid, s.crosshair, s.fade, s.tooltip, s.drag]).toEqual([
      false,
      false,
      true,
      true,
      false,
      'pan',
    ]);
    for (const label of [
      'Legend',
      'Grid',
      'Crosshair',
      'Fade older points',
      'Data tooltip',
      'Mouse drag',
    ]) {
      expect(dot(label)).toBeNull();
    }
  });

  it('shows the chart option without series as the chart source', () => {
    const state = makeState({ crosshair: true });
    mount(state);
    expect(byId('correlation-code')?.textContent).toBe(toolCodeFragment(fragmentInput(state)));
    fireEvent.click(screen.getByRole('button', { name: 'Hide chart source' }));
    expect(byId('correlation-code')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show chart source' }));
    expect(byId('correlation-code')).not.toBeNull();
  });

  it('no section or card has a code block of its own', () => {
    for (const object of [...Object.values(schema.sections), ...Object.values(schema.items)]) {
      expect(object.tabs.map((t) => t.id)).not.toContain('code');
    }
  });
});

// ------------------------------------------------------------- statistics --

describe('Correlation schema — Statistics', () => {
  const checkbox = (label: string) => screen.getByRole('checkbox', { name: `Show ${label}` });
  const button = (name: string) => screen.getByRole('button', { name });
  const metricIds = (store: Store) => store.getState().metrics.map((m) => m.id);

  function addCustom(store: Store): HTMLInputElement {
    fireEvent.click(button('Add metric'));
    expect(store.getState().metrics.at(-1)).toEqual({
      id: 'c1',
      label: 'Metric 1',
      expr: '',
      unit: '',
      on: true,
      strip: false,
    });
    const expr = byId('metrics-c1-expr') as HTMLInputElement;
    expect(document.activeElement).toBe(expr);
    return expr;
  }

  it('holds Show statistics, Metrics and Reset metrics; Reset is disabled at the default', () => {
    mount(makeState());
    const stats = plotSection('statistics');
    expect(stats.querySelector('#stats-show')).not.toBeNull();
    expect(stats.querySelector('#metrics')).not.toBeNull();
    const reset = byId('metrics-reset') as HTMLButtonElement;
    expect(stats.contains(reset)).toBe(true);
    expect(reset.disabled).toBe(true);
    expect(screen.getByText('Already the default')).toBeTruthy();
  });

  it('Show statistics writes `readout`', () => {
    const store = mount(makeState());
    fireEvent.click(byId('stats-show')!);
    expect(store.getState().readout).toBe(true);
  });

  it('a row checkbox writes `on` and the strip toggle writes `strip`', () => {
    const store = mount(makeState());
    fireEvent.click(checkbox('std'));
    expect(store.getState().metrics.find((m) => m.id === 'std')?.on).toBe(false);
    fireEvent.click(checkbox('R²'));
    expect(store.getState().metrics.find((m) => m.id === 'r2')?.on).toBe(true);

    const strip = button('Strip chart for r');
    expect(strip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(strip);
    expect(store.getState().metrics.find((m) => m.id === 'r')?.strip).toBe(true);
    expect(button('Strip chart for r').getAttribute('aria-pressed')).toBe('true');
  });

  it('Add metric appends c1 "Metric 1", expanded; its expression commits on Enter', () => {
    const store = mount(makeState());
    const expr = addCustom(store);
    expect(button('Collapse Metric 1')).toBeTruthy();
    fireEvent.change(expr, { target: { value: 'std(y - mean(y))' } });
    expect(store.getState().metrics.at(-1)?.expr).toBe('');
    fireEvent.keyDown(expr, { key: 'Enter' });
    expect(store.getState().metrics.at(-1)?.expr).toBe('std(y - mean(y))');
  });

  it('shows an unknown Y with its reason and still commits the expression', () => {
    const store = mount(makeState());
    const expr = addCustom(store);
    fireEvent.change(expr, { target: { value: 'mean(y3)' } });
    const reason = 'Unknown variable y3: only 2 Y PVs';
    expect(screen.getByText(reason)).toBeTruthy();
    expect(expr.getAttribute('aria-invalid')).not.toBe('true');
    fireEvent.blur(expr);
    expect(store.getState().metrics.at(-1)?.expr).toBe('mean(y3)');
    expect(screen.getByText(reason)).toBeTruthy();
    expect(expr.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('img', { name: `Metric 1: ${reason}` })).toBeTruthy();
  });

  it('Unit writes `unit`; Delete removes the metric', () => {
    const store = mount(makeState());
    addCustom(store);
    fireEvent.change(byId('metrics-c1-unit')!, { target: { value: 'y/x' } });
    expect(store.getState().metrics.at(-1)?.unit).toBe('y/x');
    fireEvent.click(button('Delete Metric 1'));
    expect(metricIds(store)).not.toContain('c1');
    expect(metricsAreDefault(CORRELATION_METRICS, store.getState().metrics)).toBe(true);
  });

  it('Move up / Move down reorder the list', () => {
    const store = mount(makeState());
    fireEvent.click(button('Edit std'));
    expect(screen.getByText('std(y)', { selector: 'code' }).parentElement?.textContent).toBe(
      'Built-in: std(y)'
    );
    fireEvent.click(button('Move up'));
    expect(metricIds(store).slice(0, 3)).toEqual(['n', 'std', 'mean']);
    fireEvent.click(button('Move down'));
    fireEvent.click(button('Move down'));
    expect(metricIds(store).slice(0, 4)).toEqual(['n', 'mean', 'r', 'std']);
  });

  it('Reset metrics restores the default and becomes disabled again', () => {
    const store = mount(makeState());
    fireEvent.click(checkbox('n'));
    addCustom(store);
    const reset = byId('metrics-reset') as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect(store.getState().metrics).toEqual(defaultMetrics(CORRELATION_METRICS));
    expect((byId('metrics-reset') as HTMLButtonElement).disabled).toBe(true);
  });

  it('deletes a built-in metric; Reset metrics brings it back', () => {
    const store = mount(makeState());
    fireEvent.click(button('Edit R²'));
    fireEvent.click(button('Delete R²'));
    expect(metricIds(store)).not.toContain('r2');
    expect(screen.queryByRole('checkbox', { name: 'Show R²' })).toBeNull();
    fireEvent.click(byId('metrics-reset')!);
    expect(store.getState().metrics).toEqual(defaultMetrics(CORRELATION_METRICS));
    expect(checkbox('R²')).toBeTruthy();
  });
});

// ------------------------------------------------------------------- axes --

describe('Correlation schema — Axes', () => {
  it('holds the Y axis, then the X axis, each under its sub-heading', () => {
    mount(makeState());
    const axes = plotSection('axes');
    expect([...axes.querySelectorAll('.wb-block__subheading')].map((h) => h.textContent)).toEqual([
      AXES.y,
      AXES.x,
    ]);
    expect(fieldIds(axes)).toEqual([
      'y-layout',
      'axis-unit',
      'axis-autoscale',
      'axis-logscale',
      'x-axis-unit',
      'x-axis-autoscale',
      'x-axis-logscale',
    ]);
  });

  it('the X and Y sections keep no fields of their own', () => {
    expect(schema.sections.x.tabs).toEqual([]);
    expect(schema.sections.y.tabs).toEqual([]);
    mount(makeState());
    for (const slug of ['signals', 'x-axis-pv']) {
      expect(group(slug).querySelector('.wb-outline-section__settings')).toBeNull();
      expect(fieldIds(group(slug))).toEqual([]);
    }
  });

  it('shows the automatic Units read-only and hides Min/Max while Auto-scale is on', () => {
    mount(makeState());
    expect(byId('axis-unit')?.textContent).toBe('mA');
    expect(byId('x-axis-unit')?.textContent).toBe('mm');
    for (const id of ['axis-min', 'axis-max', 'x-axis-min', 'x-axis-max']) {
      expect(byId(id)).toBeNull();
    }
  });

  it('turning X Auto-scale off shows its Min/Max; values dot as optional paths and reset', () => {
    const store = mount(makeState());
    fireEvent.click(byId('x-axis-autoscale')!);
    expect(store.getState().xScale).toEqual({ auto: false });
    expect(byId('axis-min')).toBeNull();
    fireEvent.change(byId('x-axis-min')!, { target: { value: '-2' } });
    expect(store.getState().xScale?.min).toBe(-2);
    expect(dot('Min')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Min' }));
    expect(store.getState().xScale?.min).toBeUndefined();
    expect(dot('Min')).toBeNull();

    // Back on keeps Max, so turning it off again restores it.
    fireEvent.change(byId('x-axis-max')!, { target: { value: '7' } });
    fireEvent.click(byId('x-axis-autoscale')!);
    expect(store.getState().xScale).toEqual({ max: 7 });
    expect(byId('x-axis-max')).toBeNull();
    expect(store.getState().yScale).toBeUndefined();
  });

  it('the Y axis fields write the Y scale only', () => {
    const store = mount(makeState());
    fireEvent.click(byId('axis-logscale')!);
    expect(store.getState().yScale).toEqual({ log: true });
    expect(store.getState().xScale).toBeUndefined();
    fireEvent.click(byId('axis-logscale')!);
    expect(store.getState().yScale).toBeUndefined();
    fireEvent.click(byId('axis-autoscale')!);
    fireEvent.change(byId('axis-max')!, { target: { value: '10' } });
    expect(store.getState().yScale).toEqual({ auto: false, max: 10 });
    expect(byId('x-axis-max')).toBeNull();
  });
});

// ---------------------------------------------------------------- trigger --

describe('Correlation schema — Trigger group', () => {
  const source = () => screen.getByTestId(CORRELATION_TESTIDS.triggerSource) as HTMLSelectElement;

  it('shows the Source once, in the group header; Period and Fire on under the cards', () => {
    mount(makeState({ trigger: { mode: 'timer', dtS: 2 } }));
    const trigger = group('trigger');
    expect(trigger.querySelector('.wb-group__heading')?.textContent).toBe(GROUPS.trigger);
    expect(within(trigger).getAllByTestId(CORRELATION_TESTIDS.triggerSource)).toHaveLength(1);
    expect(screen.getAllByTestId(CORRELATION_TESTIDS.triggerSource)).toHaveLength(1);
    expect(byId('trigger-source')).toBeNull();
    expect(fieldIds(trigger.querySelector('.wb-outline-section__settings')!)).toEqual([
      'trigger-period',
    ]);
  });

  it('reads Timer and shows Period in Timer mode', () => {
    const store = mount(makeState({ trigger: { mode: 'timer', dtS: 2 } }));
    expect(source().value).toBe('timer');
    expect((byId('trigger-period') as HTMLInputElement).value).toBe('2');
    fireEvent.change(byId('trigger-period')!, { target: { value: '0.5' } });
    expect(store.getState().trigger).toEqual({ mode: 'timer', dtS: 0.5 });
  });

  it('reads PV in PV mode and hides Period', () => {
    mount(makeState({ trigger: { mode: 'pv', pv: 'T:PV' } }));
    expect(source().value).toBe('pv');
    expect(byId('trigger-period')).toBeNull();
  });

  it('reads PV while ui.pendingTrigger is set, with no trigger PV yet', () => {
    mount(makeState(), null, { pendingTrigger: true });
    expect(source().value).toBe('pv');
    expect(byId('trigger-period')).toBeNull();
    expect(triggerSource(makeState(), {})).toBe('timer');
  });

  it('choosing PV writes nothing to state and raises pendingTrigger', () => {
    const setPendingTrigger = vi.fn();
    const initial = makeState();
    const store = mount(initial, null, { setPendingTrigger });
    fireEvent.change(source(), { target: { value: 'pv' } });
    expect(store.getState()).toBe(initial);
    expect(setPendingTrigger).toHaveBeenCalledWith(true);
  });

  it('choosing Timer drops the trigger PV for Timer 1 s and clears pendingTrigger', () => {
    const setPendingTrigger = vi.fn();
    const store = mount(makeState({ trigger: { mode: 'pv', pv: 'T:PV' } }), null, {
      setPendingTrigger,
    });
    fireEvent.change(source(), { target: { value: 'timer' } });
    expect(store.getState().trigger).toEqual({ mode: 'timer', dtS: 1 });
    expect(setPendingTrigger).toHaveBeenCalledWith(false);
  });

  it('hides Fire on in Timer mode', () => {
    mount(makeState({ trigger: { mode: 'timer', dtS: 2 } }));
    expect(byId('trigger-fire')).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Rising' })).toBeNull();
  });

  it('shows Fire on in PV mode, reading Every update when fire is absent', () => {
    mount(makeState({ trigger: { mode: 'pv', pv: 'T:PV' } }));
    expect(byId('trigger-fire')).not.toBeNull();
    expect(radio('Every update').getAttribute('aria-checked')).toBe('true');
    expect(radio('Rising').getAttribute('aria-checked')).toBe('false');
    expect(radio('Falling')).toBeTruthy();
    expect(dot('Fire on')).toBeNull();
  });

  it('picking Rising writes fire, picking Every update deletes it', () => {
    const store = mount(makeState({ trigger: { mode: 'pv', pv: 'T:PV' } }));
    fireEvent.click(radio('Rising'));
    expect(store.getState().fire).toBe('rising');
    expect(dot('Fire on')).not.toBeNull();
    fireEvent.click(radio('Falling'));
    expect(store.getState().fire).toBe('falling');
    fireEvent.click(radio('Every update'));
    expect(store.getState()).not.toHaveProperty('fire');
    expect(dot('Fire on')).toBeNull();
  });

  it('shows Fire on disabled while the trigger PV is still pending', () => {
    const initial = makeState();
    const store = mount(initial, null, { pendingTrigger: true });
    expect(byId('trigger-fire')).not.toBeNull();
    fireEvent.click(radio('Rising'));
    expect(store.getState()).not.toHaveProperty('fire');
  });
});

// ------------------------------------------------------------------ cards --

describe('Correlation schema — groups', () => {
  it('Y under Signals, X under X axis PV, Trigger under Trigger, in that order', () => {
    mount(makeState());
    const groups = [...document.querySelectorAll('.wb-group')].map(
      (g) => g.querySelector('.wb-group__heading')?.textContent
    );
    expect(groups).toEqual([GROUPS.signals, GROUPS.xPv, GROUPS.trigger]);
    expect(schema.sections.y.group).toBe(GROUPS.signals);
    expect(schema.sections.x.group).toBe(GROUPS.xPv);
    expect(schema.sections.trig.group).toBe(GROUPS.trigger);
  });
});

describe('Correlation schema — Y card', () => {
  it('has a Signal block (Label, Plot on) and a Style block (Colour, Marker, Marker size, Opacity)', () => {
    mount(makeState(), item('y', 'Y:B'));
    expect(blocks()).toEqual([
      ['signal', 'Signal'],
      ['style', 'Style'],
    ]);
    const [signal, style] = [...cardBody().querySelectorAll<HTMLElement>('[data-block]')];
    expect(fieldIds(signal)).toEqual(['label', 'role']);
    expect(fieldIds(style)).toEqual(['colour', 'marker-shape', 'marker-size', 'marker-opacity']);
    expect(within(style).getByTestId('trace-color-swatch')).toBeTruthy();
    expect(signal.querySelector('[data-field="role"] .wb-field__label')?.textContent).toBe(
      'Plot on'
    );
    // Visible is the card eye, not a body field.
    expect(byId('visible')).toBeNull();
    const fields = schema.items.y.tabs.flatMap((t) => t.fields);
    expect(fields.find((f) => f.id === 'colour')).toMatchObject({ row: 'swatch', tab: 'style' });
    expect(fields.find((f) => f.id === 'visible')).toMatchObject({ row: 'eye', tab: 'signal' });
  });

  it('shows the PV as the automatic Label; an edit pins it and reset deletes the record', () => {
    const store = mount(makeState(), item('y', 'Y:B'));
    expect((byId('label') as HTMLInputElement).value).toBe('Y:B');
    expect(dot('Label')).toBeNull();
    fireEvent.change(byId('label')!, { target: { value: 'Beam B' } });
    expect(store.getState().labels).toEqual({ 'Y:B': 'Beam B' });
    expect(dot('Label')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Label' }));
    expect(store.getState().labels).toEqual({});
    expect(dot('Label')).toBeNull();
  });

  it('shows the positional colour; picking the positional colour keeps the dot', () => {
    const store = mount(makeState(), item('y', 'Y:B'));
    const input = cardBody().querySelector('input[type="color"]') as HTMLInputElement;
    expect(input.value).toBe(autoYColor(1));
    expect(dot('Colour')).toBeNull();
    fireEvent.change(input, { target: { value: '#123456' } });
    expect(store.getState().colors).toEqual({ 'Y:B': '#123456' });
    // Back to the positional colour: still pinned (unlike Trace's palette rule).
    fireEvent.change(input, { target: { value: autoYColor(1) } });
    expect(store.getState().colors).toEqual({ 'Y:B': autoYColor(1) });
    expect(dot('Colour')).not.toBeNull();
    fireEvent.click(within(cardBody()).getByRole('button', { name: 'Reset Colour' }));
    expect(store.getState().colors).toEqual({});
  });

  it('the card eye writes the hidden record', () => {
    const store = mount(makeState(), item('y', 'Y:A'));
    const card = document.querySelector('[data-card-id="y:Y:A"]') as HTMLElement;
    fireEvent.click(card.querySelector('.wb-eye')!);
    expect(store.getState().hidden).toEqual({ 'Y:A': true });
  });

  it('marker fields dot per field and reset only that field', () => {
    const store = mount(makeState(), item('y', 'Y:A'));
    expect((byId('marker-size') as HTMLInputElement).value).toBe('5');
    fireEvent.change(byId('marker-size')!, { target: { value: '9' } });
    fireEvent.change(byId('marker-shape')!, { target: { value: 'diamond' } });
    expect(store.getState().markers).toEqual({ 'Y:A': { size: 9, shape: 'diamond' } });
    expect(dot('Marker size')).not.toBeNull();
    expect(dot('Opacity')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Marker size' }));
    expect(store.getState().markers).toEqual({ 'Y:A': { shape: 'diamond' } });
  });

  it('hides the marker fields in the density view; Colour stays', () => {
    mount(makeState({ view: 'density' }), item('y', 'Y:A'));
    const style = cardBody().querySelector<HTMLElement>('[data-block="style"]')!;
    expect(fieldIds(style)).toEqual(['colour']);
  });

  it('disables Opacity with its reason while Fade older points is on', () => {
    const store = mount(makeState({ fade: true }), item('y', 'Y:A'));
    const opacity = byId('marker-opacity') as HTMLInputElement;
    expect(opacity.disabled).toBe(true);
    expect(
      cardBody().querySelector('[data-field="marker-opacity"] .wb-field__note')?.textContent
    ).toBe(FADE_OPACITY_REASON);
    fireEvent.click(byId('fade')!);
    expect(store.getState().fade).toBe(false);
    expect((byId('marker-opacity') as HTMLInputElement).disabled).toBe(false);
  });
});

describe('Correlation schema — X and Trigger cards', () => {
  it('the X card has Label (the X title) and Plot on, no Colour and no Style block', () => {
    const store = mount(makeState(), item('x', 'X:PV'));
    expect(blocks()).toEqual([['signal', '']]);
    expect(fieldIds(cardBody())).toEqual(['label', 'role']);
    expect(within(cardBody()).getByText('The X axis title')).toBeTruthy();
    expect(within(cardBody()).queryByTestId('trace-color-swatch')).toBeNull();
    fireEvent.change(byId('label')!, { target: { value: 'Position' } });
    expect(store.getState().labels).toEqual({ 'X:PV': 'Position' });
  });

  it('the Trigger card has neither Label nor Colour', () => {
    mount(makeState({ trigger: { mode: 'pv', pv: 'T:PV' } }), item('trig', 'T:PV'));
    expect(fieldIds(cardBody())).toEqual(['role']);
    expect(byId('label')).toBeNull();
    expect(within(cardBody()).queryByTestId('trace-color-swatch')).toBeNull();
    expect((byId('role') as HTMLSelectElement).value).toBe('trig');
  });
});

describe('Correlation schema — Plot on', () => {
  const fullYs = Array.from({ length: 8 }, (_, i) => `Y:${i}`);

  it('lists the roles in panel order: Y, X, Trigger', () => {
    mount(makeState(), item('y', 'Y:A'));
    const options = [...(byId('role') as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(['y', 'x', 'trig']);
  });

  it('moves a Y to X by swapping with the old X, carrying its label', () => {
    const store = mount(makeState({ labels: { 'Y:A': 'Alpha' } }), item('y', 'Y:A'));
    fireEvent.change(byId('role')!, { target: { value: 'x' } });
    const s = store.getState();
    expect(s.x).toBe('Y:A');
    expect(s.ys).toEqual(['X:PV', 'Y:B']);
    expect(s.labels).toEqual({ 'Y:A': 'Alpha' });
  });

  it('disables Y for the X card when Y is full, with the shared refusal as reason', () => {
    const state = makeState({ ys: fullYs });
    const store = mount(state, item('x', 'X:PV'));
    const option = screen.getByRole('option', {
      name: `Y (${yFullMessage()})`,
    }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(option.title).toBe(yFullMessage());
    act(() => {
      fireEvent.change(byId('role')!, { target: { value: 'y' } });
    });
    expect(store.getState().ys).toEqual(fullYs);
  });

  it('correlationMoveRefusal is the one rule the binding reuses', () => {
    const state = makeState({ ys: fullYs, trigger: { mode: 'pv', pv: 'T:PV' } });
    expect(correlationMoveRefusal(state, correlationItemId('x', 'X:PV'), 'y')).toBe(yFullMessage());
    expect(correlationMoveRefusal(state, correlationItemId('trig', 'T:PV'), 'y')).toBe(
      yFullMessage()
    );
    expect(correlationMoveRefusal(state, correlationItemId('y', 'Y:0'), 'x')).toBeNull();
    expect(correlationMoveRefusal(state, correlationItemId('y', 'Y:0'), 'y')).toBeNull();
    expect(correlationMoveRefusal(state, 'bogus', 'y')).toBeNull();
  });

  it('item ids round-trip, PV colons included', () => {
    expect(parseCorrelationItemId(correlationItemId('y', 'SIM:C:1'))).toEqual({
      role: 'y',
      pv: 'SIM:C:1',
    });
    expect(parseCorrelationItemId('z:PV')).toBeNull();
    expect(parseCorrelationItemId('y:')).toBeNull();
  });
});
