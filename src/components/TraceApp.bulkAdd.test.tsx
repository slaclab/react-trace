// @vitest-environment jsdom
//
// Bulk add from the Search PVs dialog (#43): the dialog opens for the right
// plot, every chosen PV becomes a trace in one update, and each trace then
// moves to its units axis through the same lookup a PV picked in Properties
// gets, including the guard against an answer that lands after the user moved
// the trace.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import {
  captured,
  currentPlots,
  flushMicrotasks,
  renders,
  resetHarness,
} from '../test/traceAppHarness';
import { TraceApp } from './TraceApp';

interface MetadataCall {
  pv: string;
  archiver: string | undefined;
  signal: AbortSignal;
  resolve: (units: string) => void;
  reject: (err: Error) => void;
}

const { metadataCalls } = vi.hoisted(() => ({ metadataCalls: [] as MetadataCall[] }));

// Signature-agnostic (pv, archiver, signal are the last three arguments), so it
// survives a leading connection argument.
vi.mock('../api/mole', () => ({
  fetchMetadata: (...args: unknown[]) => {
    const [pv, archiver, signal] = args.slice(-3) as [string, string | undefined, AbortSignal];
    return new Promise((resolve, reject) => {
      metadataCalls.push({ pv, archiver, signal, resolve: (units) => resolve({ units }), reject });
      signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      );
    });
  },
  fetchData: () => new Promise(() => {}),
  searchPVs: () => new Promise(() => {}),
}));
vi.mock('./Toolbar', async () => (await import('../test/traceAppHarness')).mocks.Toolbar);
vi.mock('./LeftPanel', async () => (await import('../test/traceAppHarness')).mocks.LeftPanel);
vi.mock('./PlotArea', async () => (await import('../test/traceAppHarness')).mocks.PlotArea);
vi.mock('./RightPanel', async () => (await import('../test/traceAppHarness')).mocks.RightPanel);
vi.mock(
  './PVSearchModal',
  async () => (await import('../test/traceAppHarness')).mocks.PVSearchModal
);
vi.mock(
  '../hooks/useElogConfig',
  async () => (await import('../test/traceAppHarness')).mocks.useElogConfig
);
vi.mock('../io/download', async () => (await import('../test/traceAppHarness')).mocks.download);

// What the dialog does on Add PVs.
function addPvs(plotId: string, pvs: string[]) {
  act(() => captured.pvSearchModal!.onAdd(plotId, pvs));
}

async function resolveLookup(index: number, units: string) {
  await act(async () => {
    metadataCalls[index].resolve(units);
    await flushMicrotasks();
  });
}

// The first plot's axes by name and its traces as pv@axis name.
function layout() {
  const p = currentPlots()[0];
  const axisName = (id: string) => p.axes.find((a) => a.id === id)?.name ?? '?';
  return {
    axes: p.axes.map((a) => a.name),
    traces: p.traces.map((t) => `${t.pvName}@${axisName(t.axisId)}`),
  };
}

beforeEach(() => {
  resetHarness();
  metadataCalls.length = 0;
  // New traces stream live data; without a WebSocket the live store stays idle.
  vi.stubGlobal('WebSocket', undefined);
  render(<TraceApp />);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TraceApp bulk add from the Search PVs dialog', () => {
  it('opens for the active plot from the toolbar and for a chosen plot from Layers', () => {
    expect(captured.pvSearchModal!.open).toBe(false);

    act(() => captured.plotArea!.onAddPlot());
    const newPlotId = currentPlots()[1].id;

    act(() => captured.toolbar!.onSearchPvs());
    expect(captured.pvSearchModal!.open).toBe(true);
    expect(captured.pvSearchModal!.initialPlotId).toBe(newPlotId);

    act(() => captured.pvSearchModal!.onClose());
    expect(captured.pvSearchModal!.open).toBe(false);

    act(() => captured.leftPanel!.onSearchPvs('plot-1'));
    expect(captured.pvSearchModal!.open).toBe(true);
    expect(captured.pvSearchModal!.initialPlotId).toBe('plot-1');
  });

  it('adds every chosen PV as a trace in one update, selects the last, and closes', () => {
    act(() => captured.toolbar!.onSearchPvs());
    const rendersBefore = renders.plotArea.length;
    addPvs('plot-1', ['PV:A', 'PV:B', 'PV:C']);

    const p = currentPlots()[0];
    expect(p.traces.map((t) => t.pvName)).toEqual(['PV:A', 'PV:B', 'PV:C']);
    expect(new Set(p.traces.map((t) => t.id)).size).toBe(3);
    expect(new Set(p.traces.map((t) => t.color)).size).toBe(3);
    for (const t of p.traces) {
      expect(t.axisId).toBe('y-axis-1');
      expect(t.useLive).toBe(true);
      expect(t.useArchive).toBe(true);
      expect(t.displayName).toBe('');
    }
    // One state update: no frame showed a partial set of traces.
    const traceCounts = renders.plotArea
      .slice(rendersBefore)
      .map((props) => props.plots[0].traces.length);
    expect(traceCounts).not.toContain(1);
    expect(traceCounts).not.toContain(2);

    expect(captured.pvSearchModal!.open).toBe(false);
    expect(captured.rightPanel!.selectedItem).toEqual({
      type: 'trace',
      id: p.traces[2].id,
      plotId: 'plot-1',
    });
    expect(metadataCalls.map((c) => c.pv)).toEqual(['PV:A', 'PV:B', 'PV:C']);
  });

  it("looks units up on the plot's archiver", () => {
    act(() => captured.rightPanel!.onUpdatePlot({ archiver: 'facet' }));
    addPvs('plot-1', ['PV:A']);
    expect(metadataCalls[0].archiver).toBe('facet');
  });

  it('ignores blank and repeated names', () => {
    addPvs('plot-1', [' PV:A ', 'PV:A', '', 'PV:B']);
    expect(currentPlots()[0].traces.map((t) => t.pvName)).toEqual(['PV:A', 'PV:B']);
  });

  it('puts PVs with the same units on one shared axis', async () => {
    addPvs('plot-1', ['PV:A', 'PV:B']);
    await resolveLookup(0, 'mA');
    await resolveLookup(1, 'mA');
    expect(layout()).toEqual({ axes: ['Y-Axis 1', 'mA'], traces: ['PV:A@mA', 'PV:B@mA'] });
  });

  it('gives different units their own axes on alternating sides', async () => {
    addPvs('plot-1', ['PV:A', 'PV:B']);
    await resolveLookup(1, 'kV');
    await resolveLookup(0, 'mA');
    expect(layout()).toEqual({
      axes: ['Y-Axis 1', 'kV', 'mA'],
      traces: ['PV:A@mA', 'PV:B@kV'],
    });
    expect(currentPlots()[0].axes.map((a) => a.orientation)).toEqual(['left', 'right', 'left']);
  });

  it('leaves a trace where the user moved it when its lookup lands later', async () => {
    addPvs('plot-1', ['PV:A', 'PV:B']);
    act(() => captured.leftPanel!.onAddAxis('plot-1'));
    const p = currentPlots()[0];
    act(() => captured.leftPanel!.onMoveTrace('plot-1', p.traces[0].id, 'plot-1', p.axes[1].id));

    await resolveLookup(0, 'mA');
    await resolveLookup(1, 'mA');
    expect(layout()).toEqual({
      axes: ['Y-Axis 1', 'Y-Axis 2', 'mA'],
      traces: ['PV:A@Y-Axis 2', 'PV:B@mA'],
    });
  });

  it('keeps a trace put when its units lookup fails', async () => {
    addPvs('plot-1', ['PV:A']);
    await act(async () => {
      metadataCalls[0].reject(new Error('no metadata'));
      await flushMicrotasks();
    });
    expect(layout()).toEqual({ axes: ['Y-Axis 1'], traces: ['PV:A@Y-Axis 1'] });
  });
});
