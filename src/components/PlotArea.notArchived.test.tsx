// @vitest-environment jsdom
//
// The not-archived notice: when every visible curve's archive fetch came back
// with a not-archived code (`pv_not_found`, the e2e Mole mock's 404 for an
// unarchived PV; `archiver_not_configured`, no archiver for the PV; or
// `pv_not_found_in_archiver`, Mole's 404 for a PV its archiver does not hold)
// and no live data is plotted, SinglePlot lays a non-interactive overlay over
// the chart reading "Not archived: <PV>" ("No archiver: <PV>" for
// `archiver_not_configured`), one line per PV. Any other state
// draws nothing.
//
// echarts-for-react is mocked; the archive results are passed straight in,
// so the archive store itself is not involved.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Axis, Plot, PVTrace } from '../types';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';
import { newFormula, newTrace } from '../embed/plotConfig';

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  const fakeInstance = {
    getWidth: () => 800,
    getHeight: () => 400,
    isDisposed: () => false,
    getDom: () => null,
    getZr: () => ({ setCursorStyle: () => {}, on: () => {}, off: () => {} }),
    getModel: () => null,
    convertToPixel: () => 0,
    convertFromPixel: () => 0,
    getDataURL: () => '',
    resize: () => {},
    dispatchAction: () => {},
    on: () => {},
    off: () => {},
  };
  class MockECharts extends React.Component {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      return React.createElement('div', { 'data-testid': 'echarts' });
    }
  }
  return { default: MockECharts };
});

import { SinglePlot } from './PlotArea';

const AXIS: Axis = {
  id: 'axis-1',
  name: 'Y-Axis 1',
  orientation: 'left',
  autoScale: true,
  logScale: false,
  visible: true,
};
const PV_A = 'TEST:NOPE:A';
const PV_B = 'TEST:NOPE:B';
const PV_C = 'EG______HV_____AM00';
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

function plotWith(traces: PVTrace[]): Plot {
  return {
    id: 'plot-1',
    title: 'Plot 1',
    traces,
    axes: [AXIS],
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: 'custom', timeFrom: '2026-10-14T11:00', timeTo: '2026-10-14T13:00' },
  };
}

function curve(id: string, pv: string, over: Partial<PVTrace> = {}): PVTrace {
  return { ...newTrace(id, pv, AXIS.id, '#0f62fe', []), useArchive: true, ...over };
}

/** What the archive store holds after the e2e mock's 404 `pv_not_found`. */
function notFound(pv: string): ArchiveSeriesResult {
  return {
    status: 'error',
    mean: [],
    band: [],
    error: { code: 'pv_not_found', detail: `PV '${pv}' is not archived.` },
  };
}

/** The archive's 404 `archiver_not_configured` (no archiver configured for the PV). */
function notConfigured(pv: string): ArchiveSeriesResult {
  return {
    status: 'error',
    mean: [],
    band: [],
    error: { code: 'archiver_not_configured', detail: `No archiver is configured for '${pv}'.` },
  };
}

/** Canopy Mole reader's 404 `pv_not_found_in_archiver` (the archiver does not hold the PV). */
function notInArchiver(pv: string): ArchiveSeriesResult {
  return {
    status: 'error',
    mean: [],
    band: [],
    error: { code: 'pv_not_found_in_archiver', detail: `PV '${pv}' not found in archiver.` },
  };
}

function otherError(): ArchiveSeriesResult {
  return { status: 'error', mean: [], band: [], error: { code: 'timeout', detail: 'slow' } };
}

function ready(): ArchiveSeriesResult {
  return {
    status: 'ready',
    mode: 'raw',
    mean: [{ time: T0, value: 1 }] as ArchiveSeriesResult['mean'],
    band: [],
  };
}

function live(points: number): LiveSeriesResult {
  return {
    status: 'connected',
    connected: true,
    severity: null,
    latest: null,
    error: null,
    points: Array.from({ length: points }, (_, i) => ({
      time: T0 + i * 1000,
      value: i,
      severity: 'NO_ALARM',
    })) as LiveSeriesResult['points'],
    breaks: [],
  };
}

function renderPlot(
  traces: PVTrace[],
  archive: [string, ArchiveSeriesResult][],
  liveResults: [string, LiveSeriesResult][] = []
) {
  return render(
    <div style={{ height: 400, width: 800 }}>
      <SinglePlot
        plot={plotWith(traces)}
        archiveResults={new Map(archive)}
        liveResults={new Map(liveResults)}
        formulaResults={new Map()}
      />
    </div>
  );
}

const notice = () => screen.queryByTestId('archive-empty-notice');

afterEach(cleanup);

describe('empty-archive notice', () => {
  it('shows "Not archived: <PV>" when the only curve is pv_not_found', () => {
    renderPlot([curve('t1', PV_A)], [['t1', notFound(PV_A)]]);
    const el = notice();
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe(`Not archived: ${PV_A}`);
  });

  it('lists one line per PV when every curve is pv_not_found', () => {
    renderPlot(
      [curve('t1', PV_A), curve('t2', PV_B)],
      [
        ['t1', notFound(PV_A)],
        ['t2', notFound(PV_B)],
      ]
    );
    const lines = Array.from(notice()?.children ?? []);
    expect(lines.map((l) => l.textContent)).toEqual([
      `Not archived: ${PV_A}`,
      `Not archived: ${PV_B}`,
    ]);
  });

  it('shows "No archiver: <PV>" when the only curve is archiver_not_configured', () => {
    renderPlot([curve('t1', PV_A)], [['t1', notConfigured(PV_A)]]);
    expect(notice()?.textContent).toBe(`No archiver: ${PV_A}`);
  });

  it('lists every PV when curves mix pv_not_found and archiver_not_configured', () => {
    renderPlot(
      [curve('t1', PV_A), curve('t2', PV_B)],
      [
        ['t1', notFound(PV_A)],
        ['t2', notConfigured(PV_B)],
      ]
    );
    const lines = Array.from(notice()?.children ?? []);
    expect(lines.map((l) => l.textContent)).toEqual([
      `Not archived: ${PV_A}`,
      `No archiver: ${PV_B}`,
    ]);
  });

  it('shows "Not archived: <PV>" when the only curve is pv_not_found_in_archiver', () => {
    renderPlot([curve('t1', PV_A)], [['t1', notInArchiver(PV_A)]]);
    expect(notice()?.textContent).toBe(`Not archived: ${PV_A}`);
  });

  it('lists every PV when curves mix all three empty-archive codes', () => {
    renderPlot(
      [curve('t1', PV_A), curve('t2', PV_B), curve('t3', PV_C)],
      [
        ['t1', notInArchiver(PV_A)],
        ['t2', notConfigured(PV_B)],
        ['t3', notFound(PV_C)],
      ]
    );
    const lines = Array.from(notice()?.children ?? []);
    expect(lines.map((l) => l.textContent)).toEqual([
      `Not archived: ${PV_A}`,
      `No archiver: ${PV_B}`,
      `Not archived: ${PV_C}`,
    ]);
  });

  it('draws nothing for pv_not_found_in_archiver when live data is plotted', () => {
    renderPlot(
      [curve('t1', PV_A, { useLive: true })],
      [['t1', notInArchiver(PV_A)]],
      [['t1', live(3)]]
    );
    expect(notice()).toBeNull();
  });

  it('draws nothing for archiver_not_configured when live data is plotted', () => {
    renderPlot(
      [curve('t1', PV_A, { useLive: true })],
      [['t1', notConfigured(PV_A)]],
      [['t1', live(3)]]
    );
    expect(notice()).toBeNull();
  });

  it('is an absolutely positioned overlay that lets the pointer through', () => {
    const { container } = renderPlot([curve('t1', PV_A)], [['t1', notFound(PV_A)]]);
    const el = notice() as HTMLElement;
    expect(el.style.position).toBe('absolute');
    expect(el.style.pointerEvents).toBe('none');
    // Inside the plot's own wrapper, which positions it.
    const wrapper = container.querySelector('[data-plot-id="plot-1"]') as HTMLElement;
    expect(wrapper.contains(el)).toBe(true);
    expect(wrapper.style.position).toBe('relative');
  });

  it('ignores hidden curves', () => {
    renderPlot(
      [curve('t1', PV_A), curve('t2', PV_B, { visible: false })],
      [
        ['t1', notFound(PV_A)],
        ['t2', ready()],
      ]
    );
    expect(notice()?.textContent).toBe(`Not archived: ${PV_A}`);
  });

  it('draws nothing when one visible curve has archive data', () => {
    renderPlot(
      [curve('t1', PV_A), curve('t2', PV_B)],
      [
        ['t1', notFound(PV_A)],
        ['t2', ready()],
      ]
    );
    expect(notice()).toBeNull();
  });

  it('draws nothing for an archive error other than the empty-archive codes', () => {
    renderPlot([curve('t1', PV_A)], [['t1', otherError()]]);
    expect(notice()).toBeNull();
  });

  it('draws nothing while the archive is still loading or has no result', () => {
    renderPlot([curve('t1', PV_A)], [['t1', { status: 'loading', mean: [], band: [] }]]);
    expect(notice()).toBeNull();
    cleanup();
    renderPlot([curve('t1', PV_A)], []);
    expect(notice()).toBeNull();
  });

  it('draws nothing when live data is plotted', () => {
    renderPlot([curve('t1', PV_A, { useLive: true })], [['t1', notFound(PV_A)]], [['t1', live(3)]]);
    expect(notice()).toBeNull();
  });

  it('still shows when the live stream has no points yet', () => {
    renderPlot([curve('t1', PV_A, { useLive: true })], [['t1', notFound(PV_A)]], [['t1', live(0)]]);
    expect(notice()?.textContent).toBe(`Not archived: ${PV_A}`);
  });

  it('draws nothing when a visible formula curve is on the plot', () => {
    const formula = { ...newFormula('f1', AXIS.id, '#abcdef'), displayName: 'Sum' };
    renderPlot([curve('t1', PV_A), formula], [['t1', notFound(PV_A)]]);
    expect(notice()).toBeNull();
  });

  it('draws nothing on a plot with no visible curves', () => {
    renderPlot([curve('t1', PV_A, { visible: false })], [['t1', notFound(PV_A)]]);
    expect(notice()).toBeNull();
  });
});
