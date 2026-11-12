// @vitest-environment jsdom
//
// Plot context menus. Pins: each AxisMenu item's write (Auto-scale toggles
// `autoScale`; Logarithmic toggles `logScale` and sets `autoScale`; Reset
// scale returns to auto-scale with no manual limits; Invert is present but
// inert), each TimeBandMenu item's write (a preset applies its value, All
// applies the all-loaded relative xAxis and is disabled when there is none),
// close-on-select and Esc, a menu rendered for a second document mounting in
// that document, and SinglePlot's contextmenu routing: Y axis -> AxisMenu, time
// strip -> TimeBandMenu, the interior -> the workbench point menu (Add … here
// commits one drawing at the clicked data point; Reset zoom = one onApplyXAxis
// plus one onUpdateAxis per non-auto axis), plot chrome -> nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { SinglePlot } from '../../../components/PlotArea';
import { TIME_RANGE_PRESETS } from '../fields/timeRange';
import { relativeSpanFor } from '../../../api/time';
import type { ArchiveSeriesResult } from '../../../hooks/useArchiveSeries';
import type { Axis, Plot, PVTrace } from '../../../types';
import { allLoadedXAxis } from '../drawing/time';
import type { Annotation } from '../../../annotations/model';
import { ContextMenuProvider } from '../../../workbench/contextMenu/ContextMenuHost';
import { AxisMenu, TimeBandMenu } from './menus';

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

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

const NOW_MS = 1_800_000_000_000;

function axis(overrides: Partial<Axis> = {}): Axis {
  return {
    id: 'ax1',
    name: 'Current',
    orientation: 'left',
    autoScale: true,
    logScale: false,
    visible: true,
    ...overrides,
  };
}

function trace(id: string): PVTrace {
  return {
    id,
    pvName: id,
    displayName: id,
    color: '#000000',
    visible: true,
    axisId: 'ax1',
    useLive: false,
    useArchive: true,
    data: [],
  } as unknown as PVTrace;
}

function makePlot(traces: PVTrace[] = [], axes: Axis[] = [axis()]): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces,
    axes,
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

function archiveFrom(earliest: number) {
  return new Map<string, ArchiveSeriesResult>([
    [
      't1',
      {
        status: 'success',
        mean: [
          { time: earliest, value: 1 },
          { time: NOW_MS - 1000, value: 2 },
        ],
      } as unknown as ArchiveSeriesResult,
    ],
  ]);
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const item = (root: HTMLElement, name: string) =>
  within(root).getByText(name).closest('li') as HTMLLIElement;

describe('AxisMenu', () => {
  function open(ax: Axis = axis()) {
    const onUpdateAxis = vi.fn();
    const onClose = vi.fn();
    render(
      <AxisMenu
        axis={ax}
        target={document.body}
        x={40}
        y={200}
        onUpdateAxis={onUpdateAxis}
        onClose={onClose}
      />
    );
    return { onUpdateAxis, onClose };
  }

  it('renders Auto-scale, Logarithmic, Invert, a divider and Reset scale', () => {
    open();
    const menu = document.body.querySelector('[data-plot-menu="axis"]') as HTMLElement;
    expect(menu).not.toBeNull();
    const labels = [...menu.querySelectorAll('li')].map((li) => li.textContent?.trim() ?? '');
    expect(labels.filter(Boolean)).toEqual(['Auto-scale', 'Logarithmic', 'Invert', 'Reset scale']);
    expect(menu.querySelectorAll('li[role="separator"], li.cds--menu-item-divider').length).toBe(1);
  });

  it('Logarithmic toggles logScale on and re-enables auto-scale', () => {
    const { onUpdateAxis, onClose } = open(axis({ autoScale: false, min: 1, max: 5 }));
    fireEvent.click(item(document.body, 'Logarithmic'));
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).toHaveBeenCalledWith('ax1', { logScale: true, autoScale: true });
    expect(onClose).toHaveBeenCalled();
  });

  it('Logarithmic toggles logScale off on a log axis', () => {
    const { onUpdateAxis } = open(axis({ logScale: true }));
    fireEvent.click(item(document.body, 'Logarithmic'));
    expect(onUpdateAxis).toHaveBeenCalledWith('ax1', { logScale: false, autoScale: true });
  });

  it('Auto-scale toggles autoScale with a single-key patch', () => {
    const first = open(axis({ autoScale: false }));
    fireEvent.click(item(document.body, 'Auto-scale'));
    expect(first.onUpdateAxis).toHaveBeenCalledWith('ax1', { autoScale: true });
    cleanup();
    const second = open(axis({ autoScale: true }));
    fireEvent.click(item(document.body, 'Auto-scale'));
    expect(second.onUpdateAxis).toHaveBeenCalledWith('ax1', { autoScale: false });
  });

  it('Reset scale returns to auto-scale and clears manual limits', () => {
    const { onUpdateAxis, onClose } = open(axis({ autoScale: false, min: 2, max: 9 }));
    fireEvent.click(item(document.body, 'Reset scale'));
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).toHaveBeenCalledWith('ax1', {
      autoScale: true,
      min: undefined,
      max: undefined,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('Invert is present but disabled and writes nothing', () => {
    const { onUpdateAxis } = open();
    const invert = item(document.body, 'Invert');
    expect(invert.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(invert);
    expect(onUpdateAxis).not.toHaveBeenCalled();
  });

  it('Esc closes without writing', () => {
    const { onUpdateAxis, onClose } = open();
    const menu = document.body.querySelector('[data-plot-menu="axis"]') as HTMLElement;
    fireEvent.keyDown(menu, { key: 'Escape', code: 'Escape', keyCode: 27 });
    expect(onClose).toHaveBeenCalled();
    expect(onUpdateAxis).not.toHaveBeenCalled();
  });
});

describe('TimeBandMenu', () => {
  function open(all: Plot['xAxis'] | null, xAxis: Plot['xAxis'] = { timeRange: '-10m' }) {
    const onApplyXAxis = vi.fn();
    const onClose = vi.fn();
    render(
      <TimeBandMenu
        xAxis={xAxis}
        all={all}
        target={document.body}
        x={400}
        y={350}
        onApplyXAxis={onApplyXAxis}
        onClose={onClose}
      />
    );
    return { onApplyXAxis, onClose };
  }

  it('lists All, then every preset in order', () => {
    open(null);
    const menu = document.body.querySelector('[data-plot-menu="time"]') as HTMLElement;
    const labels = [...menu.querySelectorAll('li')].map((li) => li.textContent?.trim());
    expect(labels).toEqual(['All', ...TIME_RANGE_PRESETS.map((p) => p.label)]);
  });

  it('a preset applies its value, keeping the rest of the xAxis', () => {
    const preset = TIME_RANGE_PRESETS[3];
    const { onApplyXAxis, onClose } = open(null);
    fireEvent.click(item(document.body, preset.label));
    expect(onApplyXAxis).toHaveBeenCalledTimes(1);
    expect(onApplyXAxis).toHaveBeenCalledWith({ timeRange: preset.value });
    expect(onClose).toHaveBeenCalled();
  });

  it('All applies the all-loaded relative xAxis', () => {
    const earliest = NOW_MS - 7_200_000;
    const all = allLoadedXAxis(
      { timeRange: '-10m' },
      { archive: archiveFrom(earliest) },
      ['t1'],
      NOW_MS
    );
    expect(all).toEqual({ timeRange: relativeSpanFor({ from: earliest, to: NOW_MS }, 'up') });
    const { onApplyXAxis } = open(all);
    fireEvent.click(item(document.body, 'All'));
    expect(onApplyXAxis).toHaveBeenCalledTimes(1);
    expect(onApplyXAxis).toHaveBeenCalledWith(all);
  });

  it('All is disabled and inert when nothing is loaded', () => {
    const { onApplyXAxis } = open(null);
    const allItem = item(document.body, 'All');
    expect(allItem.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(allItem);
    expect(onApplyXAxis).not.toHaveBeenCalled();
  });
});

describe('second document', () => {
  it('a menu targeted at another document mounts in that document', () => {
    const popupDoc = document.implementation.createHTMLDocument('popup');
    render(
      <TimeBandMenu
        xAxis={{ timeRange: '-10m' }}
        all={null}
        target={popupDoc.body}
        x={10}
        y={10}
        onClose={() => {}}
      />
    );
    expect(popupDoc.body.querySelector('[data-plot-menu="time"]')).not.toBeNull();
    expect(document.body.querySelector('[data-plot-menu="time"]')).toBeNull();
  });

  it('AxisMenu likewise portals into its target document', () => {
    const popupDoc = document.implementation.createHTMLDocument('popup');
    render(<AxisMenu axis={axis()} target={popupDoc.body} x={10} y={10} onClose={() => {}} />);
    expect(popupDoc.body.querySelector('[data-plot-menu="axis"]')).not.toBeNull();
    expect(document.body.querySelector('[data-plot-menu="axis"]')).toBeNull();
  });
});

describe('SinglePlot contextmenu routing', () => {
  // 800x400 canvas, grid insets top 40 / bottom 60 / left 70 / right 20: the
  // left Y band is x < 70, the time strip y 340..366 over x 70..780.
  function mount(
    plot: Plot = makePlot(),
    archive = new Map<string, ArchiveSeriesResult>(),
    workbench = false
  ) {
    const onUpdateAxis = vi.fn();
    const onApplyXAxis = vi.fn();
    const single = (
      <SinglePlot
        plot={plot}
        archiveResults={archive}
        liveResults={new Map()}
        formulaResults={new Map()}
        onUpdateAxis={onUpdateAxis}
        onApplyXAxis={onApplyXAxis}
      />
    );
    const { container } = render(
      workbench ? <ContextMenuProvider schemaWriters={{}}>{single}</ContextMenuProvider> : single
    );
    const wrap = container.querySelector('[data-plot-id]') as HTMLElement;
    return { wrap, onUpdateAxis, onApplyXAxis };
  }

  const contextmenu = (el: Element, clientX: number, clientY: number) => {
    let notCancelled = true;
    act(() => {
      notCancelled = fireEvent.contextMenu(el, { clientX, clientY, button: 2 });
    });
    return !notCancelled;
  };

  it('right-click on a Y axis opens the AxisMenu and its items write that axis', () => {
    const { wrap, onUpdateAxis } = mount();
    expect(contextmenu(wrap, 40, 200)).toBe(true); // default prevented
    const menu = document.body.querySelector('[data-plot-menu="axis"]') as HTMLElement;
    expect(menu).not.toBeNull();
    // The menu portals to the body, so the chart host stays the wrapper's first child.
    expect(wrap.contains(menu)).toBe(false);
    act(() => {
      fireEvent.click(item(menu, 'Logarithmic'));
    });
    expect(onUpdateAxis).toHaveBeenCalledWith('ax1', { logScale: true, autoScale: true });
    expect(document.body.querySelector('[data-plot-menu="axis"]')).toBeNull();
  });

  it('right-click on the time strip opens the TimeBandMenu with All enabled from loaded data', () => {
    const earliest = NOW_MS - 7_200_000;
    const { wrap, onApplyXAxis } = mount(makePlot([trace('t1')]), archiveFrom(earliest));
    expect(contextmenu(wrap, 400, 350)).toBe(true);
    const menu = document.body.querySelector('[data-plot-menu="time"]') as HTMLElement;
    expect(menu).not.toBeNull();
    act(() => {
      fireEvent.click(item(menu, 'All'));
    });
    expect(onApplyXAxis).toHaveBeenCalledWith({
      timeRange: relativeSpanFor({ from: earliest, to: NOW_MS }, 'up'),
    });
  });

  it('a preset from the time-strip menu applies to the plot', () => {
    const { wrap, onApplyXAxis } = mount();
    contextmenu(wrap, 400, 350);
    const menu = document.body.querySelector('[data-plot-menu="time"]') as HTMLElement;
    expect(item(menu, 'All').getAttribute('aria-disabled')).toBe('true');
    act(() => {
      fireEvent.click(item(menu, TIME_RANGE_PRESETS[0].label));
    });
    expect(onApplyXAxis).toHaveBeenCalledWith({ timeRange: TIME_RANGE_PRESETS[0].value });
  });

  it('plot chrome opens no menu and keeps the native menu', () => {
    const { wrap } = mount();
    const chrome = document.createElement('div');
    chrome.setAttribute('data-drawing-rail', '');
    wrap.appendChild(chrome);
    expect(contextmenu(chrome, 40, 200)).toBe(false);
    expect(contextmenu(chrome, 400, 200)).toBe(false);
    expect(document.body.querySelector('[data-plot-menu]')).toBeNull();
  });

  it('the interior opens the point menu; Add vertical line commits at the cursor', () => {
    // A linear fake: t = 10 * x on the time axis, v = 400 - y on every Y axis.
    const original = fakeInstance.convertFromPixel;
    fakeInstance.convertFromPixel = (finder: object, px: number) =>
      'xAxisIndex' in finder ? px * 10 : 400 - px;
    try {
      const onCommitAnnotations = vi.fn();
      const { container } = render(
        <ContextMenuProvider schemaWriters={{}}>
          <SinglePlot
            plot={makePlot()}
            archiveResults={new Map()}
            liveResults={new Map()}
            formulaResults={new Map()}
            onCommitAnnotations={onCommitAnnotations}
          />
        </ContextMenuProvider>
      );
      const wrap = container.querySelector('[data-plot-id]') as HTMLElement;
      expect(contextmenu(wrap, 400, 200)).toBe(true);
      const menu = document.body.querySelector('[data-plot-menu="context"]') as HTMLElement;
      expect(menu).not.toBeNull();
      expect(wrap.contains(menu)).toBe(false);
      act(() => {
        fireEvent.click(item(menu, 'Add vertical line here'));
      });
      expect(onCommitAnnotations).toHaveBeenCalledTimes(1);
      const [fn, label] = onCommitAnnotations.mock.calls[0];
      expect(label).toBe('Draw V-line');
      const [added] = fn([]) as Annotation[];
      expect(added).toMatchObject({ kind: 'vline', points: [{ t: 4000, v: 0 }], axisId: 'ax1' });
      expect(document.body.querySelector('[data-plot-menu]')).toBeNull();
    } finally {
      fakeInstance.convertFromPixel = original;
    }
  });

  it('the interior point menu Reset zoom writes through the plot writers', () => {
    const plot = makePlot([], [axis(), axis({ id: 'ax2', autoScale: false, min: 1, max: 2 })]);
    const { wrap, onUpdateAxis, onApplyXAxis } = mount(plot, undefined, true);
    expect(contextmenu(wrap, 400, 200)).toBe(true);
    const menu = document.body.querySelector('[data-plot-menu="context"]') as HTMLElement;
    act(() => {
      fireEvent.click(item(menu, 'Reset zoom'));
    });
    expect(onApplyXAxis).toHaveBeenCalledTimes(1);
    expect(onApplyXAxis).toHaveBeenCalledWith({ timeRange: '-10m' });
    expect(onUpdateAxis).toHaveBeenCalledTimes(1);
    expect(onUpdateAxis).toHaveBeenCalledWith('ax2', { autoScale: true });
  });
});
