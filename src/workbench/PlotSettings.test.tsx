// @vitest-environment jsdom
//
// The plot-wide half of the properties panel against the stub tool:
// the tool-level tabs as collapsible sections in declared order,
// closed by default, each header the title plus the tab's `summary(ctx)`; the
// tool-level `code` tab as the "Show chart source" link, not a section; the
// Axes section holding one sub-block per `placement: 'axes'` section (heading
// title and unit, `ctx.target` that section); a section selection opening Axes
// and marking its sub-block; open state kept in the panel's OpenMemory across
// an unmount.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useSyncExternalStore, type ReactNode } from 'react';

import {
  createStubTool,
  referenceField,
  section,
  stubToolSummary,
  titleField,
  toolCodeField,
  withSections,
  type StubModel,
  type StubState,
  type StubTool,
  type StubUi,
} from './__fixtures__/stubTool';
import { PanelHarness } from './__fixtures__/PanelHarness';
import { OpenMemoryProvider } from './FieldBlock';
import { OpenMemory } from './openMemory';
import { PlotSettings } from './PlotSettings';
import { AXES_TAB, CODE_TAB, plotSectionKey } from './plotSettingsKeys';
import { SelectionProvider, createSelectionStore, type SelectionStore } from './selection';
import type { FieldDef, ToolDefinition } from './types';

// ---------------------------------------------------------------- harness --

type StubDefinition = ToolDefinition<StubState, StubModel, StubUi>;

const axesNote = {
  id: 'stub-axes-note',
  label: 'X axis',
  kind: 'readonly',
  tab: 'axes',
  level: 'L1',
  get: () => 'index',
} as FieldDef<StubState, StubModel, StubUi>;

/** The stub with the plot-wide sections the tools declare, then the chart source. */
function plotTabs(definition: StubDefinition): StubDefinition {
  const code = definition.schema.tool.tabs.find((t) => t.id === CODE_TAB)!;
  return {
    ...definition,
    schema: {
      ...definition.schema,
      tool: {
        tabs: [
          code,
          {
            id: 'acquisition',
            label: 'Acquisition',
            fields: [referenceField],
            summary: stubToolSummary,
          },
          { id: AXES_TAB, label: 'Axes', fields: [axesNote], summary: () => 'X index' },
          { id: 'display', label: 'Display', fields: [titleField] },
        ],
      },
    },
  };
}

function Harness({
  tool,
  definition,
  toolId,
}: {
  tool: StubTool;
  definition: StubDefinition;
  toolId?: string;
}) {
  const state = useSyncExternalStore(tool.subscribe, () => tool.getState());
  const model = useSyncExternalStore(tool.subscribe, () => tool.getModel());
  return (
    <PlotSettings
      definition={definition}
      state={state}
      model={model}
      ui={tool.getUi()}
      update={tool.update}
      capabilities={tool.capabilities}
      toolId={toolId}
    />
  );
}

interface MountOptions {
  definition?: (tool: StubTool) => StubDefinition;
  store?: SelectionStore;
  memory?: OpenMemory;
  toolId?: string;
  tool?: StubTool;
}

function mount(options: MountOptions = {}) {
  const tool = options.tool ?? createStubTool();
  const store = options.store ?? createSelectionStore();
  const definition = (options.definition ?? ((t: StubTool) => plotTabs(t.definition)))(tool);
  const inner = <Harness tool={tool} definition={definition} toolId={options.toolId} />;
  const wrap = (children: ReactNode) =>
    options.memory ? (
      <OpenMemoryProvider memory={options.memory}>{children}</OpenMemoryProvider>
    ) : (
      children
    );
  render(<SelectionProvider store={store}>{wrap(inner)}</SelectionProvider>);
  return { tool, store };
}

/** Both stub sections placed in Axes. */
const axesPlaced = (tool: StubTool) =>
  plotTabs(
    withSections(tool.definition, {
      signals: { placement: 'axes' },
      locked: { placement: 'axes' },
    })
  );

const sectionEl = (id: string) =>
  document.querySelector(`.wb-plot-section[data-section="${id}"]`) as HTMLElement | null;
const headOf = (id: string) =>
  sectionEl(id)!.querySelector('.wb-plot-section__head') as HTMLButtonElement;
const bodyOf = (id: string) => sectionEl(id)!.querySelector('.wb-plot-section__body');
const axesBlock = (id: string) =>
  document.querySelector(`.wb-axes-block[data-axes-section="${id}"]`) as HTMLElement | null;
const fieldIn = (root: Element, id: string) => root.querySelector(`[data-field="${id}"]`);

afterEach(() => {
  cleanup();
});

// --------------------------------------------------------------- sections --

describe('plot-wide sections', () => {
  it('renders the tool-level tabs as sections in declared order, the code tab left out', () => {
    mount();
    const ids = [...document.querySelectorAll('.wb-plot-section')].map((s) =>
      s.getAttribute('data-section')
    );
    expect(ids).toEqual(['acquisition', 'axes', 'display']);
    expect(sectionEl(CODE_TAB)).toBeNull();
    expect(screen.getByLabelText('Plot settings')).toBeTruthy();
  });

  it('starts every section closed, its header the title and the summary', () => {
    mount();
    for (const id of ['acquisition', 'axes', 'display']) {
      expect(headOf(id).getAttribute('aria-expanded')).toBe('false');
      expect(bodyOf(id)).toBeNull();
    }
    expect(headOf('acquisition').querySelector('.wb-plot-section__title')!.textContent).toBe(
      'Acquisition'
    );
    expect(headOf('acquisition').querySelector('.wb-plot-section__summary')!.textContent).toBe(
      'no reference'
    );
    expect(headOf('axes').querySelector('.wb-plot-section__summary')!.textContent).toBe('X index');
    // No summary, no summary element.
    expect(headOf('display').querySelector('.wb-plot-section__summary')).toBeNull();
    expect(document.getElementById(titleField.id)).toBeNull();
  });

  it('the header toggles its section; the fields carry their #id', () => {
    mount();
    fireEvent.click(headOf('display'));
    expect(headOf('display').getAttribute('aria-expanded')).toBe('true');
    expect(sectionEl('display')!.classList.contains('wb-plot-section--open')).toBe(true);
    expect(within(bodyOf('display') as HTMLElement).getByRole('textbox')).toBe(
      document.getElementById(titleField.id)
    );
    // The others stay closed.
    expect(bodyOf('acquisition')).toBeNull();
    fireEvent.click(headOf('display'));
    expect(bodyOf('display')).toBeNull();
  });

  it('a field writes at tool level and the summary follows the state', () => {
    const { tool } = mount();
    fireEvent.click(headOf('display'));
    fireEvent.change(document.getElementById(titleField.id)!, { target: { value: 'Orbit' } });
    expect(tool.getState().title).toBe('Orbit');
    act(() => tool.update((s) => ({ ...s, reference: 'TEST:REF' })));
    expect(headOf('acquisition').querySelector('.wb-plot-section__summary')!.textContent).toBe(
      'ref TEST:REF'
    );
  });

  it('hands the plot-wide fields the tool-level target', () => {
    let seen: unknown = null;
    const probe = {
      ...axesNote,
      id: 'probe',
      get: (ctx: { target: unknown }) => {
        seen = ctx.target;
        return '';
      },
    } as FieldDef<StubState, StubModel, StubUi>;
    mount({
      toolId: 'stub',
      definition: (tool) => {
        const def = plotTabs(tool.definition);
        return {
          ...def,
          schema: {
            ...def.schema,
            tool: {
              tabs: def.schema.tool.tabs.map((t) =>
                t.id === 'display' ? { ...t, fields: [probe] } : t
              ),
            },
          },
        };
      },
    });
    fireEvent.click(headOf('display'));
    expect(seen).toEqual({ level: 'tool', kind: 'stub', id: 'stub' });
  });
});

// ----------------------------------------------------------- chart source --

describe('chart source', () => {
  it('is a "Show chart source" link that toggles the code fields', () => {
    mount();
    const link = screen.getByRole('button', { name: 'Show chart source' });
    expect(link.getAttribute('aria-expanded')).toBe('false');
    expect(fieldIn(document.body, toolCodeField.id)).toBeNull();
    // After the plot-wide sections.
    expect(
      sectionEl('display')!.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    fireEvent.click(link);
    expect(link.getAttribute('aria-expanded')).toBe('true');
    expect(link.textContent).toBe('Hide chart source');
    expect(fieldIn(document.body, toolCodeField.id)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Hide chart source' }));
    expect(fieldIn(document.body, toolCodeField.id)).toBeNull();
  });

  it('is absent without a tool-level code tab', () => {
    mount({
      definition: (tool) => {
        const def = plotTabs(tool.definition);
        return {
          ...def,
          schema: {
            ...def.schema,
            tool: { tabs: def.schema.tool.tabs.filter((t) => t.id !== CODE_TAB) },
          },
        };
      },
    });
    expect(screen.queryByRole('button', { name: /chart source/ })).toBeNull();
  });
});

// ------------------------------------------------------------------- axes --

describe('the Axes section', () => {
  it('holds one sub-block per axes-placed section after its own fields, titled with name and unit', () => {
    mount({ definition: axesPlaced });
    fireEvent.click(headOf('axes'));
    const body = bodyOf('axes') as HTMLElement;
    const signals = axesBlock('signals')!;
    const locked = axesBlock('locked')!;
    expect(body.contains(signals) && body.contains(locked)).toBe(true);
    expect(
      fieldIn(body, axesNote.id)!.compareDocumentPosition(signals) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(signals.compareDocumentPosition(locked) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const heading = signals.querySelector('.wb-axes-block__heading')!;
    expect(heading.textContent).toBe('Signalsmm');
    expect(heading.querySelector('.wb-axes-block__unit')!.textContent).toBe('mm');
    expect(locked.querySelector('.wb-axes-block__heading')!.textContent).toBe('Locked');
    expect(locked.querySelector('.wb-axes-block__unit')).toBeNull();
  });

  it("hands each sub-block's fields that section as ctx.target", () => {
    const { tool } = mount({ definition: axesPlaced });
    fireEvent.click(headOf('axes'));
    // The section's count reads its own section.
    expect(axesBlock('signals')!.querySelector('output')!.textContent).toBe('2');
    expect(axesBlock('locked')!.querySelector('output')!.textContent).toBe('1');
    // A field writes its own section.
    fireEvent.click(within(axesBlock('locked')!).getByRole('switch'));
    expect(tool.getState().sectionVisible).toEqual({ signals: true, locked: false });
  });

  it('keeps #ids unique across sub-blocks: the first bare, later ones suffixed with their section', () => {
    mount({ definition: axesPlaced });
    fireEvent.click(headOf('axes'));
    // The field hooks only: React's generated label ids are not hooks.
    const idsIn = (el: Element) =>
      [...el.querySelectorAll('.wb-field [id]')]
        .filter((node) =>
          node.id.startsWith(node.closest<HTMLElement>('.wb-field')!.dataset.field!)
        )
        .map((node) => node.id);
    const first = idsIn(axesBlock('signals')!);
    const second = idsIn(axesBlock('locked')!);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(first.every((id) => !id.includes('--'))).toBe(true);
    expect(second.every((id) => id.includes('--locked'))).toBe(true);
    const all = idsIn(bodyOf('axes')!);
    expect(new Set(all).size).toBe(all.length);
  });

  it('holds no sub-block for a section placed under its cards', () => {
    mount({
      definition: (tool) =>
        plotTabs(withSections(tool.definition, { locked: { placement: 'axes' } })),
    });
    fireEvent.click(headOf('axes'));
    expect(axesBlock('locked')).not.toBeNull();
    expect(axesBlock('signals')).toBeNull();
  });

  it('a section selection opens Axes and marks its sub-block selected', () => {
    const store = createSelectionStore();
    mount({ definition: axesPlaced, store });
    expect(headOf('axes').getAttribute('aria-expanded')).toBe('false');
    act(() => store.select(section('locked')));
    expect(headOf('axes').getAttribute('aria-expanded')).toBe('true');
    expect(axesBlock('locked')!.classList.contains('wb-axes-block--selected')).toBe(true);
    expect(axesBlock('signals')!.classList.contains('wb-axes-block--selected')).toBe(false);
    // The other sections stay closed.
    expect(bodyOf('display')).toBeNull();
  });

  it('an initial section selection opens Axes at mount', () => {
    mount({ definition: axesPlaced, store: createSelectionStore({ initial: section('signals') }) });
    expect(headOf('axes').getAttribute('aria-expanded')).toBe('true');
    expect(axesBlock('signals')!.classList.contains('wb-axes-block--selected')).toBe(true);
  });

  it('the user may close Axes while its section stays selected', () => {
    const store = createSelectionStore();
    mount({ definition: axesPlaced, store });
    act(() => store.select(section('locked')));
    fireEvent.click(headOf('axes'));
    expect(headOf('axes').getAttribute('aria-expanded')).toBe('false');
    expect(store.get().selection).toEqual(section('locked'));
  });

  it('a selection of a section placed under its cards does not open Axes', () => {
    const store = createSelectionStore();
    mount({
      definition: (tool) =>
        plotTabs(withSections(tool.definition, { locked: { placement: 'axes' } })),
      store,
    });
    act(() => store.select(section('signals')));
    expect(headOf('axes').getAttribute('aria-expanded')).toBe('false');
  });
});

// ----------------------------------------------------------------- memory --

describe('open state', () => {
  it("survives an unmount and remount under the same OpenMemory (the panel's)", () => {
    const memory = new OpenMemory();
    const tool = createStubTool();
    mount({ tool, memory, toolId: 'stub' });
    fireEvent.click(headOf('display'));
    fireEvent.click(screen.getByRole('button', { name: 'Show chart source' }));
    cleanup();

    mount({ tool, memory, toolId: 'stub' });
    expect(headOf('display').getAttribute('aria-expanded')).toBe('true');
    expect(headOf('acquisition').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: 'Hide chart source' })).toBeTruthy();
    expect(memory.get(plotSectionKey('stub', 'display'), false)).toBe(true);
    cleanup();

    // Another tool keeps its own flags.
    mount({ tool, memory, toolId: 'other' });
    expect(headOf('display').getAttribute('aria-expanded')).toBe('false');
  });

  it('without an OpenMemory a remount starts closed', () => {
    const tool = createStubTool();
    mount({ tool });
    fireEvent.click(headOf('display'));
    cleanup();
    mount({ tool });
    expect(headOf('display').getAttribute('aria-expanded')).toBe('false');
  });

  it('the panel harness opens the sections it names (all by default)', () => {
    const tool = createStubTool();
    const definition = plotTabs(tool.definition);
    const harness = (open?: readonly string[]) => (
      <SelectionProvider store={createSelectionStore()}>
        <PanelHarness
          definition={definition}
          state={tool.getState()}
          model={tool.getModel()}
          ui={tool.getUi()}
          update={tool.update}
          capabilities={tool.capabilities}
          open={open}
        />
      </SelectionProvider>
    );
    render(harness());
    expect(document.querySelector('.wb-panel > .wb-outline + .wb-plot')).not.toBeNull();
    for (const id of ['acquisition', 'axes', 'display']) {
      expect(headOf(id).getAttribute('aria-expanded')).toBe('true');
    }
    cleanup();
    render(harness(['axes']));
    expect(headOf('axes').getAttribute('aria-expanded')).toBe('true');
    expect(headOf('display').getAttribute('aria-expanded')).toBe('false');
  });
});
