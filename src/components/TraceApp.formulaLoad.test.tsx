// @vitest-environment jsdom
//
// Formula results across a workspace load (#91). Legacy .trc imports always
// produce `plot-1`/`trace-1`/`formula-1`, so the incoming workspace's formula
// shares an id with the outgoing one and must not inherit its points.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import {
  axis,
  formulaTrace,
  flushMicrotasks,
  loadWorkspace,
  plot,
  pvTrace,
  renders,
  resetHarness,
  workspace,
} from '../test/traceAppHarness';
import { TraceApp } from './TraceApp';

interface FoxCall {
  expression: string;
  settled: boolean;
  resolve: (value: number) => void;
}

const { foxCalls, plotAreaLifecycle } = vi.hoisted(() => ({
  foxCalls: [] as FoxCall[],
  plotAreaLifecycle: { mounts: 0, unmounts: 0 },
}));

// Signature-agnostic (spec, t0, t1, signal are the last four arguments), so it
// survives a leading connection argument. Calls stay pending until resolved.
vi.mock('../api/fox', () => ({
  evaluateFormula: (...args: unknown[]) => {
    const [spec, , t1Ns, signal] = args.slice(-4) as [
      { expression: string },
      number,
      number,
      AbortSignal,
    ];
    return new Promise((resolve, reject) => {
      const call: FoxCall = {
        expression: spec.expression,
        settled: false,
        resolve: (value) => {
          call.settled = true;
          resolve({
            kind: 'timeseries',
            timeseries: {
              tsNs: [t1Ns],
              values: [value],
              severity: ['NO_ALARM'],
              inputs: {},
              decimated: false,
            },
          });
        },
      };
      foxCalls.push(call);
      signal.addEventListener('abort', () => {
        call.settled = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  },
}));
vi.mock('./Toolbar', async () => (await import('../test/traceAppHarness')).mocks.Toolbar);
vi.mock('./LeftPanel', async () => (await import('../test/traceAppHarness')).mocks.LeftPanel);
vi.mock('./PlotArea', async () => {
  const React = await import('react');
  const harness = await import('../test/traceAppHarness');
  function MockPlotArea(props: React.ComponentProps<typeof import('./PlotArea').PlotArea>) {
    React.useEffect(() => {
      plotAreaLifecycle.mounts++;
      return () => {
        plotAreaLifecycle.unmounts++;
      };
    }, []);
    return harness.mocks.PlotArea.PlotArea(props);
  }
  return { ...harness.mocks.PlotArea, PlotArea: MockPlotArea };
});
vi.mock('./RightPanel', async () => (await import('../test/traceAppHarness')).mocks.RightPanel);
vi.mock(
  '../hooks/useElogConfig',
  async () => (await import('../test/traceAppHarness')).mocks.useElogConfig
);
vi.mock('../io/download', async () => (await import('../test/traceAppHarness')).mocks.download);

// A legacy-shaped workspace: one plot, one PV curve and `formula-1` over it.
function legacyLike(
  pvName: string,
  expression: string,
  bindings: Record<string, string> = { x1: 'trace-1' }
): string {
  return workspace([
    plot(
      'plot-1',
      [axis('axis-1', 'Y')],
      [pvTrace('trace-1', pvName), formulaTrace('formula-1', expression, bindings)]
    ),
  ]);
}

async function resolvePending(expression: string, value: number) {
  const call = foxCalls.filter((c) => c.expression === expression && !c.settled).pop();
  if (!call) throw new Error(`no pending evaluation of ${expression}`);
  await act(async () => {
    call.resolve(value);
    await flushMicrotasks();
  });
}

// formula-1's result in each PlotArea render from `from` on.
function formulaFrames(from: number) {
  return renders.plotArea
    .slice(from)
    .map((p) => p.formulaResultsByPlot.get('plot-1')?.get('formula-1'));
}

beforeEach(async () => {
  resetHarness();
  foxCalls.length = 0;
  plotAreaLifecycle.mounts = 0;
  plotAreaLifecycle.unmounts = 0;
  render(<TraceApp />);
  await loadWorkspace(legacyLike('A:PV', '{x1}*2'));
  await resolvePending('{x1}*2', 7);
  expect(formulaFrames(renders.plotArea.length - 1)[0]).toMatchObject({
    status: 'ready',
    points: [[expect.any(Number), 7]],
  });
});

afterEach(() => cleanup());

describe('TraceApp formula results across a workspace load', () => {
  it('remounts the plot subtree when a workspace reuses its plot id', async () => {
    const mountsBefore = plotAreaLifecycle.mounts;
    await loadWorkspace(legacyLike('B:PV', '{x1}+100'));

    expect(plotAreaLifecycle.mounts).toBe(mountsBefore + 1);
    expect(plotAreaLifecycle.unmounts).toBeGreaterThan(0);
  });

  it("never shows the outgoing workspace's points for a reused formula id", async () => {
    const from = renders.plotArea.length;
    await loadWorkspace(legacyLike('B:PV', '{x1}+100'));

    const frames = formulaFrames(from);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((r) => r?.status === 'loading' && r.points.length === 0)).toBe(true);

    await resolvePending('{x1}+100', 107);
    expect(formulaFrames(renders.plotArea.length - 1)[0]).toMatchObject({
      status: 'ready',
      points: [[expect.any(Number), 107]],
    });
  });

  it('shows nothing for a reused formula id that arrives unbound', async () => {
    const from = renders.plotArea.length;
    await loadWorkspace(legacyLike('B:PV', '{x1}+100', {}));

    const frames = formulaFrames(from);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((r) => r?.status === 'idle' && r.points.length === 0)).toBe(true);
  });
});
