// @vitest-environment jsdom
//
// Bulk add from the Search PVs dialog (#43): the dialog opens for the right
// plot, every chosen PV becomes a trace in one update, and each trace then
// moves to its units axis through the same lookup a PV picked in Properties
// gets, including the guard against an answer that lands after the user moved
// the trace. The dialog opens from the actions bar and from the Signals pane's
// add row; the Signals pane shows the active plot, so "a chosen plot" is the
// one made active first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  actionButton,
  captured,
  currentPlots,
  flushMicrotasks,
  loadWorkspace,
  moveCurve,
  plot,
  axis,
  renders,
  resetHarness,
  signalsSearchPvs,
  workspace,
} from '../test/traceAppHarness';
import { WithCanopy } from '../test/canopy';
import { colorForIndex, getPalette } from '../palettes';
import { PV_CURVE_ITEM_KIND } from '../tools/trace/schema/curve';
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
vi.mock('@slaclab/canopy-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slaclab/canopy-client')>()),
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
  listArchivers: () => new Promise(() => {}),
  searchPVs: () => new Promise(() => {}),
}));
vi.mock('./PlotArea', async (importOriginal) =>
  (await import('../test/traceAppHarness')).mocks.PlotArea(await importOriginal())
);
vi.mock('../workbench/WorkbenchLayout', async (importOriginal) =>
  (await import('../test/traceAppHarness')).mocks.WorkbenchLayout(await importOriginal())
);
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

// The workbench selection (what Properties shows).
const selected = () => captured.layout!.selection.get().selection;

// A plot setting written through the tool's writer, as a Properties field does.
function setPlot(plotId: string, patch: { archiver?: string; palette?: string }) {
  act(() =>
    captured.layout!.update((s) => ({
      ...s,
      plots: s.plots.map((p) => (p.id === plotId ? { ...p, ...patch } : p)),
    }))
  );
}

beforeEach(() => {
  resetHarness();
  metadataCalls.length = 0;
  // New traces stream live data; without a WebSocket the live store stays idle.
  vi.stubGlobal('WebSocket', undefined);
  render(<TraceApp />, { wrapper: WithCanopy });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TraceApp bulk add from the Search PVs dialog', () => {
  it('opens for the active plot from the actions bar and from the Signals add row', () => {
    expect(captured.pvSearchModal!.open).toBe(false);

    act(() => captured.plotArea!.onAddPlot());
    const newPlotId = currentPlots()[1].id;

    fireEvent.click(actionButton('Search PVs'));
    expect(captured.pvSearchModal!.open).toBe(true);
    expect(captured.pvSearchModal!.initialPlotId).toBe(newPlotId);

    act(() => captured.pvSearchModal!.onClose());
    expect(captured.pvSearchModal!.open).toBe(false);

    act(() => captured.plotArea!.onSetActivePlot('plot-1'));
    fireEvent.click(signalsSearchPvs());
    expect(captured.pvSearchModal!.open).toBe(true);
    expect(captured.pvSearchModal!.initialPlotId).toBe('plot-1');
  });

  it('adds every chosen PV as a trace in one update, selects the last, and closes', () => {
    fireEvent.click(actionButton('Search PVs'));
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
    expect(captured.plotArea!.activePlotId).toBe('plot-1');
    expect(selected()).toEqual({ level: 'item', kind: PV_CURVE_ITEM_KIND, id: p.traces[2].id });
    expect(metadataCalls.map((c) => c.pv)).toEqual(['PV:A', 'PV:B', 'PV:C']);
  });

  it("looks units up on the plot's archiver", () => {
    setPlot('plot-1', { archiver: 'arch-b' });
    addPvs('plot-1', ['PV:A']);
    expect(metadataCalls[0].archiver).toBe('arch-b');
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
    fireEvent.click(screen.getByRole('button', { name: 'Add axis' }));
    const p = currentPlots()[0];
    moveCurve(p.traces[0].id, p.axes[1].id);

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

  it("adds to a plot that is not the active one: that plot's palette, then it is activated and its last curve selected", () => {
    setPlot('plot-1', { palette: 'viridis' });
    act(() => captured.plotArea!.onAddPlot());
    expect(captured.plotArea!.activePlotId).not.toBe('plot-1');

    addPvs('plot-1', ['PV:A', 'PV:B']);
    const [p1, p2] = currentPlots();
    expect(p1.traces.map((t) => t.pvName)).toEqual(['PV:A', 'PV:B']);
    expect(p2.traces).toEqual([]);
    const viridis = getPalette('viridis');
    expect(p1.traces.map((t) => t.color)).toEqual([
      colorForIndex(viridis, 0),
      colorForIndex(viridis, 1),
    ]);
    expect(captured.plotArea!.activePlotId).toBe('plot-1');
    // Activating a plot resets the selection; the queued select lands after it.
    expect(selected()).toEqual({ level: 'item', kind: PV_CURVE_ITEM_KIND, id: p1.traces[1].id });
  });

  it('aborts the units lookups of the added traces when a workspace loads', async () => {
    addPvs('plot-1', ['PV:A', 'PV:B']);
    expect(metadataCalls.map((c) => c.signal.aborted)).toEqual([false, false]);

    await loadWorkspace(workspace([plot('plot-1', [axis('axis-1', 'Y')], [])]));
    expect(metadataCalls.map((c) => c.signal.aborted)).toEqual([true, true]);
  });
});
