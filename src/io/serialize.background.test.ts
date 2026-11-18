// A white plot background round-trips as on main (R11). `#ffffff`, the
// pre-g10 light default, still reads as automatic, so the plot draws the
// theme's background as it did on main. But the file's value is kept and a
// re-save writes `#ffffff` back, in either theme, instead of the theme's own
// background. A picked background replaces it; the chart themes' own
// defaults keep resolving to the current theme, as before.
import { describe, expect, it } from 'vitest';
import { deserializeWorkspace, serializeWorkspace } from './serialize';
import type { Plot, PVTrace } from '../types';

function curve(): PVTrace {
  return {
    id: 'trace-1',
    pvName: 'TEST:SINE',
    displayName: '',
    color: '#0f62fe',
    visible: true,
    axisId: 'axis-1',
    useLive: true,
    useArchive: true,
    lineWidth: 2,
    lineType: 'step',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'circle',
    symbolSize: 10,
    data: [],
  };
}

function wirePlot(backgroundColor: string) {
  return {
    id: 'plot-1',
    title: 'Plot 1',
    traces: [curve()],
    axes: [
      {
        id: 'axis-1',
        name: 'Y-Axis 1',
        orientation: 'left',
        autoScale: true,
        logScale: false,
        visible: true,
      },
    ],
    backgroundColor,
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
  };
}

function fileWith(backgroundColor: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    savedAt: '2026-11-01T00:00:00Z',
    theme: 'dark',
    plots: [wirePlot(backgroundColor)],
  });
}

const savedBackground = (plots: Plot[], theme: 'dark' | 'light') =>
  JSON.parse(serializeWorkspace({ theme, plots })).plots[0].backgroundColor;

describe('a white background round-trips (R11)', () => {
  it('reads as automatic and is written back as #ffffff in either theme', () => {
    const { plots } = deserializeWorkspace(fileWith('#ffffff'));
    expect(plots[0].backgroundColor).toBeUndefined();
    expect(savedBackground(plots, 'dark')).toBe('#ffffff');
    expect(savedBackground(plots, 'light')).toBe('#ffffff');
    // And again on the next load and save.
    const again = deserializeWorkspace(serializeWorkspace({ theme: 'dark', plots })).plots;
    expect(again[0].backgroundColor).toBeUndefined();
    expect(savedBackground(again, 'dark')).toBe('#ffffff');
  });

  it('a background picked after loading replaces it', () => {
    const [plot] = deserializeWorkspace(fileWith('#ffffff')).plots;
    expect(savedBackground([{ ...plot, backgroundColor: '#123456' }], 'dark')).toBe('#123456');
  });

  it("the chart themes' own defaults still resolve to the current theme", () => {
    const { plots } = deserializeWorkspace(fileWith('#161616'));
    expect(plots[0].backgroundColor).toBeUndefined();
    expect(savedBackground(plots, 'dark')).toBe('#161616');
    expect(savedBackground(plots, 'light')).toBe('#f4f4f4');
  });

  it('never writes the kept value under a key of its own', () => {
    const { plots } = deserializeWorkspace(fileWith('#ffffff'));
    const text = serializeWorkspace({ theme: 'dark', plots });
    expect(Object.keys(JSON.parse(text).plots[0])).not.toContain('savedBackground');
  });

  it('a legacy .trc white background is kept the same way', () => {
    const trc = JSON.stringify({
      plot: { title: 'T', backgroundColor: '#ffffff' },
      'y-axes': [],
      curves: [],
    });
    const { plots } = deserializeWorkspace(trc);
    expect(plots[0].backgroundColor).toBeUndefined();
    expect(savedBackground(plots, 'dark')).toBe('#ffffff');
  });
});
