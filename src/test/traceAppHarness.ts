// Scaffolding for tests that mount the real <TraceApp> with its panels mocked
// out. Import it BEFORE TraceApp: the browser stubs below must exist when
// paletteStore reads localStorage at module load.
//
// `vi.mock` is hoisted per test file, so each file declares its own mocks and
// points the factories here, e.g.
//
//   vi.mock('./Toolbar', async () => (await import('../test/traceAppHarness')).mocks.Toolbar);
//
// The mocked panels render nothing and record their latest props in `captured`,
// which is how tests read TraceApp state (`captured.plotArea.plots`) and drive
// it (`captured.toolbar.onImport()`, `captured.rightPanel.onSelectPv(...)`).
import { act } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { vi } from 'vitest';
import type { LeftPanel } from '../components/LeftPanel';
import type { PlotArea } from '../components/PlotArea';
import type { RightPanel } from '../components/RightPanel';
import type { Toolbar } from '../components/Toolbar';
import type { Axis, Plot, PVTrace } from '../types';

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

// TraceApp reports import failures and warnings through alert().
export const alertMock = vi.fn();
window.alert = alertMock;

// ── Captured panel props ─────────────────────────────────────────────────────

export interface Captured {
  toolbar: ComponentProps<typeof Toolbar> | null;
  leftPanel: ComponentProps<typeof LeftPanel> | null;
  plotArea: ComponentProps<typeof PlotArea> | null;
  rightPanel: ComponentProps<typeof RightPanel> | null;
}

export const captured: Captured = {
  toolbar: null,
  leftPanel: null,
  plotArea: null,
  rightPanel: null,
};

// Every render's props, oldest first, for assertions about intermediate frames.
export const renders: { [K in keyof Captured]: NonNullable<Captured[K]>[] } = {
  toolbar: [],
  leftPanel: [],
  plotArea: [],
  rightPanel: [],
};

function capture<K extends keyof Captured>(key: K) {
  return (props: NonNullable<Captured[K]>) => {
    captured[key] = props;
    renders[key].push(props);
    return null;
  };
}

// ── File picker queue (stands in for ../io/download's pickFile) ──────────────

const pickQueue: File[] = [];

export function queueFile(name: string, text: string): void {
  // Only `name` and `text()` are read by TraceApp's import path.
  pickQueue.push({ name, text: () => Promise.resolve(text) } as unknown as File);
}

// Module bodies for the `vi.mock` factories.
export const mocks = {
  Toolbar: { Toolbar: capture('toolbar') },
  LeftPanel: { LeftPanel: capture('leftPanel') },
  PlotArea: { PlotArea: capture('plotArea'), SinglePlot: () => null },
  RightPanel: { RightPanel: capture('rightPanel') },
  useElogConfig: { useElogConfig: () => null },
  download: {
    pickFile: async () => pickQueue.shift() ?? null,
    downloadBlob: vi.fn(),
    downloadDataUrl: vi.fn(async () => {}),
  },
};

export function resetHarness(): void {
  captured.toolbar = null;
  captured.leftPanel = null;
  captured.plotArea = null;
  captured.rightPanel = null;
  for (const list of Object.values(renders)) list.length = 0;
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

// Load a workspace through the toolbar's Open action, as a user would.
export async function loadWorkspace(text: string, name = 'workspace.trc.json'): Promise<void> {
  if (!captured.toolbar) throw new Error('Toolbar has not rendered');
  queueFile(name, text);
  const { onImport } = captured.toolbar;
  await act(async () => {
    onImport();
    await flushMicrotasks();
  });
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
    updateRate: 'monitor',
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
