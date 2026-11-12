// @vitest-environment jsdom
//
// Time plot text font: canvas text does not inherit CSS, so SinglePlot hands
// ECharts the family its own wrapper computes, once that family has loaded.
// The option content changes exactly then, which is what makes
// echarts-for-react (it deep-compares options) redraw with the loaded face.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Plot } from '../types';

interface Captured {
  textStyle?: { fontFamily?: string };
  tooltip?: { textStyle?: { fontFamily?: string } };
  legend?: { textStyle?: { fontFamily?: string } };
  grid?: unknown;
}

const { rendered } = vi.hoisted(() => ({ rendered: [] as Captured[] }));

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  const fakeInstance = {
    getWidth: () => 800,
    getHeight: () => 400,
    isDisposed: () => false,
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
  class MockECharts extends React.Component<{ option: Captured }> {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      rendered.push(this.props.option);
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

import { SinglePlot } from './PlotArea';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function makePlot(): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [],
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
    showLegend: true,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '1h' },
  };
}

function mount() {
  return render(
    <SinglePlot
      plot={makePlot()}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
    />
  );
}

// jsdom has no FontFaceSet, so the load is stubbed and settled by hand. The
// shell requests a family once per document, hence one family per case.
let style: HTMLStyleElement;
let settle: () => void;
let reject: (reason: Error) => void;
let load: ReturnType<typeof vi.fn<(font: string) => Promise<void>>>;

function hostFont(family: string): void {
  style = document.createElement('style');
  style.textContent = `[data-plot-id] { font-family: "${family}", sans-serif; }`;
  document.head.appendChild(style);
}

beforeEach(() => {
  rendered.length = 0;
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  load = vi.fn(
    () =>
      new Promise<void>((resolve, fail) => {
        settle = resolve;
        reject = fail;
      })
  );
  Object.defineProperty(document, 'fonts', { value: { load }, configurable: true });
});

afterEach(() => {
  cleanup();
  style.remove();
  Reflect.deleteProperty(document, 'fonts');
  vi.unstubAllGlobals();
});

function lastOption(): Captured {
  const o = rendered.at(-1);
  if (!o) throw new Error('ReactECharts never rendered');
  return o;
}

async function settled(fn: () => void): Promise<void> {
  await act(async () => {
    fn();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SinglePlot chart font', () => {
  it("draws with its wrapper's family once that family has loaded", async () => {
    const family = 'Host Time Plot';
    hostFont(family);

    const { container } = mount();
    const wrapper = container.querySelector<HTMLElement>('[data-plot-id="p1"]')!;
    const computed = getComputedStyle(wrapper).fontFamily;
    expect(computed).toContain(family);

    // Loading: the family was requested, and the chart names no font yet.
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[0]).toContain(family);
    const before = lastOption();
    expect(before.textStyle?.fontFamily).toBeUndefined();

    await settled(() => settle());

    const after = lastOption();
    expect(after.textStyle?.fontFamily).toBe(computed);
    expect(after.textStyle).not.toEqual(before.textStyle);
    expect(after).not.toEqual(before);
    // The font load moved nothing else: same layout. Every text slot the
    // shared canopy-charts styling names a family in (tooltip, legend) names
    // the wrapper's, once it has loaded, and none before.
    expect(after.grid).toEqual(before.grid);
    expect(before.tooltip?.textStyle?.fontFamily).toBeUndefined();
    expect(before.legend?.textStyle?.fontFamily).toBeUndefined();
    expect(after.tooltip?.textStyle?.fontFamily).toBe(computed);
    expect(after.legend?.textStyle?.fontFamily).toBe(computed);
  });

  it('still names the family when the load fails', async () => {
    const family = 'Host Missing Face';
    hostFont(family);

    const { container } = mount();
    const computed = getComputedStyle(
      container.querySelector<HTMLElement>('[data-plot-id="p1"]')!
    ).fontFamily;
    expect(lastOption().textStyle?.fontFamily).toBeUndefined();

    await settled(() => reject(new Error('no such face')));

    expect(lastOption().textStyle?.fontFamily).toBe(computed);
  });
});
