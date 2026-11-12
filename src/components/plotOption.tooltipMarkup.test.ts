// @vitest-environment jsdom
//
// The read-out tooltip is HTML. A saved workspace is user data: a sample it
// carries must not inject markup, through either sink of a read-out line, the
// severity or the value. Loading drops a trace's saved samples outright; the
// read-out also renders such a sample inert on its own.
import { describe, expect, it } from 'vitest';
import { drawingThemeFor } from '../annotationTheme';
import { deserializeWorkspace } from '../io/serialize';
import type { Plot } from '../types';
import { buildPlotOption } from './plotOption';

const PAYLOAD = '<img src=x onerror="window.__pwned=1">';
const T = Date.parse('2026-06-05T12:00:00Z');

/** A native workspace whose one curve (live and archive off) carries `sample` in `data`. */
function workspaceWith(sample: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: 1,
    savedAt: '2026-10-19T12:00:00.000Z',
    theme: 'dark',
    plots: [
      {
        id: 'p1',
        title: 'Plot',
        xAxis: { timeRange: '-1h' },
        axes: [
          {
            id: 'a1',
            name: 'Y',
            orientation: 'left',
            autoScale: true,
            logScale: false,
            visible: true,
          },
        ],
        traces: [
          {
            id: 't1',
            pvName: 'TEST:PV',
            displayName: '',
            color: '#0f62fe',
            visible: true,
            axisId: 'a1',
            useLive: false,
            useArchive: false,
            lineWidth: 2,
            lineType: 'step',
            lineStyle: 'solid',
            showSymbol: false,
            symbolShape: 'circle',
            symbolSize: 10,
            data: [sample],
          },
        ],
      },
    ],
  });
}

/** The read-out line at `T` for `plot`, parsed as the browser would. */
function readout(plot: Plot): HTMLElement {
  const option = buildPlotOption({
    plot,
    archiveResults: new Map(),
    liveResults: new Map(),
    formulaResults: new Map(),
    theme: drawingThemeFor('dark'),
    endMs: T + 60_000,
  });
  const tooltip = option.tooltip as { formatter: (p: { axisValue: number }[]) => string };
  const box = document.createElement('div');
  box.innerHTML = tooltip.formatter([{ axisValue: T }]);
  return box;
}

/** `plot` with the file's sample put back, as if a sample had reached the read-out. */
function withSample(plot: Plot, sample: Record<string, unknown>): Plot {
  const [trace] = plot.traces;
  return { ...plot, traces: [{ ...trace, data: [sample] as unknown as typeof trace.data }] };
}

describe('read-out tooltip: markup from a loaded file', () => {
  it('a file-loaded severity carrying markup renders inert in the tooltip', () => {
    const sample = { time: T, value: 1.5, severity: PAYLOAD };
    const [plot] = deserializeWorkspace(workspaceWith(sample)).plots;
    expect(plot.traces[0].data).toEqual([]);
    expect(readout(plot).querySelector('img')).toBeNull();

    const box = readout(withSample(plot, sample));
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelector('[onerror]')).toBeNull();
    // An unknown severity is not named at all; the value still shows.
    expect(box.textContent).not.toContain('onerror');
    expect(box.textContent).toContain('1.5');
    // A known severity is still named.
    expect(readout(withSample(plot, { ...sample, severity: 'MAJOR' })).textContent).toContain(
      '1.5 MAJOR'
    );
  });

  it('a file-loaded value carrying markup renders inert in the tooltip', () => {
    const sample = { time: T, value: PAYLOAD, severity: 'NO_ALARM' };
    const [plot] = deserializeWorkspace(workspaceWith(sample)).plots;
    expect(plot.traces[0].data).toEqual([]);
    expect(readout(plot).querySelector('img')).toBeNull();

    const box = readout(withSample(plot, sample));
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelector('[onerror]')).toBeNull();
    // The value is shown as text, escaped, not parsed.
    expect(box.textContent).toContain(PAYLOAD);
  });
});
