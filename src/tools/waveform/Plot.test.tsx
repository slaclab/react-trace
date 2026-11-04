// @vitest-environment jsdom
// The Waveform canvas component against a mocked ECharts:
// merge mode per publish with `replaceMerge: ['series', 'dataset']` only when the series
// id set changed; each canvas state in order and the Δ message; the
// health line; the statistics row with "n finite / len" for a gap.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const { calls, disposed, resized, chartModel, finished, overlay } = vi.hoisted(() => ({
  calls: [] as { option: Record<string, unknown>; opts: Record<string, unknown> | undefined }[],
  disposed: { count: 0 },
  resized: { count: 0 },
  // What the mocked instance lays out: its size, the grid rect and the axis extents.
  chartModel: {
    width: 640,
    height: 400,
    rect: { x: 64, y: 36, width: 552, height: 316 },
    x: [0, 10] as [number, number],
    y: [0, 100] as [number, number],
  },
  // The live `finished` handlers (the instance's event emitter).
  finished: new Set<() => void>(),
  // Commits inside the drawing layer (the overlay).
  overlay: { commits: 0 },
}));

// The instance APIs the drawing host uses — `on`/`off` with a `finished`
// emitter, the size, the model's grid rect and axis extents, and a linear
// pixel mapping over them.
vi.mock('echarts', () => {
  const m = chartModel;
  const toPx = (finder: { xAxisIndex?: number; yAxisIndex?: number }, v: number) => {
    const r = m.rect;
    if (finder.xAxisIndex !== undefined) {
      return r.x + ((v - m.x[0]) / (m.x[1] - m.x[0])) * r.width;
    }
    return r.y + r.height - ((v - m.y[0]) / (m.y[1] - m.y[0])) * r.height;
  };
  const fromPx = (finder: { xAxisIndex?: number; yAxisIndex?: number }, px: number) => {
    const r = m.rect;
    if (finder.xAxisIndex !== undefined) {
      return m.x[0] + ((px - r.x) / r.width) * (m.x[1] - m.x[0]);
    }
    return m.y[0] + ((r.y + r.height - px) / r.height) * (m.y[1] - m.y[0]);
  };
  return {
    init: () => {
      let alive = true;
      return {
        setOption: (option: Record<string, unknown>, opts?: Record<string, unknown>) => {
          calls.push({ option, opts });
        },
        resize: () => {
          resized.count++;
        },
        dispose: () => {
          alive = false;
          disposed.count++;
        },
        on: (event: string, cb: () => void) => {
          if (event === 'finished') finished.add(cb);
        },
        off: (event: string, cb: () => void) => {
          if (event === 'finished') finished.delete(cb);
        },
        isDisposed: () => !alive,
        getWidth: () => m.width,
        getHeight: () => m.height,
        dispatchAction: () => {},
        convertToPixel: toPx,
        convertFromPixel: fromPx,
        getModel: () => ({
          getComponent: (type: string) => {
            if (type === 'grid') return { coordinateSystem: { getRect: () => ({ ...m.rect }) } };
            const extent = type === 'xAxis' ? m.x : m.y;
            return { axis: { scale: { getExtent: () => [...extent] } } };
          },
        }),
      };
    },
  };
});

// Wrap the real drawing layer in a Profiler: a commit anywhere inside it counts.
vi.mock('../../annotations/AnnotationLayer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../annotations/AnnotationLayer')>();
  const { Profiler, createElement } = await import('react');
  return {
    ...actual,
    AnnotationLayer: (props: Parameters<typeof actual.AnnotationLayer>[0]) =>
      createElement(
        Profiler,
        { id: 'overlay', onRender: () => void (overlay.commits += 1) },
        createElement(actual.AnnotationLayer, props)
      ),
  };
});

/** ECharts finished a frame's layout. */
function emitFinished() {
  act(() => {
    for (const cb of [...finished]) cb();
  });
}

const { WaveformPlot } = await import('./Plot');
const { defaultWaveformState } = await import('./query');
const {
  deriveWaveformModel,
  CANVAS_ADD,
  CANVAS_NONE_DRAWABLE,
  CANVAS_WAITING,
  deltaWaitingMessage,
} = await import('./model');

import type { WaveformState } from './query';
import type { WaveformRingSummary } from './model';
import type { WaveformCurveFrames, WaveformPlotFrames } from './plotOption';

const A = 'WF:A';
const B = 'WF:B';
const R = 'WF:REF';

function ring(length: number | null, connected = true): WaveformRingSummary {
  return { connected, length, resetEpoch: 0, arrival: length === null ? null : 1 };
}

function stateWith(patch: Partial<WaveformState>): WaveformState {
  return { ...defaultWaveformState(), ...patch };
}

function modelOf(
  state: WaveformState,
  rings: Record<string, WaveformRingSummary>,
  egu: Record<string, string> = {}
) {
  const meta: Record<string, { egu: string }> = {};
  for (const pv of Object.keys(rings)) meta[pv] = { egu: egu[pv] ?? 'mm' };
  return deriveWaveformModel({ state, rings, meta, metaTimedOut: false });
}

function frames(
  live: Record<string, number[]>,
  reference: number[] | null = null,
  trails: Record<string, number[][]> = {}
): WaveformPlotFrames {
  const out: Record<string, WaveformCurveFrames> = {};
  for (const [pv, values] of Object.entries(live)) {
    out[pv] = {
      frame: Float64Array.from(values),
      trails: (trails[pv] ?? []).map((t) => Float64Array.from(t)),
    };
  }
  return { live: out, reference: reference ? Float64Array.from(reference) : null, x: null };
}

function seriesIds(i: number): string[] {
  const s = calls[i].option.series as { id: string }[];
  return s.map((x) => x.id).sort();
}

// Every live ResizeObserver callback, so a test can deliver an entry.
const observers = new Set<
  (entries: { contentRect: { width: number; height: number } }[]) => void
>();

function fireResize(width: number, height: number) {
  act(() => {
    for (const cb of observers) cb([{ contentRect: { width, height } }]);
  });
}

beforeEach(() => {
  calls.length = 0;
  disposed.count = 0;
  resized.count = 0;
  observers.clear();
  finished.clear();
  overlay.commits = 0;
  Object.assign(chartModel, {
    width: 640,
    height: 400,
    rect: { x: 64, y: 36, width: 552, height: 316 },
    x: [0, 10],
    y: [0, 100],
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private cb: (entries: { contentRect: { width: number; height: number } }[]) => void;
      constructor(cb: (entries: { contentRect: { width: number; height: number } }[]) => void) {
        this.cb = cb;
      }
      observe() {
        observers.add(this.cb);
      }
      disconnect() {
        observers.delete(this.cb);
      }
      unobserve() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('setOption decisions', () => {
  it('merges per publish and replaces series only when the id set changes', () => {
    const one = stateWith({ pvs: [A] });
    const m1 = modelOf(one, { [A]: ring(3) });
    const { rerender } = render(
      <WaveformPlot state={one} model={m1} frames={frames({ [A]: [1, 2, 3] })} hare="connected" />
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].option.animation).toBe(false);
    expect(seriesIds(0)).toEqual(['live:WF:A']);

    // A new publish, same curves: plain merge.
    rerender(
      <WaveformPlot state={one} model={m1} frames={frames({ [A]: [4, 5, 6] })} hare="connected" />
    );
    expect(calls).toHaveLength(2);
    expect(calls[1].opts).toEqual({});
    expect(calls[1].opts).not.toHaveProperty('notMerge');

    // A curve added: replace the series.
    const two = stateWith({ pvs: [A, B] });
    const m2 = modelOf(two, { [A]: ring(3), [B]: ring(3) });
    rerender(
      <WaveformPlot
        state={two}
        model={m2}
        frames={frames({ [A]: [1, 2, 3], [B]: [3, 2, 1] })}
        hare="connected"
      />
    );
    expect(calls[2].opts).toEqual({ replaceMerge: ['series', 'dataset'] });
    expect(seriesIds(2)).toEqual(['live:WF:A', 'live:WF:B']);

    // Next publish of the same two curves: merge again.
    rerender(
      <WaveformPlot
        state={two}
        model={m2}
        frames={frames({ [A]: [0, 0, 0], [B]: [1, 1, 1] })}
        hare="connected"
      />
    );
    expect(calls[3].opts).toEqual({});

    // A curve removed: replace.
    rerender(
      <WaveformPlot state={one} model={m1} frames={frames({ [A]: [1, 2, 3] })} hare="connected" />
    );
    expect(calls[4].opts).toEqual({ replaceMerge: ['series', 'dataset'] });
    for (const c of calls) {
      for (const s of c.option.series as { animation?: boolean }[]) expect(s.animation).toBe(false);
    }
  });

  it('replaces when persistence changes the trail set', () => {
    const p1 = stateWith({ pvs: [A] });
    const model = modelOf(p1, { [A]: ring(2) });
    const f = frames({ [A]: [1, 2] }, null, {
      [A]: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
    });
    const { rerender } = render(
      <WaveformPlot state={p1} model={model} frames={f} hare="connected" />
    );
    const p3 = { ...p1, persist: 3 };
    rerender(<WaveformPlot state={p3} model={model} frames={f} hare="connected" />);
    expect(calls[1].opts).toEqual({ replaceMerge: ['series', 'dataset'] });
    expect(seriesIds(1)).toEqual(['live:WF:A', 'trail:1:WF:A', 'trail:2:WF:A']);
    rerender(
      <WaveformPlot
        state={p3}
        model={model}
        frames={frames({ [A]: [3, 3] }, null, {
          [A]: [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
        })}
        hare="connected"
      />
    );
    expect(calls[2].opts).toEqual({});
  });

  it('replaces when the reference is toggled', () => {
    const plain = stateWith({ pvs: [A] });
    const withRef = stateWith({ pvs: [A], reference: { kind: 'pv', pv: R } });
    const m0 = modelOf(plain, { [A]: ring(2) });
    const m1 = modelOf(withRef, { [A]: ring(2), [R]: ring(2) });
    const { rerender } = render(
      <WaveformPlot state={plain} model={m0} frames={frames({ [A]: [1, 2] })} hare="connected" />
    );
    rerender(
      <WaveformPlot
        state={withRef}
        model={m1}
        frames={frames({ [A]: [1, 2] }, [0, 0])}
        hare="connected"
      />
    );
    expect(calls[1].opts).toEqual({ replaceMerge: ['series', 'dataset'] });
    expect(seriesIds(1)).toEqual(['live:WF:A', 'ref']);
    rerender(
      <WaveformPlot state={plain} model={m0} frames={frames({ [A]: [1, 2] })} hare="connected" />
    );
    expect(calls[2].opts).toEqual({ replaceMerge: ['series', 'dataset'] });
  });

  it('rebuilds (notMerge) when a fixed y scale goes back to auto under the same ids', () => {
    const fixed = stateWith({ pvs: [A], yScale: { auto: false, min: 5, max: 10 } });
    const auto = stateWith({ pvs: [A] });
    const model = modelOf(auto, { [A]: ring(3) });
    const f = frames({ [A]: [1, 2, 3] });
    const { rerender } = render(
      <WaveformPlot state={fixed} model={model} frames={f} hare="connected" />
    );
    expect(calls[0].option.yAxis).toMatchObject({ min: 5, max: 10 });
    rerender(<WaveformPlot state={auto} model={model} frames={f} hare="connected" />);
    expect(seriesIds(1)).toEqual(seriesIds(0));
    expect(calls[1].opts).toEqual({ notMerge: true });
    expect(calls[1].option.yAxis).not.toHaveProperty('min');
    // The next frame under the same structure merges again.
    rerender(
      <WaveformPlot
        state={auto}
        model={model}
        frames={frames({ [A]: [3, 2, 1] })}
        hare="connected"
      />
    );
    expect(calls[2].opts).toEqual({});
  });

  it('rebuilds (notMerge) when the reference goes from band to dashed', () => {
    const band = stateWith({ pvs: [A], reference: { kind: 'pv', pv: R }, drawAs: 'band' });
    const dashed = { ...band, drawAs: 'dashed' as const };
    const model = modelOf(band, { [A]: ring(2), [R]: ring(2) });
    const f = frames({ [A]: [1, 2] }, [0, 0]);
    const { rerender } = render(
      <WaveformPlot state={band} model={model} frames={f} hare="connected" />
    );
    const refOf = (i: number) =>
      (calls[i].option.series as { id: string }[]).find((x) => x.id === 'ref');
    expect(refOf(0)).toHaveProperty('areaStyle');
    rerender(<WaveformPlot state={dashed} model={model} frames={f} hare="connected" />);
    expect(seriesIds(1)).toEqual(seriesIds(0));
    expect(calls[1].opts).toEqual({ notMerge: true });
    expect(refOf(1)).not.toHaveProperty('areaStyle');
  });

  it('never builds with widthPx 0 and drops sampling when a NaN frame arrives', () => {
    const s = stateWith({ pvs: [A] });
    const model = modelOf(s, { [A]: ring(8) });
    const wide = frames({ [A]: [1, 2, 3, 4, 5, 6, 7, 8] });
    const sampling = (i: number) => (calls[i].option.series as { sampling?: string }[])[0].sampling;
    const { rerender } = render(
      <WaveformPlot state={s} model={model} frames={wide} hare="connected" />
    );
    // Width unknown: drawn unsampled, never as if the plot were 0 px wide.
    expect(sampling(0)).toBeUndefined();
    // A 1 px plot: 8 points exceed the sampling threshold.
    vi.stubGlobal('devicePixelRatio', 1);
    fireResize(1, 100);
    const sampledAt = calls.length - 1;
    expect(sampling(sampledAt)).toBe('minmax');
    rerender(
      <WaveformPlot
        state={s}
        model={model}
        frames={frames({ [A]: [1, NaN, 3, 4, 5, 6, 7, 8] })}
        hare="connected"
      />
    );
    const last = calls.length - 1;
    expect(sampling(last)).toBeUndefined();
    expect(calls[last].opts).toEqual({ notMerge: true });
  });

  it('resizes the chart on a height-only change', () => {
    const s = stateWith({});
    render(<WaveformPlot state={s} model={modelOf(s, {})} frames={frames({})} hare="connected" />);
    fireResize(400, 300);
    const before = resized.count;
    fireResize(400, 200);
    expect(resized.count).toBe(before + 1);
  });

  it('disposes the instance on unmount', () => {
    const s = stateWith({});
    const { unmount } = render(
      <WaveformPlot state={s} model={modelOf(s, {})} frames={frames({})} hare="connected" />
    );
    unmount();
    expect(disposed.count).toBe(1);
  });
});

describe('canvas states', () => {
  const message = () => screen.queryByTestId('waveform-canvas-message');

  it('no live PV: "Add a waveform PV"', () => {
    const s = stateWith({});
    render(<WaveformPlot state={s} model={modelOf(s, {})} frames={frames({})} hare="connected" />);
    expect(message()?.dataset.kind).toBe('add');
    expect(message()?.textContent).toContain(CANVAS_ADD);
  });

  it('nothing drawable: the Waveforms-list message with counts', () => {
    // A is hidden; B is in another unit than A (the axis unit): refused.
    const s = stateWith({ pvs: [A, B], hidden: { [A]: true } });
    const model = modelOf(s, { [A]: ring(3), [B]: ring(3) }, { [A]: 'mm', [B]: 'V' });
    expect(model.canvas.kind).toBe('none-drawable');
    render(<WaveformPlot state={s} model={model} frames={frames({})} hare="connected" />);
    expect(message()?.dataset.kind).toBe('none-drawable');
    expect(message()?.textContent).toContain(CANVAS_NONE_DRAWABLE);
    expect(screen.getByTestId('waveform-canvas-counts').textContent).toBe(
      '2 curves · 1 hidden · 1 refused'
    );
  });

  it('waiting: "waiting for data" before a first frame', () => {
    const s = stateWith({ pvs: [A] });
    const model = modelOf(s, { [A]: ring(null) });
    render(<WaveformPlot state={s} model={model} frames={frames({})} hare="connecting" />);
    expect(message()?.dataset.kind).toBe('waiting');
    expect(message()?.textContent).toContain(CANVAS_WAITING);
  });

  it('Δ without a reference frame shows the Δ message', () => {
    const s = stateWith({ pvs: [A], reference: { kind: 'pv', pv: R }, delta: true });
    const model = modelOf(s, { [A]: ring(3), [R]: ring(null) });
    render(
      <WaveformPlot state={s} model={model} frames={frames({ [A]: [1, 2, 3] })} hare="connected" />
    );
    expect(message()?.dataset.kind).toBe('delta-waiting');
    expect(message()?.textContent).toBe(deltaWaitingMessage(R));
    expect(message()?.textContent).toContain('Δ needs a reference frame — waiting for WF:REF');
  });

  it('ready: no message, and the chart is still mounted in every state', () => {
    const s = stateWith({ pvs: [A] });
    render(
      <WaveformPlot
        state={s}
        model={modelOf(s, { [A]: ring(3) })}
        frames={frames({ [A]: [1, 2, 3] })}
        hare="connected"
      />
    );
    expect(message()).toBeNull();
    expect(screen.getByTestId('waveform-chart')).toBeTruthy();
  });
});

describe('health line', () => {
  it('shows one line for the Hare connection status', () => {
    const s = stateWith({});
    const { rerender } = render(
      <WaveformPlot state={s} model={modelOf(s, {})} frames={frames({})} hare="connected" />
    );
    expect(screen.getAllByTestId('waveform-health')).toHaveLength(1);
    expect(screen.getByTestId('waveform-health').textContent).toBe('Live data connected');
    rerender(
      <WaveformPlot state={s} model={modelOf(s, {})} frames={frames({})} hare="disconnected" />
    );
    const line = screen.getByTestId('waveform-health');
    expect(line.dataset.kind).toBe('disconnected');
    expect(line.textContent).toBe('Live data connection lost — reconnecting…');
    rerender(
      <WaveformPlot state={s} model={modelOf(s, {})} frames={frames({})} hare="connecting" />
    );
    expect(screen.getByTestId('waveform-health').textContent).toBe('Connecting to live data…');
    rerender(<WaveformPlot state={s} model={modelOf(s, {})} frames={frames({})} hare="idle" />);
    expect(screen.getByTestId('waveform-health').textContent).toBe('Not connected to live data');
  });
});

describe('statistics panel', () => {
  it('is absent unless enabled', () => {
    const s = stateWith({ pvs: [A] });
    render(
      <WaveformPlot
        state={s}
        model={modelOf(s, { [A]: ring(3) })}
        frames={frames({ [A]: [1, 2, 3] })}
        hare="connected"
      />
    );
    expect(screen.queryByTestId('stats-panel')).toBeNull();
  });

  it('shows the default columns per drawn curve, n counting the finite elements', () => {
    const s = stateWith({ pvs: [A, B], stats: true });
    const model = modelOf(s, { [A]: ring(4), [B]: ring(4) });
    render(
      <WaveformPlot
        state={s}
        model={model}
        frames={frames({ [A]: [1, NaN, 3, 5], [B]: [2, 2, 2, 2] })}
        hare="connected"
      />
    );
    const heads = [...document.querySelectorAll('.stats-readout thead th')].map(
      (th) => th.textContent
    );
    expect(heads).toEqual(['Curve', 'n', 'mean', 'std', 'rms', 'p-p']);
    const a = screen.getByTestId(`readout-${A}`);
    const cells = [...a.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells[0]).toBe('3'); // n: finite elements
    expect(cells[1]).toBe('3.000 mm'); // mean
    expect(cells[4]).toBe('4.000 mm'); // p-p
    const b = screen.getByTestId(`readout-${B}`);
    expect([...b.querySelectorAll('td')].map((td) => td.textContent)[3]).toBe('2.000 mm'); // rms
  });

  it('counts over the element range, applies Δ, and places the peak by element index', () => {
    const s = stateWith({
      pvs: [A],
      stats: true,
      elems: { first: 1, last: 2 },
      reference: { kind: 'pv', pv: R },
      delta: true,
      metrics: [
        { id: 'n', label: 'n', expr: 'n', unit: '', on: true, strip: false },
        { id: 'mean', label: 'mean', expr: 'mean(y)', unit: 'y', on: true, strip: false },
        {
          id: 'peak',
          label: 'peak at',
          expr: 'at(i, argmax(y))',
          unit: '',
          on: true,
          strip: false,
        },
      ],
    });
    const model = modelOf(s, { [A]: ring(4), [R]: ring(4) });
    render(
      <WaveformPlot
        state={s}
        model={model}
        frames={frames({ [A]: [9, 5, NaN, 9] }, [0, 1, 1, 0])}
        hare="connected"
      />
    );
    const cells = [...screen.getByTestId(`readout-${A}`).querySelectorAll('td')].map(
      (td) => td.textContent
    );
    expect(cells).toEqual(['1', '4.000 mm', '1']);
  });
});

// ── Drawings ─────────────────────────────────────────────

const { DEFAULT_TOOL_PREFS } = await import('../../annotations/tools');
const { ContextMenuProvider } = await import('../../workbench/contextMenu/ContextMenuHost');
const { X_SOURCE_PENDING_HINT, stampNewDrawings } = await import('./measure');

import type { Annotation } from '../../annotations/model';
import type { DrawingDocument } from '../../annotations/host/useDrawingDocument';
import type { WaveformModel } from './model';

function drawing(id: string, kind: string, points: [number, number][]): Annotation {
  return {
    id,
    kind,
    points: points.map(([t, v]) => ({ t, v })),
    axisId: 'y',
    color: '#ff0000',
    width: 1.5,
    text: '',
  };
}

function docOf(annotations: Annotation[], patch: Partial<DrawingDocument> = {}): DrawingDocument {
  return {
    annotations,
    commit: () => {},
    undo: () => {},
    selectedId: null,
    select: () => {},
    prefs: DEFAULT_TOOL_PREFS,
    setPrefs: () => {},
    hidden: false,
    setHidden: () => {},
    ...patch,
  };
}

describe('drawings on the stage', () => {
  it('20 identical frames commit nothing in the overlay; an extent change commits once', () => {
    const s = stateWith({ pvs: [A] });
    const m = modelOf(s, { [A]: ring(3) });
    const doc = docOf([drawing('h1', 'hline', [[0, 50]])]);
    const { rerender } = render(
      <WaveformPlot
        state={s}
        model={m}
        frames={frames({ [A]: [1, 2, 3] })}
        hare="connected"
        drawingDocument={doc}
      />
    );
    emitFinished();
    // The drawing is on the stage, inside the plot's grid.
    const stage = document.querySelector('.waveform-plot__stage')!;
    expect(stage.querySelector('[data-annotation-id="h1"]')).not.toBeNull();

    overlay.commits = 0;
    for (let i = 0; i < 20; i++) {
      rerender(
        <WaveformPlot
          state={s}
          model={m}
          frames={frames({ [A]: [1, 2, 3] })}
          hare="connected"
          drawingDocument={doc}
        />
      );
      emitFinished();
    }
    expect(calls.length).toBeGreaterThanOrEqual(21);
    expect(overlay.commits).toBe(0);

    // The y extent moved: one projection bump, one overlay commit.
    chartModel.y = [0, 200];
    emitFinished();
    expect(overlay.commits).toBe(1);
  });

  it('the measure card follows a new frame and counts only the measured span', () => {
    const s = stateWith({ pvs: [A] });
    const m = modelOf(s, { [A]: ring(3) });
    const doc = docOf([
      drawing('m1', 'measure', [
        [0, 10],
        [1, 30],
      ]),
    ]);
    const { rerender } = render(
      <WaveformPlot
        state={s}
        model={m}
        frames={frames({ [A]: [10, 20, 30] })}
        hare="connected"
        drawingDocument={doc}
      />
    );
    emitFinished();
    const card = () => document.querySelector('[data-measure-card]')?.textContent ?? '';
    // Elements 0 and 1 only; element 2 (x = 2) is outside the span.
    expect(card()).toContain('Δx = 1\u2003Δy = 20 mm');
    expect(card()).toContain('n = 2\u2003x̄ = 15 mm');

    rerender(
      <WaveformPlot
        state={s}
        model={m}
        frames={frames({ [A]: [30, 40, 90] })}
        hare="connected"
        drawingDocument={doc}
      />
    );
    expect(card()).toContain('n = 2\u2003x̄ = 35 mm');
  });

  it('places nothing while the chosen X source is not drawn, and says why', () => {
    const s = stateWith({ pvs: [A], xs: 'WF:X', xAxis: 'source' });
    const base = modelOf(s, { [A]: ring(3), 'WF:X': ring(3) });
    const m: WaveformModel = {
      ...base,
      xAxis: { mode: 'source', label: 'mm', length: 3 },
      x: { pv: 'WF:X', status: 'ok', chip: null, length: 3, egu: 'mm', usable: true },
    } as WaveformModel;
    const commit = vi.fn();
    const doc = docOf([], { commit, prefs: { ...DEFAULT_TOOL_PREFS, tool: 'hline' } });
    render(
      <ContextMenuProvider schemaWriters={{}}>
        <WaveformPlot
          state={s}
          model={m}
          // The source's frame has not arrived: the chart plots the index.
          frames={frames({ [A]: [1, 2, 3] })}
          hare="connected"
          drawingDocument={doc}
        />
      </ContextMenuProvider>
    );
    emitFinished();
    expect(screen.getByText(X_SOURCE_PENDING_HINT)).toBeTruthy();

    // The workbench plot menu offers the adds, disabled.
    const stage = document.querySelector('.waveform-plot__stage')!;
    fireEvent.contextMenu(stage, { clientX: 300, clientY: 200 });
    const add = screen.getByRole('menuitem', { name: 'Add horizontal line here' });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(add);
    expect(commit).not.toHaveBeenCalled();
  });

  it('stamps a drawing added from the plot menu with the rendered x and Δ', () => {
    const s = stateWith({ pvs: [A] });
    const m = modelOf(s, { [A]: ring(3) });
    const commit = vi.fn();
    render(
      <ContextMenuProvider schemaWriters={{}}>
        <WaveformPlot
          state={s}
          model={m}
          frames={frames({ [A]: [1, 2, 3] })}
          hare="connected"
          drawingDocument={docOf([], { commit })}
        />
      </ContextMenuProvider>
    );
    emitFinished();
    expect(screen.queryByText(X_SOURCE_PENDING_HINT)).toBeNull();
    const stage = document.querySelector('.waveform-plot__stage')!;
    fireEvent.contextMenu(stage, { clientX: 300, clientY: 200 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add horizontal line here' }));
    expect(commit).toHaveBeenCalledTimes(1);
    const fn = commit.mock.calls[0][0] as (list: Annotation[]) => Annotation[];
    const [added] = fn([]);
    expect(added.kind).toBe('hline');
    expect(added.xRef).toBe('index');
    expect(added.delta).toBeUndefined();
  });
});

describe('stampNewDrawings', () => {
  const old = drawing('a', 'hline', [[0, 1]]);
  const fresh = drawing('b', 'vline', [[2, 0]]);

  it('stamps only drawings not in the previous list', () => {
    const out = stampNewDrawings([old], [old, fresh], 'src:WF:X', true);
    expect(out[0]).toBe(old);
    expect(out[1]).toEqual({ ...fresh, xRef: 'src:WF:X', delta: true });
  });

  it('leaves `delta` absent when Δ is off', () => {
    const out = stampNewDrawings([], [{ ...fresh, delta: true }], 'index', false);
    expect(out[0].xRef).toBe('index');
    expect('delta' in out[0]).toBe(false);
  });

  it('returns the list itself when nothing is new', () => {
    const list = [old];
    expect(stampNewDrawings([old], list, 'index', false)).toBe(list);
  });
});

// ── The shared plot strip ───────────────────────────────────────────────────

const { PLOT_TOGGLES } = await import('../../plot/plotToggles');

describe('the plot strip', () => {
  const toggle = (name: string) =>
    document.querySelector(
      `[data-drawing-rail] [data-drawing-toggle="${name}"]`
    ) as HTMLButtonElement;

  it('shows every shared toggle; tooltip on and a zoom-box drag by default', () => {
    const s = stateWith({ pvs: [A] });
    const update = vi.fn();
    render(
      <WaveformPlot
        state={s}
        model={modelOf(s, { [A]: ring(3) })}
        frames={frames({ [A]: [1, 2, 3] })}
        hare="connected"
        drawingDocument={docOf([])}
        update={update}
      />
    );
    const names = [...document.querySelectorAll('[data-drawing-toggle]')].map((b) =>
      b.getAttribute('data-drawing-toggle')
    );
    expect(names).toEqual(PLOT_TOGGLES.map((t) => t.toggle));
    expect(toggle('tooltip').getAttribute('aria-pressed')).toBe('true');
    expect(toggle('drag').getAttribute('aria-pressed')).toBe('true');
    act(() => toggle('tooltip').click());
    const fn = update.mock.calls[0][0] as (st: WaveformState) => WaveformState;
    expect(fn(s).tooltip).toBe(false);
  });

  it('the tooltip box follows the toggle, independent of the crosshair', () => {
    const s = stateWith({ pvs: [A], crosshair: false, tooltip: true });
    render(
      <WaveformPlot
        state={s}
        model={modelOf(s, { [A]: ring(3) })}
        frames={frames({ [A]: [1, 2, 3] })}
        hare="connected"
      />
    );
    const tip = calls[calls.length - 1].option.tooltip as { showContent: boolean; show?: boolean };
    expect(tip.showContent).toBe(true);
    expect(tip.show).toBeUndefined();
  });
});

// ── Gestures (the shared plot gesture layer) ────────────────────────────────

describe('gestures', () => {
  it('a zoom box writes the X and Y scales; a double-click returns them to auto', () => {
    let s = stateWith({ pvs: [A] });
    const update = vi.fn((fn: (st: WaveformState) => WaveformState) => {
      s = fn(s);
    });
    render(
      <WaveformPlot
        state={s}
        model={modelOf(s, { [A]: ring(3) })}
        frames={frames({ [A]: [1, 2, 3] })}
        hare="connected"
        update={update}
      />
    );
    emitFinished();
    const stage = document.querySelector('.waveform-plot__stage') as HTMLElement;
    // x 174.4..395.2 is 2..6; y 99.2..257.2 is 80..30.
    act(() => {
      fireEvent.mouseDown(stage, { clientX: 174.4, clientY: 99.2, button: 0 });
      fireEvent.mouseMove(window, { clientX: 395.2, clientY: 257.2, buttons: 1 });
      fireEvent.mouseUp(window, { clientX: 395.2, clientY: 257.2 });
    });
    expect(s.xScale?.auto).toBe(false);
    expect(s.xScale?.min).toBeCloseTo(2, 9);
    expect(s.xScale?.max).toBeCloseTo(6, 9);
    expect(s.yScale?.auto).toBe(false);
    expect(s.yScale?.min).toBeCloseTo(30, 9);
    expect(s.yScale?.max).toBeCloseTo(80, 9);
    act(() => {
      fireEvent.doubleClick(stage, { clientX: 300, clientY: 200, button: 0 });
    });
    expect(s.xScale).toBeUndefined();
    expect(s.yScale).toBeUndefined();
  });
});
