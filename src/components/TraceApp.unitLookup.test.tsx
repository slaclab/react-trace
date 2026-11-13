// @vitest-environment jsdom
//
// Units lookups (assignTraceToUnitAxis) across a workspace load (#91). Trace and
// axis ids repeat across workspaces (`trace-1`, `axis-1`, `plot-1`), so a lookup
// started in the outgoing workspace must not land on the incoming one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import {
  alertMock,
  axis,
  captured,
  currentPlots,
  flushMicrotasks,
  loadWorkspace,
  plot,
  pvTrace,
  resetHarness,
  workspace,
} from '../test/traceAppHarness';
import { TraceApp } from './TraceApp';

interface MetadataCall {
  pv: string;
  signal: AbortSignal;
  resolve: (units: string) => void;
}

const { metadataCalls } = vi.hoisted(() => ({ metadataCalls: [] as MetadataCall[] }));

// Signature-agnostic (pv, archiver, signal are the last three arguments), so it
// survives a leading connection argument.
vi.mock('../api/mole', () => ({
  fetchMetadata: (...args: unknown[]) => {
    const [pv, , signal] = args.slice(-3) as [string, unknown, AbortSignal];
    return new Promise((resolve, reject) => {
      metadataCalls.push({ pv, signal, resolve: (units) => resolve({ units }) });
      signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      );
    });
  },
  fetchData: () => new Promise(() => {}),
}));
vi.mock('./Toolbar', async () => (await import('../test/traceAppHarness')).mocks.Toolbar);
vi.mock('./LeftPanel', async () => (await import('../test/traceAppHarness')).mocks.LeftPanel);
vi.mock('./PlotArea', async () => (await import('../test/traceAppHarness')).mocks.PlotArea);
vi.mock('./RightPanel', async () => (await import('../test/traceAppHarness')).mocks.RightPanel);
vi.mock(
  '../hooks/useElogConfig',
  async () => (await import('../test/traceAppHarness')).mocks.useElogConfig
);
vi.mock('../io/download', async () => (await import('../test/traceAppHarness')).mocks.download);

// One plot whose single trace sits on a unit-less "Y" axis.
function singleTrace(pvName: string): string {
  return workspace([plot('plot-1', [axis('axis-1', 'Y')], [pvTrace('trace-1', pvName)])]);
}

// What RightPanel does when the user picks a PV: commit the name, then ask for
// the units-based axis assignment.
function selectPv(traceId: string, pvName: string) {
  const panel = captured.rightPanel!;
  act(() => {
    panel.onUpdateTrace(traceId, { pvName });
    panel.onSelectPv(traceId, pvName);
  });
}

async function resolveLookup(index: number, units: string) {
  await act(async () => {
    metadataCalls[index].resolve(units);
    await flushMicrotasks();
  });
}

function layout() {
  const p = currentPlots()[0];
  return {
    axes: p.axes.map((a) => a.name),
    traces: p.traces.map((t) => `${t.id}:${t.pvName}@${t.axisId}`),
  };
}

beforeEach(() => {
  resetHarness();
  metadataCalls.length = 0;
  render(<TraceApp />);
});

afterEach(() => cleanup());

describe('TraceApp units lookup across a workspace load', () => {
  it('moves the trace onto a units axis when nothing intervenes', async () => {
    await loadWorkspace(singleTrace('OLD:PV'));
    selectPv('trace-1', 'NEXT:PV');
    await resolveLookup(0, 'mA');

    const p = currentPlots()[0];
    expect(p.axes.map((a) => a.name)).toEqual(['Y', 'mA']);
    expect(p.traces[0].axisId).toBe(p.axes[1].id);
  });

  it("leaves the loaded workspace's layout alone when an older lookup resolves", async () => {
    await loadWorkspace(singleTrace('OLD:PV'));
    selectPv('trace-1', 'SHARED:PV');
    // The incoming workspace reuses every id and even the PV name, so only the
    // abort on load can tell the late answer apart.
    await loadWorkspace(singleTrace('SHARED:PV'));
    await resolveLookup(0, 'mA');

    expect(layout()).toEqual({ axes: ['Y'], traces: ['trace-1:SHARED:PV@axis-1'] });
  });

  it('aborts the pending lookup request on load', async () => {
    await loadWorkspace(singleTrace('OLD:PV'));
    selectPv('trace-1', 'OLD:PV2');
    expect(metadataCalls[0].signal.aborted).toBe(false);

    await loadWorkspace(singleTrace('NEW:PV'));

    expect(metadataCalls[0].signal.aborted).toBe(true);
    expect(layout()).toEqual({ axes: ['Y'], traces: ['trace-1:NEW:PV@axis-1'] });
  });

  it('ignores a lookup that resolves after the trace switched to another PV', async () => {
    await loadWorkspace(singleTrace('OLD:PV'));
    selectPv('trace-1', 'FIRST:PV');
    act(() => captured.rightPanel!.onUpdateTrace('trace-1', { pvName: 'OTHER:PV' }));
    await resolveLookup(0, 'mA');

    expect(layout()).toEqual({ axes: ['Y'], traces: ['trace-1:OTHER:PV@axis-1'] });
  });

  it('keeps pending lookups when the file fails to parse', async () => {
    await loadWorkspace(singleTrace('OLD:PV'));
    selectPv('trace-1', 'NEXT:PV');
    await loadWorkspace('not json', 'broken.trc.json');

    expect(alertMock).toHaveBeenCalledWith(expect.stringMatching(/^Failed to import/));
    expect(metadataCalls[0].signal.aborted).toBe(false);
    await resolveLookup(0, 'mA');
    expect(layout().axes).toEqual(['Y', 'mA']);
  });

  it('aborts pending lookups on unmount', async () => {
    await loadWorkspace(singleTrace('OLD:PV'));
    selectPv('trace-1', 'NEXT:PV');

    cleanup();

    expect(metadataCalls[0].signal.aborted).toBe(true);
  });
});
