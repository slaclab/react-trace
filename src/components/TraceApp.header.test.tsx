// @vitest-environment jsdom
//
// Trace's heading (C9) at the head of the actions row. Standalone: the
// product name from TRACE_HEADER (a neutral "Trace", no prefix), then the
// active plot's "N Live • N Archive" counter, counted as the retired header
// counted it. Embedded: the counter alone, since the host's tile bar names
// the tool, and that also under the host bar, which hides the actions bar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  axis,
  captured,
  loadWorkspace,
  plot,
  pvTrace,
  resetHarness,
  workspace,
} from '../test/traceAppHarness';
import { WithCanopy } from '../test/canopy';
import { TESTIDS } from '../workbench/testids';
import { TRACE_HEADER, liveArchiveCounter, traceHeading } from '../tools/trace/header';
import { TraceApp } from './TraceApp';

vi.mock('@slaclab/canopy-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slaclab/canopy-client')>()),
  fetchData: () => new Promise(() => {}),
  fetchMetadata: () => new Promise(() => {}),
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
  '../hooks/useElogConfig',
  async () => (await import('../test/traceAppHarness')).mocks.useElogConfig
);
vi.mock('../io/download', async () => (await import('../test/traceAppHarness')).mocks.download);

// Plot A: live + archive, archive only, live only, and a formula (neither);
// plot B: one curve with both.
const TWO_PLOTS = workspace([
  plot(
    'plot-a',
    [axis('axis-a')],
    [
      pvTrace('a1', 'SIM:A1', { useLive: true, useArchive: true }),
      pvTrace('a2', 'SIM:A2', { useArchive: true }),
      pvTrace('a3', 'SIM:A3', { useLive: true }),
      pvTrace('a4', '', { kind: 'formula', expression: '{x1}', bindings: { x1: 'a1' } }),
    ]
  ),
  plot('plot-b', [axis('axis-b')], [pvTrace('b1', 'SIM:B1', { useLive: true, useArchive: true })]),
]);

const headingEl = () => document.querySelector<HTMLElement>('.wb-workbench__heading');
const nameEl = () => headingEl()?.querySelector('.wb-workbench__name') ?? null;
const counterText = () => headingEl()?.querySelector('.wb-workbench__status')?.textContent;

function mountAt(search: string) {
  window.history.replaceState(null, '', `/${search}`);
  render(<TraceApp />, { wrapper: WithCanopy });
}

beforeEach(() => {
  resetHarness();
  // Loaded curves stream live data; without a WebSocket the live store stays idle.
  vi.stubGlobal('WebSocket', undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('the heading', () => {
  it('is neutral by default: "Trace", no prefix', () => {
    expect(TRACE_HEADER).toEqual({ prefix: '', productName: 'Trace' });
  });

  it('standalone: the product name, then the counter of the active plot', async () => {
    mountAt('');
    expect(nameEl()?.textContent).toBe('Trace');
    expect(headingEl()?.querySelector('.wb-workbench__prefix')).toBeNull();
    expect(counterText()).toBe('0 Live • 0 Archive');

    await loadWorkspace(TWO_PLOTS);
    expect(counterText()).toBe('2 Live • 2 Archive');
    act(() => captured.plotArea!.onSetActivePlot('plot-b'));
    expect(counterText()).toBe('1 Live • 1 Archive');
    // Outside the toolbar, ahead of it.
    const toolbar = screen.getByRole('toolbar', { name: 'Tool actions' });
    expect(toolbar.contains(headingEl())).toBe(false);
    expect(headingEl()?.nextElementSibling).toBe(toolbar);
  });

  it('follows a curve whose sources change', async () => {
    mountAt('');
    await loadWorkspace(TWO_PLOTS);
    act(() =>
      captured.layout!.update((s) => ({
        ...s,
        plots: s.plots.map((p) => ({
          ...p,
          traces: p.traces.map((t) => (t.id === 'a1' ? { ...t, useLive: false } : t)),
        })),
      }))
    );
    expect(counterText()).toBe('1 Live • 2 Archive');
  });

  it('embedded: the counter alone, beside the actions bar', () => {
    mountAt('?embedded=true&pv=SIM:A&pv=SIM:B');
    expect(nameEl()).toBeNull();
    expect(counterText()).toBe('2 Live • 2 Archive');
    expect(screen.getByTestId(TESTIDS.actionsBar)).toBeTruthy();
  });

  it('under the host bar: the counter alone, in a row of its own', () => {
    mountAt('?embedded=true&hostbar=1&pv=SIM:A');
    expect(nameEl()).toBeNull();
    expect(counterText()).toBe('1 Live • 1 Archive');
    expect(screen.queryByTestId(TESTIDS.actionsBar)).toBeNull();
  });
});

describe('traceHeading and liveArchiveCounter (pure)', () => {
  it('counts a curve with both sources in each, and nothing without a plot', () => {
    const p = { traces: [{ useLive: true, useArchive: true }, { useArchive: true }, {}] };
    expect(liveArchiveCounter(p)).toBe('1 Live • 2 Archive');
    expect(liveArchiveCounter(undefined)).toBe('0 Live • 0 Archive');
  });

  it('names the tool standalone only', () => {
    const p = { traces: [{ useLive: true }] };
    expect(traceHeading(p, false)).toEqual({
      prefix: '',
      name: 'Trace',
      status: '1 Live • 0 Archive',
    });
    expect(traceHeading(p, true)).toEqual({ status: '1 Live • 0 Archive' });
  });
});
