// @vitest-environment jsdom
//
// Turning Auto-scale off keeps the Y range on screen, as on main: Min and Max
// are seeded from the range the chart last drew for that axis (reported on
// its `finished` event), so the axis freezes where it was instead of jumping
// to a range that includes zero. Limits already set are kept, and with no
// drawn range the toggle only switches Auto-scale off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { TraceApp } from './TraceApp';
import { WithCanopy } from '../test/canopy';
import { chartStub, fireChartEvent } from '../test/chartStub';

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);

// A chart whose first Y axis spans the given extent.
function fakeChart(extent: [number, number]) {
  const model = {
    getComponent: (type: string, idx: number) =>
      type === 'yAxis' && idx === 0
        ? { axis: { scale: { getExtent: (): [number, number] => extent } } }
        : undefined,
  };
  return {
    getWidth: () => 800,
    getHeight: () => 400,
    isDisposed: () => false,
    getZr: () => ({ setCursorStyle: () => {}, on: () => {}, off: () => {} }),
    getModel: () => model,
    convertToPixel: () => 0,
    convertFromPixel: () => 0,
    getDataURL: () => '',
    resize: () => {},
    dispatchAction: () => {},
    on: () => {},
    off: () => {},
  };
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  // No backend: the e-log probe and any archive request fail at once.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline')))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  chartStub.instance = undefined;
  chartStub.props = null;
});

function openAxes() {
  const head = document.querySelector<HTMLElement>(
    '.wb-plot-section[data-section="axes"] .wb-plot-section__head'
  );
  if (!head) throw new Error('no Axes section');
  fireEvent.click(head);
}

const byId = (id: string) => document.getElementById(id);
const value = (id: string) => (byId(id) as HTMLInputElement | null)?.value;

function mount(extent: [number, number] | null) {
  if (extent) chartStub.instance = fakeChart(extent);
  render(<TraceApp />, { wrapper: WithCanopy });
  if (extent) act(() => fireChartEvent('finished', {}));
  openAxes();
}

describe('Auto-scale off keeps the shown Y range', () => {
  it('seeds Min and Max from the range the chart last drew', () => {
    mount([12.5, 87.5]);
    expect(byId('axis-min')).toBeNull();
    act(() => {
      fireEvent.click(byId('axis-autoscale')!);
    });
    expect(value('axis-min')).toBe('12.5');
    expect(value('axis-max')).toBe('87.5');
  });

  it('keeps limits already set when Auto-scale goes off again', () => {
    mount([12.5, 87.5]);
    act(() => {
      fireEvent.click(byId('axis-autoscale')!);
    });
    act(() => {
      fireEvent.change(byId('axis-min')!, { target: { value: '-5' } });
      // Number fields commit on blur or Enter.
      fireEvent.blur(byId('axis-min')!);
    });
    act(() => {
      fireEvent.click(byId('axis-autoscale')!);
    });
    act(() => {
      fireEvent.click(byId('axis-autoscale')!);
    });
    expect(value('axis-min')).toBe('-5');
    expect(value('axis-max')).toBe('87.5');
  });

  it('with no drawn range, only switches Auto-scale off', () => {
    mount(null);
    act(() => {
      fireEvent.click(byId('axis-autoscale')!);
    });
    expect(value('axis-min')).toBe('');
    expect(value('axis-max')).toBe('');
  });
});
