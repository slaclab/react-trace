// @vitest-environment jsdom
// The rate rule on Waveform's workbench: a stream of Hare
// frames that changes no card status re-renders the canvas, but commits
// neither half of the properties panel (the Outline's lists and cards, the
// plot-wide sections) — 50 frames, 0 commits, both with nothing selected and
// with a Live card open. A status change (a curve disconnects) still reaches
// the Outline. The drawing overlay commits nothing over the same stream
// either.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { HareConnectionStatus } from '@slaclab/canopy-client';
import { FakeHare, type FakeValue } from '../shared/fakeHare.test-util';

const { commits, setOptions } = vi.hoisted(() => ({
  commits: { outline: 0, settings: 0, overlay: 0 },
  setOptions: { count: 0 },
}));

// The instance APIs the drawing host uses. Each setOption ends in a
// `finished`; the layout never moves, so the projection gate bumps once.
vi.mock('echarts', () => ({
  init: () => {
    let alive = true;
    const finished = new Set<() => void>();
    const rect = { x: 64, y: 36, width: 552, height: 316 };
    return {
      setOption: () => {
        setOptions.count += 1;
        for (const cb of [...finished]) cb();
      },
      resize: () => {},
      dispose: () => {
        alive = false;
      },
      getDataURL: () => 'data:image/png;base64,AAAA',
      on: (event: string, cb: () => void) => {
        if (event === 'finished') finished.add(cb);
      },
      off: (event: string, cb: () => void) => {
        if (event === 'finished') finished.delete(cb);
      },
      isDisposed: () => !alive,
      getWidth: () => 640,
      getHeight: () => 400,
      dispatchAction: () => {},
      convertToPixel: (f: { xAxisIndex?: number }, v: number) =>
        f.xAxisIndex !== undefined ? rect.x + v * 10 : rect.y + rect.height - v,
      convertFromPixel: (f: { xAxisIndex?: number }, px: number) =>
        f.xAxisIndex !== undefined ? (px - rect.x) / 10 : rect.y + rect.height - px,
      getModel: () => ({
        getComponent: (type: string) =>
          type === 'grid'
            ? { coordinateSystem: { getRect: () => ({ ...rect }) } }
            : { axis: { scale: { getExtent: () => [0, 10] } } },
      }),
    };
  },
}));

vi.mock('../../hooks/useElogConfig', () => ({ useElogConfig: () => null }));

// Wrap the real Outline and PlotSettings in Profilers: a commit anywhere
// inside either half counts.
vi.mock('../../workbench/Outline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workbench/Outline')>();
  const { Profiler, createElement } = await import('react');
  return {
    ...actual,
    Outline: (props: Parameters<typeof actual.Outline>[0]) =>
      createElement(
        Profiler,
        { id: 'outline', onRender: () => void (commits.outline += 1) },
        createElement(actual.Outline, props)
      ),
  };
});

vi.mock('../../workbench/PlotSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workbench/PlotSettings')>();
  const { Profiler, createElement } = await import('react');
  return {
    ...actual,
    PlotSettings: (props: Parameters<typeof actual.PlotSettings>[0]) =>
      createElement(
        Profiler,
        { id: 'settings', onRender: () => void (commits.settings += 1) },
        createElement(actual.PlotSettings, props)
      ),
  };
});

// The drawing layer too: a stream of frames must not re-render the overlay.
vi.mock('../../annotations/AnnotationLayer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../annotations/AnnotationLayer')>();
  const { Profiler, createElement } = await import('react');
  return {
    ...actual,
    AnnotationLayer: (props: Parameters<typeof actual.AnnotationLayer>[0]) =>
      createElement(
        Profiler,
        { id: 'overlay', onRender: () => void (commits.overlay += 1) },
        createElement(actual.AnnotationLayer, props)
      ),
  };
});

const { WaveformApp } = await import('./App');

const A = 'WF:A';
const B = 'WF:B';

function wf(...values: number[]): FakeValue {
  return { connected: true, valueKind: 'waveform', value: values };
}

class Hare extends FakeHare {
  status: HareConnectionStatus = 'connected';
}

function mount(query: string) {
  window.history.replaceState(null, '', `/waveform.html?${query}`);
  const hare = new Hare();
  const pending: Array<() => void> = [];
  let t = 1000;
  render(
    <WaveformApp
      hare={hare}
      controllerOptions={{
        now: () => t++,
        requestFrame: (cb) => pending.push(cb),
        cancelFrame: () => {
          pending.length = 0;
        },
        setTimer: () => 0,
        clearTimer: () => {},
      }}
    />
  );
  return {
    hare,
    flush() {
      act(() => {
        for (const cb of pending.splice(0)) cb();
      });
    },
  };
}

/** `n` frames of both curves, each published, statuses unchanged. */
function stream(m: ReturnType<typeof mount>, n: number): void {
  for (let i = 0; i < n; i++) {
    act(() =>
      m.hare.diff([
        [A, wf(i, i + 1, i + 2)],
        [B, wf(-i, i * 2, 3)],
      ])
    );
    m.flush();
  }
}

beforeEach(() => {
  commits.outline = 0;
  commits.settings = 0;
  commits.overlay = 0;
  setOptions.count = 0;
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('WaveformApp render rate', () => {
  it('50 Hare frames with unchanged status cause 0 Outline and 0 plot-settings commits', () => {
    const m = mount(`pv=${A}&pv=${B}`);
    act(() =>
      m.hare.initial([
        [A, 'mm', wf(1, 2, 3)],
        [B, 'mm', wf(4, 5, 6)],
      ])
    );
    m.flush();
    // Let the first frames settle the statuses.
    stream(m, 2);
    // Both halves are mounted (the counter sees them).
    expect(commits.outline).toBeGreaterThan(0);
    expect(commits.settings).toBeGreaterThan(0);

    commits.outline = 0;
    commits.settings = 0;
    // The drawing layer is mounted too.
    expect(commits.overlay).toBeGreaterThan(0);
    commits.overlay = 0;
    const drawnBefore = setOptions.count;
    stream(m, 50);

    // The canvas drew every frame …
    expect(setOptions.count - drawnBefore).toBeGreaterThanOrEqual(50);
    // … and neither half committed, nor the drawing overlay.
    expect(commits.outline).toBe(0);
    expect(commits.settings).toBe(0);
    expect(commits.overlay).toBe(0);
  });

  it('holds with a Live card open', () => {
    const m = mount(`pv=${A}&pv=${B}`);
    act(() =>
      m.hare.initial([
        [A, 'mm', wf(1, 2, 3)],
        [B, 'mm', wf(4, 5, 6)],
      ])
    );
    m.flush();
    stream(m, 2);
    const row = document.querySelector(`[data-row-id="live:${A}"]`);
    expect(row).not.toBeNull();
    commits.settings = 0;
    fireEvent.click(row!);
    // The selection reached the plot settings.
    expect(commits.settings).toBeGreaterThan(0);
    stream(m, 2);

    commits.outline = 0;
    commits.settings = 0;
    stream(m, 50);
    expect(commits.outline).toBe(0);
    expect(commits.settings).toBe(0);
  });

  it('a status change still reaches the Outline', () => {
    const m = mount(`pv=${A}&pv=${B}`);
    act(() =>
      m.hare.initial([
        [A, 'mm', wf(1, 2, 3)],
        [B, 'mm', wf(4, 5, 6)],
      ])
    );
    m.flush();
    stream(m, 2);
    commits.outline = 0;

    act(() => m.hare.diff([[B, { connected: false, valueKind: 'waveform', value: [4, 5, 6] }]]));
    m.flush();
    expect(commits.outline).toBeGreaterThan(0);
  });
});
