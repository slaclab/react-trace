// @vitest-environment jsdom
//
// Trace's Display › Drawing tools and Display › Drawings, with a plot and the
// properties panel mounted over one state: Drawing tools off unmounts the
// plot's rail, disarms an armed tool and leaves Alt+<letter> inert; Drawings
// is the plot's hide-all, the same state as the rail's hide button, in both
// directions. `showDrawingTools` rides `.trc.json` (and the config store)
// only when off; a file without it opens with the tools on.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';

vi.mock('@slaclab/canopy-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@slaclab/canopy-client')>();
  return {
    ...actual,
    listArchivers: vi.fn(async () => ({ default: 'main-archiver', archivers: [] })),
  };
});
vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../../test/chartStub')).mockCanopyCharts(importOriginal)
);

import { SinglePlot } from '../../components/PlotArea';
import { DEFAULT_TOOL_PREFS, type AnnotationToolPrefs } from '../../annotations/tools';
import { drawingThemeFor } from '../../annotationTheme';
import { DEFAULT_PALETTE_ID, getPalette } from '../../palettes';
import {
  deserializeConfigData,
  deserializeWorkspace,
  serializeConfigData,
  serializeWorkspace,
} from '../../io/serialize';
import type { Plot } from '../../types';
import { buildInitialPlots } from '../../embed/initialPlots';
import { parsePlotConfig, plotConfigOf } from '../../embed/plotConfig';
import { serializeTraceQuery } from '../../embed/query';
import { PanelHarness } from '../../workbench/__fixtures__/PanelHarness';
import { SelectionProvider, createSelectionStore } from '../../workbench/selection';
import type { ToolDefinition } from '../../workbench/types';
import { WithCanopy } from '../../test/canopy';
import { chartStub } from '../../test/chartStub';
import type { TraceDotState } from './dots';
import { plotSchema, type TracePlotModel } from './schema/plot';

chartStub.instance = {
  getWidth: () => 800,
  getHeight: () => 400,
  isDisposed: () => false,
  getZr: () => ({ setCursorStyle: () => {} }),
  getModel: () => ({
    getComponent: () => ({ axis: { scale: { getExtent: (): [number, number] => [0, 100] } } }),
  }),
  convertToPixel: () => 0,
  convertFromPixel: () => 0,
};

afterEach(() => {
  cleanup();
});

function makePlot(extra: Partial<Plot> = {}): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [],
    axes: [
      {
        id: 'ax1',
        name: 'Y-Axis 1',
        orientation: 'left',
        autoScale: true,
        logScale: false,
        visible: true,
      },
    ],
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
    autoScroll: true,
    ...extra,
  };
}

const model: TracePlotModel = {
  palette: getPalette(DEFAULT_PALETTE_ID),
  fragmentInput: (p) => ({
    plot: p,
    archiveResults: new Map(),
    liveResults: new Map(),
    formulaResults: new Map(),
    theme: drawingThemeFor('light'),
  }),
};

const definition: ToolDefinition<TraceDotState, TracePlotModel> = {
  schema: { tool: plotSchema, sections: {}, items: {} },
  binding: {
    outline: () => ({ sections: [] }),
    ops: { add: async () => undefined, remove: () => {}, move: () => {} },
    moveRefusal: () => null,
  },
};

interface Live {
  state: TraceDotState;
  prefs: AnnotationToolPrefs;
  hidden: ReadonlySet<string>;
}

/** The plot and the panel over one state, the hide-all set and the prefs, as TraceApp holds them. */
function mount(plot: Plot, prefs: Partial<AnnotationToolPrefs> = {}) {
  const live: Live = {
    state: { plots: [plot], activePlotId: plot.id },
    prefs: { ...DEFAULT_TOOL_PREFS, ...prefs },
    hidden: new Set(),
  };
  function App() {
    const [state, setState] = useState<TraceDotState>(live.state);
    const [annotationPrefs, setPrefs] = useState<AnnotationToolPrefs>(live.prefs);
    const [annotationsHidden, setHiddenSet] = useState<ReadonlySet<string>>(live.hidden);
    live.state = state;
    live.prefs = annotationPrefs;
    live.hidden = annotationsHidden;
    const setAnnotationsHidden = (plotId: string, on: boolean) =>
      setHiddenSet((prev) => {
        const next = new Set(prev);
        if (on) next.add(plotId);
        else next.delete(plotId);
        return next;
      });
    const shown = state.plots[0];
    return (
      <>
        <SinglePlot
          plot={shown}
          archiveResults={new Map()}
          liveResults={new Map()}
          formulaResults={new Map()}
          annotationsHidden={annotationsHidden.has(shown.id)}
          annotationPrefs={annotationPrefs}
          onAnnotationPrefs={(patch) => setPrefs((p) => ({ ...p, ...patch }))}
          onCommitAnnotations={() => {}}
          onAnnotationsHidden={(on) => setAnnotationsHidden(shown.id, on)}
          onPlotView={() => {}}
        />
        <PanelHarness
          definition={definition}
          state={state}
          model={model}
          ui={{ annotationsHidden, setAnnotationsHidden }}
          update={setState}
          capabilities={{ elog: false }}
          toolId="trace"
          open={['display']}
        />
      </>
    );
  }
  const utils = render(
    <SelectionProvider store={createSelectionStore({ initial: null })}>
      <App />
    </SelectionProvider>,
    { wrapper: WithCanopy }
  );
  const wrap = utils.container.querySelector('[data-plot-id]') as HTMLElement;
  const rail = () => wrap.querySelector('[data-drawing-rail]');
  const hideButton = () => wrap.querySelector<HTMLButtonElement>('[data-drawing-toggle="hide"]');
  const openMore = () => {
    const display = document.querySelector('.wb-plot-section[data-section="display"]')!;
    const more = [...display.querySelectorAll('button')].find((b) => b.textContent === 'More')!;
    fireEvent.click(more);
  };
  const toggle = (id: string) => document.getElementById(id) as HTMLButtonElement;
  const key = (init: KeyboardEventInit) => {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => {
      wrap.dispatchEvent(ev);
    });
    return ev;
  };
  return { live, rail, hideButton, openMore, toggle, key };
}

describe('Trace: Display › Drawing tools', () => {
  it('hides and shows the plot rail, storing only the off value', () => {
    const { live, rail, openMore, toggle } = mount(makePlot());
    expect(rail()).not.toBeNull();
    openMore();
    const tools = toggle('show-drawing-tools');
    expect(tools.getAttribute('aria-checked')).toBe('true');
    act(() => {
      fireEvent.click(tools);
    });
    expect(live.state.plots[0].showDrawingTools).toBe(false);
    expect(rail()).toBeNull();
    act(() => {
      fireEvent.click(toggle('show-drawing-tools'));
    });
    expect(live.state.plots[0].showDrawingTools).toBeUndefined();
    expect(rail()).not.toBeNull();
  });

  it('disarms an armed tool and leaves the arm keys inert while off', () => {
    const { live, openMore, toggle, key } = mount(makePlot(), { tool: 'hline' });
    expect(live.prefs.tool).toBe('hline');
    openMore();
    act(() => {
      fireEvent.click(toggle('show-drawing-tools'));
    });
    expect(live.prefs.tool).toBe('cursor');
    const arm = key({ key: '˙', code: 'KeyH', altKey: true });
    expect(arm.defaultPrevented).toBe(false);
    expect(live.prefs.tool).toBe('cursor');
  });

  it('opens with no rail for a plot saved with the tools off', () => {
    const { rail } = mount(makePlot({ showDrawingTools: false }));
    expect(rail()).toBeNull();
  });
});

describe('Trace: Display › Drawings and the rail’s hide-all', () => {
  it('agree in both directions', () => {
    const { live, hideButton, openMore, toggle } = mount(makePlot());
    openMore();
    const drawings = () => toggle('show-drawings');
    expect(drawings().getAttribute('aria-checked')).toBe('true');
    expect(hideButton()?.getAttribute('aria-pressed')).toBe('false');

    // The rail's button hides: the Display toggle reads off.
    act(() => {
      fireEvent.click(hideButton()!);
    });
    expect(live.hidden.has('p1')).toBe(true);
    expect(drawings().getAttribute('aria-checked')).toBe('false');

    // The Display toggle shows: the rail's button reads shown.
    act(() => {
      fireEvent.click(drawings());
    });
    expect(live.hidden.has('p1')).toBe(false);
    expect(hideButton()?.getAttribute('aria-pressed')).toBe('false');

    // And the other way round.
    act(() => {
      fireEvent.click(drawings());
    });
    expect(live.hidden.has('p1')).toBe(true);
    expect(hideButton()?.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps hiding drawings possible while the rail is hidden', () => {
    const { live, rail, openMore, toggle } = mount(makePlot({ showDrawingTools: false }));
    expect(rail()).toBeNull();
    openMore();
    act(() => {
      fireEvent.click(toggle('show-drawings'));
    });
    expect(live.hidden.has('p1')).toBe(true);
  });
});

describe('Trace: showDrawingTools in .trc.json and the config store', () => {
  it('round-trips the off value through a file and the config store', () => {
    const plots = [makePlot({ showDrawingTools: false })];
    const file = deserializeWorkspace(serializeWorkspace({ theme: 'dark', plots }));
    expect(file.plots[0].showDrawingTools).toBe(false);
    const stored = deserializeConfigData(serializeConfigData({ theme: 'dark', plots }));
    expect(stored.plots[0].showDrawingTools).toBe(false);
  });

  it('writes no key while the tools are on', () => {
    const text = serializeWorkspace({ theme: 'dark', plots: [makePlot()] });
    expect(text).not.toContain('showDrawingTools');
  });

  it('opens a file without the key, or with a non-false value, with the tools on', () => {
    const plots = [makePlot()];
    const wire = JSON.parse(serializeWorkspace({ theme: 'dark', plots }));
    expect(deserializeConfigData(wire).plots[0].showDrawingTools).toBeUndefined();
    wire.plots[0].showDrawingTools = true;
    expect('showDrawingTools' in deserializeConfigData(wire).plots[0]).toBe(false);
  });
});

describe('Trace: showDrawingTools in the link', () => {
  const palette = getPalette(DEFAULT_PALETTE_ID);
  const opened = (search: string): Plot => buildInitialPlots(search, palette)[0];
  const queryOf = (plot: Plot): string =>
    serializeTraceQuery(plot.traces, plot.xAxis, plotConfigOf(plot, palette));

  it('round-trips the off value through plot=', () => {
    const plot = { ...opened('?pv=TEST:SINE&range=-1h'), showDrawingTools: false };
    expect(plotConfigOf(plot, palette)?.showDrawingTools).toBe(false);
    const back = opened(`?${queryOf(plot)}`);
    expect(back.showDrawingTools).toBe(false);
    expect(queryOf(back)).toBe(queryOf(plot));
  });

  it('writes nothing while on; a link without the key opens with the tools on', () => {
    const plot = opened('?pv=TEST:SINE&range=-1h');
    expect(plotConfigOf(plot, palette)).toBeUndefined();
    expect(queryOf(plot)).not.toContain('showDrawingTools');
    expect(plot.showDrawingTools).toBeUndefined();
  });

  it('reads a written true as on and keeps no key', () => {
    const config = parsePlotConfig(JSON.stringify({ v: 1, showDrawingTools: true }));
    expect(config?.showDrawingTools).toBe(true);
    const plot = opened(
      `?pv=TEST:SINE&range=-1h&plot=${encodeURIComponent(JSON.stringify({ v: 1, showDrawingTools: true }))}`
    );
    expect('showDrawingTools' in plot).toBe(false);
  });
});
