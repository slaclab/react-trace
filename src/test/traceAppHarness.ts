// Scaffolding for tests that mount the real <TraceApp> and drive it the way a
// user does: the workbench actions bar (Import, Save), the properties pane
// (the curve card's PV name) and the props PlotArea receives. Import it
// BEFORE TraceApp: the browser stubs below must exist when the colour-mode store and
// paletteStore read localStorage at module load.
//
// `vi.mock` is hoisted per test file, so each file declares its own mocks and
// points the factories here, e.g.
//
//   vi.mock('./PlotArea', async (importOriginal) =>
//     (await import('../test/traceAppHarness')).mocks.PlotArea(await importOriginal()));
//
// PlotArea is replaced by a stub that renders nothing (so no chart mounts)
// and records its props in `captured.plotArea`, which is how tests read the
// plots and result maps TraceApp renders. WorkbenchLayout renders for real;
// its latest props are kept in `captured.layout`, which gives tests the
// selection store and the tool's single writer.
import { act, fireEvent, screen, within } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import { vi } from 'vitest';
import type { PlotArea } from '../components/PlotArea';
import { PV_CURVE_ITEM_KIND, patchCurve } from '../tools/trace/schema/curve';
import type { TraceState } from '../tools/trace/tool';
import type { Axis, Plot, PVTrace } from '../types';
import type { SelectionStore } from '../workbench/selection';

// ── Browser stubs (jsdom lacks these; Node 25+ also shadows jsdom's storage) ──

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  };
}

Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true });

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// No backend: the PV search and any other request fail at once.
globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch;

// TraceApp reports import failures and warnings through alert().
export const alertMock = vi.fn();
window.alert = alertMock;

// ── Captured props ───────────────────────────────────────────────────────────

type PlotAreaProps = ComponentProps<typeof PlotArea>;

/** What the harness reads from WorkbenchLayout's props. */
export interface LayoutProps {
  state: TraceState;
  selection: SelectionStore;
  update(fn: (state: TraceState) => TraceState): void;
}

export interface Captured {
  plotArea: PlotAreaProps | null;
  layout: LayoutProps | null;
}

export const captured: Captured = { plotArea: null, layout: null };

// Every PlotArea render's props, oldest first, for assertions about intermediate frames.
export const renders: { plotArea: PlotAreaProps[] } = { plotArea: [] };

// ── File picker queue (stands in for ../io/download's pickFile) ──────────────

const pickQueue: File[] = [];

export function queueFile(name: string, text: string): void {
  // Only `name` and `text()` are read by TraceApp's import path.
  pickQueue.push({ name, text: () => Promise.resolve(text) } as unknown as File);
}

// Module bodies for the `vi.mock` factories.
export const mocks = {
  /** `./PlotArea` with PlotArea replaced by a recording stub; the rest is the real module. */
  PlotArea<M extends object>(actual: M): M {
    function RecordingPlotArea(props: PlotAreaProps) {
      captured.plotArea = props;
      renders.plotArea.push(props);
      return null;
    }
    return { ...actual, PlotArea: RecordingPlotArea };
  },
  /** `../workbench/WorkbenchLayout` rendering for real, its latest props recorded. */
  WorkbenchLayout<M extends object>(actual: M): M {
    const Real = (actual as { WorkbenchLayout: (props: object) => null }).WorkbenchLayout;
    function RecordingWorkbenchLayout(props: object) {
      captured.layout = props as LayoutProps;
      return createElement(Real, props);
    }
    return { ...actual, WorkbenchLayout: RecordingWorkbenchLayout };
  },
  useElogConfig: { useElogConfig: () => null },
  download: {
    pickFile: async () => pickQueue.shift() ?? null,
    downloadBlob: vi.fn(),
    downloadDataUrl: vi.fn(async () => {}),
  },
};

export function resetHarness(): void {
  captured.plotArea = null;
  captured.layout = null;
  renders.plotArea.length = 0;
  pickQueue.length = 0;
  alertMock.mockClear();
  mocks.download.downloadBlob.mockClear();
  mocks.download.downloadDataUrl.mockClear();
  window.localStorage.clear();
}

// ── Driving TraceApp ─────────────────────────────────────────────────────────

// Drain pending promise continuations without touching timers, so it behaves
// the same under real and fake timers.
export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// The plots TraceApp currently renders.
export function currentPlots(): Plot[] {
  if (!captured.plotArea) throw new Error('PlotArea has not rendered');
  return captured.plotArea.plots;
}

function layout(): LayoutProps {
  if (!captured.layout) throw new Error('WorkbenchLayout has not rendered');
  return captured.layout;
}

// The actions bar button whose accessible name starts with `label`.
export function actionButton(label: string): HTMLButtonElement {
  const toolbar = screen.getByRole('toolbar', { name: 'Tool actions' });
  return within(toolbar).getByRole('button', {
    name: (name) => name.startsWith(label),
  }) as HTMLButtonElement;
}

// Load a workspace through the actions bar's Import, as a user would.
export async function loadWorkspace(text: string, name = 'workspace.trc.json'): Promise<void> {
  queueFile(name, text);
  const button = actionButton('Import');
  await act(async () => {
    fireEvent.click(button);
    await flushMicrotasks();
  });
}

// Open the curve's card in the properties pane, as a click on its Layers row does.
export function selectCurve(traceId: string): void {
  const { selection } = layout();
  act(() => selection.select({ level: 'item', kind: PV_CURVE_ITEM_KIND, id: traceId }, 'user'));
}

// Commit a PV in the curve card's PV name field, as a user typing it and
// pressing Enter: the field stores the PV and starts the unit lookup.
export function commitPv(traceId: string, pvName: string): void {
  selectCurve(traceId);
  const input = document.getElementById('pv-name') as HTMLInputElement | null;
  if (!input) throw new Error('the properties pane shows no PV name field');
  act(() => {
    fireEvent.change(input, { target: { value: pvName } });
    fireEvent.keyDown(input, { key: 'Enter' });
  });
}

// Give a curve another PV through the tool's writer, without a unit lookup
// (any edit that is not the PV name field).
export function setCurvePv(traceId: string, pvName: string): void {
  const { update } = layout();
  act(() => update((state) => patchCurve(state, traceId, { pvName })));
}

// ── Workspace fixtures ───────────────────────────────────────────────────────

export function axis(id: string, name = 'Y', extra: Partial<Axis> = {}): Axis {
  return {
    id,
    name,
    orientation: 'left',
    autoScale: true,
    logScale: false,
    visible: true,
    ...extra,
  };
}

// Live and archive are off so no WebSocket or archive fetch is opened.
export function pvTrace(id: string, pvName: string, extra: Partial<PVTrace> = {}): PVTrace {
  return {
    id,
    kind: 'pv',
    pvName,
    displayName: '',
    color: '#4589ff',
    visible: true,
    axisId: 'axis-1',
    useLive: false,
    useArchive: false,
    lineWidth: 2,
    lineType: 'step',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'circle',
    symbolSize: 10,
    data: [],
    ...extra,
  };
}

export function formulaTrace(
  id: string,
  expression: string,
  bindings: Record<string, string>,
  extra: Partial<PVTrace> = {}
): PVTrace {
  return pvTrace(id, '', {
    kind: 'formula',
    displayName: expression,
    lineType: 'direct',
    expression,
    bindings,
    ...extra,
  });
}

export function plot(id: string, axes: Axis[], traces: PVTrace[], extra: Partial<Plot> = {}): Plot {
  return {
    id,
    title: id,
    backgroundColor: '#161616',
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
    axes,
    traces,
    ...extra,
  };
}

// A native-format workspace file's text.
export function workspace(plots: Plot[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    savedAt: '2026-10-01T00:00:00.000Z',
    theme: 'dark',
    plots,
  });
}
