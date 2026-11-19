// @vitest-environment jsdom
//
// The formula help text hard-coded #78a9ff (Carbon blue 40, the dark-theme link
// colour) on its <code> examples, which is about 2.4:1 on the light theme's
// white Properties panel. The examples must follow the theme token instead.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RightPanel } from './RightPanel';
import type { Plot, PVTrace } from '../types';
import { WithCanopy } from '../test/canopy';
import { stubCarbonDom } from '../test/dom';

// RightPanel's Carbon Tabs observe their size; jsdom has no ResizeObserver.
stubCarbonDom();

// Carbon's Tabs query media features; jsdom doesn't implement matchMedia.
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

// An empty expression shows every help example (including the "Add a {var}"
// hint) and skips the Formula Engine validation request.
const formulaTrace: PVTrace = {
  id: 't1',
  kind: 'formula',
  pvName: '',
  displayName: 'Formula 1',
  color: '#0f62fe',
  visible: true,
  axisId: 'ax1',
  useLive: false,
  updateRate: '1s',
  useArchive: false,
  expression: '',
  bindings: {},
  lineWidth: 1,
  lineType: 'step',
  lineStyle: 'solid',
  showSymbol: false,
  symbolShape: 'none',
  symbolSize: 4,
  data: [],
};

const plot: Plot = {
  id: 'p1',
  title: 'Plot 1',
  traces: [formulaTrace],
  axes: [
    {
      id: 'ax1',
      name: 'Y',
      orientation: 'left',
      autoScale: true,
      logScale: false,
      visible: true,
    },
  ],
  backgroundColor: 'default',
  showLegend: false,
  showXGridlines: false,
  showYGridlines: false,
  showCrosshair: false,
  gridStyle: 'solid',
  gridOpacity: 1,
  tickFontSize: 11,
  xAxis: { timeRange: '-1h' },
};

describe('formula help text', () => {
  afterEach(cleanup);
  afterAll(() => vi.unstubAllGlobals());

  it('colours the code examples with the theme link token', () => {
    render(
      <RightPanel
        selectedItem={{ type: 'trace', id: 't1', plotId: 'p1' }}
        activePlot={plot}
        nowMs={0}
        archiveResults={new Map()}
        liveResults={new Map()}
        collapsed={false}
        onUpdateTrace={vi.fn()}
        onSelectPv={vi.fn()}
        onUpdateAxis={vi.fn()}
        onUpdatePlot={vi.fn()}
        onApplyPalette={vi.fn()}
        onInspectTrace={vi.fn()}
        onCreateFormula={vi.fn()}
        onCollapse={vi.fn()}
        onExpand={vi.fn()}
        getAxisRange={() => undefined}
      />,
      { wrapper: WithCanopy }
    );
    const examples = ['{x1}', '{x1} + {x2}', '{var}'];
    const colours = examples.map(
      (text) => screen.getByText(text, { selector: 'code' }).style.color
    );
    expect(colours).toEqual(examples.map(() => 'var(--cds-link-primary)'));
  });
});
