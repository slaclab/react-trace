// @vitest-environment jsdom
//
// Trace's status line under a plot, as Correlation and Waveform show theirs:
// while a drawing tool is armed it says what to do next ("Box: drag or click
// twice"), and nothing once the tool goes back to the pointer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SinglePlot } from '../../../components/PlotArea';
import type { Axis, Plot } from '../../../types';
import { DEFAULT_TOOL_PREFS, type AnnotationToolPrefs } from '../../../annotations/tools';
import { chartStub } from '../../../test/chartStub';

const { fakeInstance } = vi.hoisted(() => {
  const fakeInstance = {
    getWidth: () => 800,
    getHeight: () => 400,
    isDisposed: () => false,
    getZr: () => ({ setCursorStyle: () => {} }),
    getModel: () => ({
      getComponent: () => ({ axis: { scale: { getExtent: (): [number, number] => [0, 100] } } }),
    }),
    convertToPixel: () => 0,
    convertFromPixel: (() => 0) as (finder: object, px: number) => number,
  };
  return { fakeInstance };
});

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../../../test/chartStub')).mockCanopyCharts(importOriginal)
);
chartStub.instance = fakeInstance;

const AXIS: Axis = {
  id: 'ax1',
  name: 'Current',
  orientation: 'left',
  autoScale: true,
  logScale: false,
  visible: true,
};

function makePlot(): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [],
    axes: [AXIS],
    backgroundColor: 'default',
    showLegend: false,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-10m' },
  };
}

afterEach(() => {
  cleanup();
});

function hint(prefs: Partial<AnnotationToolPrefs>): string | null | undefined {
  const { container } = render(
    <SinglePlot
      plot={makePlot()}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
      annotationPrefs={{ ...DEFAULT_TOOL_PREFS, ...prefs }}
      onAnnotationPrefs={() => {}}
    />
  );
  return container.querySelector('[data-status-tool-hint]')?.textContent;
}

describe('Trace status line', () => {
  it('shows the armed tool’s hint', () => {
    expect(hint({ tool: 'box' })).toBe('Box: drag or click twice');
  });

  it('shows none with the pointer', () => {
    expect(hint({ tool: 'cursor' })).toBe('');
  });
});
