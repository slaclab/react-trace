// @vitest-environment jsdom
// The Waveform tool root before the workbench binds to it: state parsed from the URL, every write
// through edit.ts, one WaveformController feeding the Plot and its health
// line. Over a faked Hare whose WAVEFORM frames hold a null element and a
// mocked ECharts: two live arrays draw (the null as a NaN gap); a snapshot set
// through edit with Δ on draws zero on the forced publish; a hidden page
// publishes nothing.
//
// On the workbench: the
// sidebar lists Live / Reference / X source; the actions bar carries Pause (a
// pressed toggle), Snapshot → reference, Export CSV / PNG, Post to e-log only
// under the `elog` capability, and the standard actions. Snapshot captures
// every visible drawable live curve and replaces any reference, Δ re-zeroing
// on that click's forced publish; a curve added after it is not drawn in Δ and
// carries the "not in snapshot" chip.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { HareConnectionStatus } from '@slaclab/canopy-client';
import { FakeHare, type FakeValue } from '../shared/fakeHare.test-util';

const { calls, elog, downloads } = vi.hoisted(() => ({
  calls: [] as { option: Record<string, unknown>; opts: Record<string, unknown> | undefined }[],
  elog: { enabled: false },
  downloads: { csv: [] as unknown[], png: [] as unknown[] },
}));

// The logbook listing: `elog.enabled` decides whether it "loaded".
vi.mock('../../hooks/useElogConfig', () => ({
  useElogConfig: () => (elog.enabled ? { enabled: true, defaultLogbookIds: [] } : null),
}));

// The downloads are recorded, not performed.
vi.mock('./export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./export')>();
  return {
    ...actual,
    downloadWaveformCsv: (data: unknown) => void downloads.csv.push(data),
    downloadWaveformPng: (...args: unknown[]) => void downloads.png.push(args),
  };
});

// The instance APIs the drawing host uses. Each setOption ends in a
// `finished` (the layout ran); the grid and extents are fixed, so the
// projection gate bumps once. Pixels map linearly: x 0..10 over the grid's
// width, y 0..100 over its height.
vi.mock('echarts', () => {
  const rect = { x: 64, y: 36, width: 552, height: 316 };
  const X = [0, 10];
  const Y = [0, 100];
  return {
    init: () => {
      let alive = true;
      const finished = new Set<() => void>();
      return {
        setOption: (option: Record<string, unknown>, opts?: Record<string, unknown>) => {
          calls.push({ option, opts });
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
          f.xAxisIndex !== undefined
            ? rect.x + ((v - X[0]) / (X[1] - X[0])) * rect.width
            : rect.y + rect.height - ((v - Y[0]) / (Y[1] - Y[0])) * rect.height,
        convertFromPixel: (f: { xAxisIndex?: number }, px: number) =>
          f.xAxisIndex !== undefined
            ? X[0] + ((px - rect.x) / rect.width) * (X[1] - X[0])
            : Y[0] + ((rect.y + rect.height - px) / rect.height) * (Y[1] - Y[0]),
        getModel: () => ({
          getComponent: (type: string) =>
            type === 'grid'
              ? { coordinateSystem: { getRect: () => ({ ...rect }) } }
              : { axis: { scale: { getExtent: () => (type === 'xAxis' ? [...X] : [...Y]) } } },
        }),
      };
    },
  };
});

const { WaveformApp } = await import('./App');
const { addPv, setDelta, setSnapshot } = await import('./edit');
const { NOT_IN_SNAPSHOT } = await import('./model');
const { liveId } = await import('./plotOption');

import type { WaveformTool } from './App';

const A = 'WF:A';
const B = 'WF:B';

/** The WAVEFORM fixture of the correlation fake, with a null element. */
function wf(...values: Array<number | null>): FakeValue {
  return { connected: true, valueKind: 'waveform', value: values as number[] };
}

/** The fake Hare with the socket status the health line reads. */
class Hare extends FakeHare {
  status: HareConnectionStatus = 'connected';
}

interface Mounted {
  hare: Hare;
  tool: WaveformTool;
  /** Pending animation-frame callbacks. */
  pending: Array<() => void>;
  /** Run the pending animation frames. */
  flush(): void;
}

function mount(query: string): Mounted {
  window.history.replaceState(null, '', `/waveform.html${query === '' ? '' : `?${query}`}`);
  const hare = new Hare();
  const pending: Array<() => void> = [];
  let tool: WaveformTool | null = null;
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
      onTool={(t2) => {
        tool = t2;
      }}
    />
  );
  if (tool === null) throw new Error('no tool handle');
  return {
    hare,
    tool,
    pending,
    flush() {
      act(() => {
        for (const cb of pending.splice(0)) cb();
      });
    },
  };
}

function lastOption(): Record<string, unknown> {
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1].option;
}

/** The dataset column a series draws, as plain numbers (NaN kept). */
function column(id: string): number[] | undefined {
  const dataset = lastOption().dataset as { source: Record<string, Float64Array> } | undefined;
  const col = dataset?.source[id];
  return col === undefined ? undefined : Array.from(col);
}

function seriesIds(): string[] {
  return ((lastOption().series as { id: string }[]) ?? []).map((s) => s.id).sort();
}

let visibility: DocumentVisibilityState = 'visible';

function setPageVisible(visible: boolean): void {
  visibility = visible ? 'visible' : 'hidden';
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

// Carbon's multiselect (the e-log dialog) measures with ResizeObserver.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

beforeEach(() => {
  calls.length = 0;
  elog.enabled = false;
  downloads.csv.length = 0;
  downloads.png.length = 0;
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('WaveformApp', () => {
  it('draws two live arrays from the URL, the null element as a NaN gap', () => {
    const m = mount(`pv=${A}&pv=${B}`);
    expect(m.hare.subscribed()).toEqual([A, B]);
    expect(screen.getByTestId('waveform-health').textContent).toBe('Live data connected');

    act(() =>
      m.hare.initial([
        [A, 'mm', wf(1, null, 3)],
        [B, 'mm', wf(4, 5, 6)],
      ])
    );
    m.flush();

    expect(seriesIds()).toEqual([liveId(A), liveId(B)].sort());
    const a = column(liveId(A))!;
    expect(a[0]).toBe(1);
    expect(Number.isNaN(a[1])).toBe(true);
    expect(a[2]).toBe(3);
    expect(column(liveId(B))).toEqual([4, 5, 6]);
    expect(screen.queryByTestId('waveform-canvas-message')).toBeNull();
  });

  it('draws Δ zero on the forced publish after a snapshot set through edit', () => {
    const m = mount(`pv=${A}`);
    act(() => m.hare.initial([[A, 'mm', wf(1, null, 3)]]));
    m.flush();
    expect(column(liveId(A))![0]).toBe(1);

    // A new frame arrives but is not yet published.
    act(() => m.hare.diff([[A, wf(7, null, 9)]]));
    expect(m.pending).toHaveLength(1);

    // A snapshot of the newest frame, set through edit with Δ on (taken after
    // the ring's reset epoch, so it counts for the curve): the forced publish
    // draws the ring's newest frame minus the snapshot.
    act(() =>
      m.tool.update((s) =>
        setDelta(
          setSnapshot(s, { frames: { [A]: Float64Array.from([7, NaN, 9]) }, time: 1_000_000 }),
          true
        )
      )
    );
    expect(m.tool.getState().delta).toBe(true);
    expect(m.tool.getState().reference?.kind).toBe('snapshot');
    // The forced publish took the pending frame: no animation frame was run.
    expect(m.pending).toHaveLength(0);

    const delta = column(liveId(A))!;
    expect(delta[0]).toBe(0);
    expect(Number.isNaN(delta[1])).toBe(true);
    expect(delta[2]).toBe(0);
  });

  it('takes the snapshot from the controller: Δ against it is zero at once', () => {
    const m = mount(`pv=${A}`);
    act(() => m.hare.initial([[A, 'mm', wf(2, null, 5)]]));
    m.flush();

    act(() => {
      expect(m.tool.takeSnapshot()).toBe(true);
    });
    act(() => m.tool.update((s) => setDelta(s, true)));

    const delta = column(liveId(A))!;
    expect(delta[0]).toBe(0);
    expect(Number.isNaN(delta[1])).toBe(true);
    expect(delta[2]).toBe(0);
  });

  it('publishes nothing while the page is hidden, and once at once when shown', () => {
    const m = mount(`pv=${A}`);
    act(() => m.hare.initial([[A, 'mm', wf(1, null, 3)]]));
    m.flush();
    expect(column(liveId(A))![0]).toBe(1);

    setPageVisible(false);
    act(() => m.hare.diff([[A, wf(8, null, 8)]]));
    expect(m.pending).toHaveLength(0);
    m.flush();
    expect(column(liveId(A))![0]).toBe(1);

    setPageVisible(true);
    expect(column(liveId(A))![0]).toBe(8);
  });

  it('renders the canvas state from state alone: no PV asks for one', () => {
    mount('');
    expect(screen.getByTestId('waveform-canvas-message').textContent).toContain(
      'Add a waveform PV'
    );
  });

  it('applies persistence, averaging and statistics from the URL', () => {
    const m = mount(`pv=${A}&persist=3&avg=2&stats=1`);
    act(() => m.hare.initial([[A, 'mm', wf(1, null, 3)]]));
    m.flush();
    act(() => m.hare.diff([[A, wf(3, null, 5)]]));
    m.flush();

    // Averaged over two frames: (1+3)/2, the gap stays a gap, (3+5)/2.
    const a = column(liveId(A))!;
    expect(a[0]).toBe(2);
    expect(Number.isNaN(a[1])).toBe(true);
    expect(a[2]).toBe(4);
    // Persistence: a trail is drawn beside the live curve.
    expect(seriesIds().some((id) => id.startsWith('trail:'))).toBe(true);
    // Statistics: n counts the finite elements of the averaged frame.
    const cells = [...screen.getByTestId(`readout-${A}`).querySelectorAll('td')];
    expect(cells[0]?.textContent).toBe('2');
  });

  it('releases every listener on unmount', () => {
    const m = mount(`pv=${A}&pv=${B}`);
    expect(m.hare.listenerCount()).toBe(2);
    cleanup();
    expect(m.hare.listenerCount()).toBe(0);
  });
});

// ------------------------------------------------------------- workbench --

function actionsBar(): HTMLElement {
  return screen.getByTestId('actions-bar');
}

/** The action button whose accessible name starts with `label`. */
function action(label: string): HTMLElement {
  return within(actionsBar()).getByRole('button', {
    name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  });
}

/** The actions bar's visible labels, in bar order. */
function actionNames(): string {
  return actionsBar().textContent ?? '';
}

describe('WaveformApp on the workbench', () => {
  it('shows the sidebar with Signals, Reference and X axis PV beside the canvas', () => {
    mount(`pv=${A}`);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Signals');
    expect(text).toContain('Reference');
    expect(text).toContain('X axis PV');
    // The canvas is the layout's child slot.
    expect(screen.getByTestId('waveform-health')).toBeTruthy();
  });

  it('registers Pause, Snapshot → reference, Export and the standard actions; no e-log without a logbook', () => {
    mount(`pv=${A}`);
    const names = actionNames();
    expect(names).toMatch(/Pause/);
    expect(names).toMatch(/Snapshot → reference/);
    expect(names).toMatch(/Export CSV/);
    expect(names).toMatch(/Export PNG/);
    expect(names).toMatch(/Switch to (dark|light) mode/);
    expect(names).toMatch(/Report a bug/);
    expect(names).toMatch(/Docs/);
    // Hidden, not disabled.
    expect(names).not.toMatch(/E-Log/);
  });

  it('shows Post to e-log once the logbook listing loaded', () => {
    elog.enabled = true;
    const m = mount(`pv=${A}`);
    act(() => m.hare.initial([[A, 'mm', wf(1, 2, 3)]]));
    m.flush();
    fireEvent.click(action('Post to E-Log'));
    // The dialog opens with the chart captured as one PNG.
    expect(screen.getByAltText('Preview of Waveform')).toBeTruthy();
  });

  it('keeps Export and Snapshot visible but disabled, with reasons, until data is published', () => {
    const m = mount(`pv=${A}`);
    expect(action('Export CSV').getAttribute('aria-disabled')).toBe('true');
    expect(action('Export PNG').getAttribute('aria-disabled')).toBe('true');
    expect(action('Snapshot → reference').getAttribute('aria-disabled')).toBe('true');

    act(() => m.hare.initial([[A, 'mm', wf(1, 2, 3)]]));
    m.flush();
    expect(action('Export CSV').getAttribute('aria-disabled')).toBeNull();
    expect(action('Snapshot → reference').getAttribute('aria-disabled')).toBeNull();
  });

  it('Pause is a pressed toggle that freezes the published frames', () => {
    const m = mount(`pv=${A}`);
    act(() => m.hare.initial([[A, 'mm', wf(1, 2, 3)]]));
    m.flush();
    expect(action('Pause').getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(action('Pause'));
    expect(action('Pause').getAttribute('aria-pressed')).toBe('true');
    act(() => m.hare.diff([[A, wf(9, 9, 9)]]));
    m.flush();
    expect(column(liveId(A))).toEqual([1, 2, 3]);

    fireEvent.click(action('Pause'));
    expect(action('Pause').getAttribute('aria-pressed')).toBe('false');
    m.flush();
    expect(column(liveId(A))).toEqual([9, 9, 9]);
  });

  it('Snapshot captures every visible drawable live curve and Δ re-zeroes on that click', () => {
    const m = mount(`pv=${A}&pv=${B}`);
    act(() =>
      m.hare.initial([
        [A, 'mm', wf(1, null, 3)],
        [B, 'mm', wf(4, 5, 6)],
      ])
    );
    m.flush();
    act(() =>
      m.tool.update((s) =>
        setSnapshot(s, {
          frames: { [A]: Float64Array.from([0, 0, 0]), [B]: Float64Array.from([0, 0, 0]) },
          time: 1_000_000,
        })
      )
    );
    act(() => m.tool.update((s) => setDelta(s, true)));
    // A new frame arrives but is not yet published.
    act(() =>
      m.hare.diff([
        [A, wf(7, null, 9)],
        [B, wf(1, 1, 1)],
      ])
    );
    expect(m.pending.length).toBeGreaterThan(0);

    fireEvent.click(action('Snapshot → reference'));

    const ref = m.tool.getState().reference;
    expect(ref?.kind).toBe('snapshot');
    if (ref?.kind !== 'snapshot') throw new Error('no snapshot');
    expect(Object.keys(ref.frames).sort()).toEqual([A, B].sort());
    // The last *published* frames, not the pending ones.
    expect(Array.from(ref.frames[B])).toEqual([4, 5, 6]);
    // The forced publish took the pending frames and drew Δ against the new
    // snapshot (taken from the frames published before it): no animation frame ran.
    expect(m.pending).toHaveLength(0);
    expect(column(liveId(B))).toEqual([-3, -4, -5]);

    // Snapshot again: the reference is re-taken from what is now published and Δ is zero.
    fireEvent.click(action('Snapshot → reference'));
    const a = column(liveId(A))!;
    expect(a[0]).toBe(0);
    expect(Number.isNaN(a[1])).toBe(true);
    expect(a[2]).toBe(0);
    expect(column(liveId(B))).toEqual([0, 0, 0]);
  });

  it('Snapshot skips a hidden curve and replaces a PV reference', () => {
    const R = 'WF:R';
    const m = mount(`pv=${A}&pv=${B}&ref=${R}`);
    act(() =>
      m.hare.initial([
        [A, 'mm', wf(1, 2, 3)],
        [B, 'mm', wf(4, 5, 6)],
        [R, 'mm', wf(0, 0, 0)],
      ])
    );
    m.flush();
    expect(m.tool.getState().reference).toEqual({ kind: 'pv', pv: R });
    act(() => m.tool.update((s) => ({ ...s, hidden: { ...s.hidden, [B]: true } })));
    m.flush();

    fireEvent.click(action('Snapshot → reference'));
    const ref = m.tool.getState().reference;
    expect(ref?.kind).toBe('snapshot');
    if (ref?.kind !== 'snapshot') throw new Error('no snapshot');
    expect(Object.keys(ref.frames)).toEqual([A]);
  });

  it('a curve added after the snapshot is not drawn in Δ and carries the chip', () => {
    const m = mount(`pv=${A}`);
    act(() => m.hare.initial([[A, 'mm', wf(1, 2, 3)]]));
    m.flush();
    fireEvent.click(action('Snapshot → reference'));
    act(() => m.tool.update((s) => setDelta(s, true)));

    act(() => m.tool.update((s) => addPv(s, 'live', B).state));
    act(() => m.hare.initial([[B, 'mm', wf(4, 5, 6)]]));
    m.flush();

    expect(m.tool.getState().pvs).toEqual([A, B]);
    expect(seriesIds()).toContain(liveId(A));
    expect(seriesIds()).not.toContain(liveId(B));
    const status = document.querySelector(`[data-row-id="live:${B}"] .wb-outline-row__status`);
    expect(status?.getAttribute('title')).toBe(NOT_IN_SNAPSHOT);
  });

  it('Export CSV hands the published frames to the download, Δ when Δ is drawn', () => {
    const m = mount(`pv=${A}`);
    act(() => m.hare.initial([[A, 'mm', wf(1, 2, 3)]]));
    m.flush();
    fireEvent.click(action('Export CSV'));
    expect(downloads.csv).toHaveLength(1);
    const data = downloads.csv[0] as {
      curves: { name: string; values: Float64Array }[];
      delta: boolean;
    };
    expect(data.delta).toBe(false);
    expect(data.curves.map((c) => [c.name, Array.from(c.values)])).toEqual([[A, [1, 2, 3]]]);

    fireEvent.click(action('Export PNG'));
    expect(downloads.png).toHaveLength(1);
  });
});

const { IS_MAC } = await import('../../workbench/useCanvasActions');

describe('WaveformApp drawings', () => {
  function ready(): Mounted {
    const m = mount(`pv=${A}`);
    act(() => m.hare.initial([[A, 'mm', wf(1, 2, 3)]]));
    m.flush();
    return m;
  }

  function addHline(): void {
    const stage = document.querySelector('.waveform-plot__stage')!;
    fireEvent.contextMenu(stage, { clientX: 300, clientY: 200 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add horizontal line here' }));
  }

  function undoKey(): void {
    fireEvent.keyDown(document.body, { key: 'z', metaKey: IS_MAC, ctrlKey: !IS_MAC });
  }

  it('a drawing added on the plot lands in state.drawings, stamped with the rendered x', () => {
    const m = ready();
    addHline();
    const drawings = m.tool.getState().drawings;
    expect(drawings).toHaveLength(1);
    expect(drawings[0]).toMatchObject({ kind: 'hline', axisId: 'y', xRef: 'index' });
    expect(drawings[0].delta).toBeUndefined();
    expect(document.querySelector(`[data-annotation-id="${drawings[0].id}"]`)).not.toBeNull();
  });

  it('undo removes the newest drawing and never a settings edit', () => {
    const m = ready();
    addHline();
    expect(m.tool.getState().drawings).toHaveLength(1);
    act(() => m.tool.update((s) => ({ ...s, persist: 4 })));
    act(() => undoKey());
    expect(m.tool.getState().drawings).toHaveLength(0);
    expect(m.tool.getState().persist).toBe(4);
    // Nothing left to undo: the settings edit stays.
    act(() => undoKey());
    expect(m.tool.getState().persist).toBe(4);
  });

  it('Hide all is the ui record: the rail toggle hides the drawings', () => {
    const m = ready();
    addHline();
    const id = m.tool.getState().drawings[0].id;
    expect(document.querySelector(`[data-annotation-id="${id}"]`)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Hide all drawings' }));
    expect(document.querySelector(`[data-annotation-id="${id}"]`)).toBeNull();
    // Hiding is not a state write: the drawing is still there.
    expect(m.tool.getState().drawings).toHaveLength(1);
  });
});
