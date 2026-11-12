// @vitest-environment jsdom
//
// Correlation plot text font: canvas text does not inherit CSS, so the plot
// hands ECharts the family its own box computes, once that family has loaded.
// The option content changes exactly then, which is what makes
// echarts-for-react (it deep-compares options) redraw with the loaded face.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { TableResultDTO } from '@slaclab/canopy-client';
import type { FrameLike } from './stats';

interface Captured {
  textStyle?: { fontFamily?: string };
  legend?: { textStyle?: { fontFamily?: string } };
  series?: unknown[];
}

const { rendered } = vi.hoisted(() => ({ rendered: [] as Captured[] }));

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component<{ option: Captured }> {
    render() {
      rendered.push(this.props.option);
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

const { CorrelationPlot } = await import('./Plot');

const S = 1_000_000_000;
const BASE = 1_790_000_000_000_000_000;

function frame(rows: number): FrameLike {
  const tsNs = Array.from({ length: rows }, (_, i) => BASE + i * S);
  const table: TableResultDTO = {
    tsNs,
    columns: { x: tsNs.map((_, i) => i), y1: tsNs.map((_, i) => 2 * i + 1) },
    inputs: {},
    totalRows: rows,
  };
  return { table, columnPvs: { x: 'X:PV', y1: 'Y1:PV' } };
}

const unitsOf = () => '';

// jsdom has no FontFaceSet, so the load is stubbed and settled by hand. The
// shell requests a family once per document, hence one family per case.
let style: HTMLStyleElement;
let settle: () => void;
let load: ReturnType<typeof vi.fn<(font: string) => Promise<void>>>;

function hostFont(family: string): void {
  style = document.createElement('style');
  style.textContent = `.correlation-plot__box { font-family: "${family}", sans-serif; }`;
  document.head.appendChild(style);
}

beforeEach(() => {
  rendered.length = 0;
  load = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      })
  );
  Object.defineProperty(document, 'fonts', { value: { load }, configurable: true });
});

afterEach(() => {
  cleanup();
  style.remove();
  Reflect.deleteProperty(document, 'fonts');
});

function lastOption(): Captured {
  const o = rendered.at(-1);
  if (!o) throw new Error('ReactECharts never rendered');
  return o;
}

// An option's data, without its functions.
function plain(option: Captured): unknown {
  return JSON.parse(JSON.stringify(option));
}

async function fontLoaded(): Promise<void> {
  await act(async () => {
    settle();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('CorrelationPlot chart font', () => {
  it.each(['scatter', 'density'] as const)(
    "the %s view draws with its box's family once that family has loaded",
    async (view) => {
      const family = `Host Correlation ${view}`;
      hostFont(family);

      const { container } = render(
        <CorrelationPlot frame={frame(5)} view={view} densityPv="Y1:PV" unitsOf={unitsOf} />
      );
      const box = container.querySelector<HTMLElement>('.correlation-plot__box')!;
      const computed = getComputedStyle(box).fontFamily;
      expect(computed).toContain(family);

      // Loading: the family was requested, and the chart names no font yet.
      expect(load).toHaveBeenCalledTimes(1);
      expect(load.mock.calls[0]?.[0]).toContain(family);
      const before = lastOption();
      expect(before.textStyle).toEqual({ fontFamily: undefined });

      await fontLoaded();

      const after = lastOption();
      expect(after.textStyle).toEqual({ fontFamily: computed });
      expect(after).not.toEqual(before);
      // The font is the only thing the load changed (the density view builds
      // fresh renderer closures per option, so the data is compared).
      expect(plain({ ...after, textStyle: before.textStyle })).toEqual(plain(before));
      // The legend keeps its own colour and names no family.
      expect(after.legend?.textStyle?.fontFamily).toBeUndefined();
    }
  );

  it('keeps the font across a new frame', async () => {
    const family = 'Host Correlation frames';
    hostFont(family);
    const { container, rerender } = render(
      <CorrelationPlot frame={frame(5)} view="scatter" densityPv="Y1:PV" unitsOf={unitsOf} />
    );
    const computed = getComputedStyle(
      container.querySelector<HTMLElement>('.correlation-plot__box')!
    ).fontFamily;
    await fontLoaded();

    rerender(
      <CorrelationPlot frame={frame(8)} view="scatter" densityPv="Y1:PV" unitsOf={unitsOf} />
    );
    expect(lastOption().textStyle).toEqual({ fontFamily: computed });
    // Read once per mount: a data tick asks for no second load.
    expect(load).toHaveBeenCalledTimes(1);
  });
});
