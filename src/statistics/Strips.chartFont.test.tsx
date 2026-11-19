// @vitest-environment jsdom
//
// Strip chart text font: canvas text does not inherit CSS, so the strips hand
// ECharts the family their own section computes, once that family has loaded.
// The option content changes exactly then, which is what makes
// echarts-for-react (it deep-compares options) redraw with the loaded face.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { CORRELATION_METRICS } from '../tools/correlation/metrics';
import { defaultMetrics } from './model';
import { EMPTY_STRIPS } from './history';

interface Captured {
  textStyle?: { fontFamily?: string };
  title?: { text: string; textStyle?: { fontFamily?: string } };
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

const { Strips } = await import('./Strips');

// r, mean and std as strips, in list order (mean, std, r).
const METRICS = defaultMetrics(CORRELATION_METRICS).map((m) => ({
  ...m,
  strip: m.id === 'r' || m.id === 'mean' || m.id === 'std',
}));

// jsdom has no FontFaceSet, so the load is stubbed and settled by hand.
const FAMILY = 'Host Strips';
const ROWS = [{ id: 'y1', label: 'Y1:PV' }];
let style: HTMLStyleElement;
let settle: () => void;
let load: ReturnType<typeof vi.fn<(font: string) => Promise<void>>>;

beforeEach(() => {
  rendered.length = 0;
  style = document.createElement('style');
  style.textContent = `.stats-strips { font-family: "${FAMILY}", sans-serif; }`;
  document.head.appendChild(style);
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

// The mean, std and r options of the last render.
function lastStrips(): Captured[] {
  expect(rendered.length).toBeGreaterThanOrEqual(3);
  return rendered.slice(-3);
}

describe('Strips chart font', () => {
  it("draws all three strips with the section's family once it has loaded", async () => {
    const { container } = render(
      <Strips history={EMPTY_STRIPS} catalog={CORRELATION_METRICS} rows={ROWS} metrics={METRICS} />
    );
    const section = container.querySelector<HTMLElement>('.stats-strips')!;
    const computed = getComputedStyle(section).fontFamily;
    expect(computed).toContain(FAMILY);

    // Loading: one request for the three charts, and no font named yet.
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[0]).toContain(FAMILY);
    const before = lastStrips();
    expect(before.map((o) => o.title?.text)).toEqual(['mean', 'std', 'r']);
    for (const o of before) expect(o.textStyle).toEqual({ fontFamily: undefined });

    await act(async () => {
      settle();
      await Promise.resolve();
      await Promise.resolve();
    });

    const after = lastStrips();
    after.forEach((o, i) => {
      expect(o.textStyle).toEqual({ fontFamily: computed });
      expect(o).not.toEqual(before[i]);
      // The font is the only thing the load changed.
      expect({ ...o, textStyle: before[i].textStyle }).toEqual(before[i]);
      // The title keeps its own size and colour and names no family.
      expect(o.title?.textStyle?.fontFamily).toBeUndefined();
    });
  });

  it('renders no section when no metric is a strip', () => {
    const { container } = render(
      <Strips
        history={EMPTY_STRIPS}
        catalog={CORRELATION_METRICS}
        rows={ROWS}
        metrics={defaultMetrics(CORRELATION_METRICS)}
      />
    );
    expect(container.querySelector('.stats-strips')).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});
