// @vitest-environment jsdom
//
// The correlation tab as mounted on the workbench: the
// panel's Signals / X axis PV / Trigger groups, the actions bar (Pause as a
// pressed toggle, Clear, Export disabled until a frame exists, Post to e-log
// only under the `elog` capability, the standard actions), the view controls
// in the plot's Display section, the health line with its suffixes and Retry, and the
// plot with its readout — asserted on what is rendered, over a faked Hare
// service and a faked Formula Engine table service.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  AlarmSeverity,
  type FormulaSpec,
  type FormulaEngineError,
  type FormulaEngineSubscribeOptions,
  type HareConnectionStatus,
  type PVData,
  type TableResultDTO,
} from '@slaclab/canopy-client';
import resultTriggerRaw from './__fixtures__/table-result-trigger.json?raw';
import { TESTIDS } from '../../workbench/testids';
import { CORRELATION_TESTIDS } from './testids';
import { DOWN, FakeHare, SCALAR } from '../shared/fakeHare.test-util';
import type { FormulaEngineFactory, FormulaEngineTableService } from './useTable';

const { charts, elog, downloads, finished } = vi.hoisted(() => ({
  /** The option of every chart render, newest last. */
  charts: [] as { className?: string; option: Record<string, unknown> }[],
  /** The chart's newest `finished` handler. */
  finished: { current: undefined as undefined | (() => void) },
  elog: { enabled: false },
  downloads: { csv: [] as { cut: number | null }[], href: [] as string[] },
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
    downloadCsv: (_frame: unknown, cut: number | null) => void downloads.csv.push({ cut }),
  };
});
vi.mock('../shared/chartImage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/chartImage')>();
  return {
    ...actual,
    downloadHref: (href: string) => void downloads.href.push(href),
  };
});

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  // The instance APIs the drawing host uses: one grid at (80, 36)
  // 500 x 300, x = 0..10 across it and y = 0..30 up it on every axis index.
  const GRID = { x: 80, y: 36, width: 500, height: 300 };
  type Finder = { xAxisIndex?: number; yAxisIndex?: number };
  const instance = () => ({
    getDataURL: () => 'data:image/png;base64,AAAA',
    getWidth: () => 640,
    getHeight: () => 400,
    isDisposed: () => false,
    dispatchAction: () => {},
    on: () => {},
    off: () => {},
    convertToPixel: (f: Finder, v: number) =>
      f.xAxisIndex !== undefined
        ? GRID.x + (v / 10) * GRID.width
        : GRID.y + GRID.height - (v / 30) * GRID.height,
    convertFromPixel: (f: Finder, px: number) =>
      f.xAxisIndex !== undefined
        ? ((px - GRID.x) / GRID.width) * 10
        : ((GRID.y + GRID.height - px) / GRID.height) * 30,
    getModel: () => ({
      getComponent: (type: string) =>
        type === 'grid'
          ? { coordinateSystem: { getRect: () => ({ ...GRID }) } }
          : { axis: { scale: { getExtent: () => (type === 'xAxis' ? [0, 10] : [0, 30]) } } },
    }),
  });
  class MockECharts extends React.Component<{
    className?: string;
    option: Record<string, unknown>;
    onEvents?: { finished?: () => void };
  }> {
    instance = instance();
    getEchartsInstance() {
      return this.instance;
    }
    render() {
      charts.push({ className: this.props.className, option: this.props.option });
      if (this.props.className === 'correlation-plot__chart' && this.props.onEvents?.finished)
        finished.current = this.props.onEvents.finished;
      return React.createElement('div', { className: this.props.className });
    }
  }
  return { default: MockECharts };
});

const { CorrelationApp, NO_FRAME_REASON } = await import('./App');

const X = 'SIM:HCM01:SP';
const Y1 = 'SIM:BPM01:X';
const Y2 = 'SIM:BPM02:X';
const T = 'SIM:TRIGGER:COUNT';
const TIMER = `x=${X}&y=${Y1}&y=${Y2}`;
const TRIGGERED = `${TIMER}&trig=${T}`;
/** The presets after the default columns, off, as an `m=` list writes them. */
const OFF_PRESETS = ['r2', 'intercept', 'min', 'max', 'p2p', 'rms', 'xmean', 'xstd']
  .map((id) => `m=-${id}`)
  .join('&');

/** The fake Hare service, with the socket status the health line reads. */
class Hare extends FakeHare {
  status: HareConnectionStatus = 'connected';
  private readonly severities = new Map<string, AlarmSeverity>();

  setSeverity(pv: string, severity: AlarmSeverity): void {
    this.severities.set(pv, severity);
  }

  override getSnapshot(pv: string): PVData | undefined {
    const snap = super.getSnapshot(pv);
    const severity = this.severities.get(pv);
    return snap === undefined || severity === undefined ? snap : { ...snap, severity };
  }
}

interface Sub {
  spec: FormulaSpec;
  opts: FormulaEngineSubscribeOptions;
  open: boolean;
}

/** A Formula Engine table service that records its subscriptions and is fed by hand. */
class FakeFormulaEngine implements FormulaEngineTableService {
  status = 'connected' as const;
  readonly subs: Sub[] = [];

  connect(): void {}
  dispose(): void {}

  subscribe(spec: FormulaSpec, opts: FormulaEngineSubscribeOptions): () => void {
    const sub: Sub = { spec, opts, open: true };
    this.subs.push(sub);
    return () => {
      sub.open = false;
    };
  }

  get newest(): Sub {
    return this.subs[this.subs.length - 1];
  }

  result(table: TableResultDTO): void {
    this.newest.opts.onResult?.({ kind: 'table', table } as never);
  }

  error(error: Partial<FormulaEngineError> & { message: string; retryable: boolean }): void {
    this.newest.opts.onError?.({ code: 'table_limit', ...error } as FormulaEngineError);
  }
}

let hare: Hare;
let engine: FakeFormulaEngine;
const createFormulaEngine: FormulaEngineFactory = () => engine;
const search = async () => [] as string[];

const S = 1_000_000_000;
const BASE = 1_790_000_000_000_000_000;

type Inputs = TableResultDTO['inputs'];

/** A two-Y frame of `rows` rows; every input reads `history` unless overridden. */
function table(
  rows: number,
  history: Inputs[string]['history'],
  over: { inputs?: Partial<Inputs>; totalRows?: number; trig?: boolean } = {}
): TableResultDTO {
  const tsNs = Array.from({ length: rows }, (_, i) => BASE + i * S);
  const input = { history, status: 'ok', lateAfterFinal: false } as Inputs[string];
  const inputs: Inputs = { x: { ...input }, y1: { ...input }, y2: { ...input } };
  if (over.trig) inputs.trig = { ...input };
  return {
    tsNs,
    columns: {
      x: tsNs.map((_, i) => i),
      y1: tsNs.map((_, i) => 2 * i + 1),
      y2: tsNs.map((_, i) => -i),
    },
    inputs: { ...inputs, ...over.inputs } as Inputs,
    totalRows: over.totalRows ?? rows,
  };
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Mount standalone with `query`, every PV connected, the first spec applied. */
async function mount(query: string, pvs: string[] = [X, Y1, Y2]): Promise<void> {
  window.history.replaceState(null, '', `/correlation.html${query === '' ? '' : `?${query}`}`);
  render(<CorrelationApp hare={hare} createFormulaEngine={createFormulaEngine} search={search} />);
  if (pvs.length > 0) {
    act(() => hare.initial(pvs.map((pv) => [pv, 'mm', SCALAR])));
  }
  await flush();
  advance(300);
}

/** Let the PV tracker's batched model update land. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function healthText(): string {
  return screen.getByTestId('health-text').textContent ?? '';
}

function suffixes(): string[] {
  return screen.queryAllByTestId('health-suffix').map((el) => el.textContent ?? '');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  hare = new Hare();
  engine = new FakeFormulaEngine();
  // The sidebar's arrangement persists; every test opens on the defaults.
  window.localStorage.clear();
  charts.length = 0;
  elog.enabled = false;
  downloads.csv.length = 0;
  downloads.href.length = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

// Carbon's multiselect (the e-log dialog) measures with ResizeObserver.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// ------------------------------------------------------------- workbench --

function section(id: 'x' | 'y' | 'trig'): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-section-id="${id}"]`);
  if (!el) throw new Error(`no section ${id}`);
  return el;
}

/** The PVs of a section's rows, in Outline order. */
function rowPvs(id: 'x' | 'y' | 'trig'): string[] {
  return Array.from(
    section(id).querySelectorAll<HTMLElement>('[data-row-id]'),
    (el) => el.dataset.rowId?.slice(id.length + 1) ?? ''
  );
}

function actionsBar(): HTMLElement {
  return screen.getByTestId(TESTIDS.actionsBar);
}

/** The action button whose accessible name starts with `label`. */
function action(label: string): HTMLElement {
  return within(actionsBar()).getByRole('button', {
    name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  });
}

/** The newest main chart option (not a strip chart). */
function lastOption(): Record<string, unknown> {
  const main = charts.filter((c) => c.className === 'correlation-plot__chart');
  return main[main.length - 1].option;
}

describe('correlation app on the workbench', () => {
  it('a blank instance shows the X, Y and Trigger sections and asks for an X and a Y', async () => {
    await mount('', []);

    for (const id of ['x', 'y', 'trig'] as const) expect(section(id)).toBeTruthy();
    expect(within(section('x')).getByTestId(TESTIDS.outlineAddInput)).toBeTruthy();
    expect(within(section('y')).getByTestId(TESTIDS.outlineAddInput)).toBeTruthy();
    // Timer mode: the Trigger's Source sits in its header; no add row yet.
    expect((screen.getByTestId(CORRELATION_TESTIDS.triggerSource) as HTMLSelectElement).value).toBe(
      'timer'
    );
    expect(within(section('trig')).queryByTestId(TESTIDS.outlineAddInput)).toBeNull();

    expect(healthText()).toBe('add an X and at least one Y');
    expect(suffixes()).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(engine.subs).toHaveLength(0);
  });

  it('has no fixed side panel and no plot toolbar', async () => {
    await mount(TIMER);

    expect(document.querySelector('.correlation-app__side')).toBeNull();
    expect(document.querySelector('.correlation-plot__toolbar')).toBeNull();
    expect(screen.queryByRole('toolbar', { name: 'Plot actions' })).toBeNull();
    // The canvas sits in the workbench's canvas slot.
    const slot = document.querySelector('.wb-workbench__canvas');
    expect(slot?.contains(screen.getByTestId('correlation-health'))).toBe(true);
    expect(slot?.contains(screen.getByRole('region', { name: 'Correlation plot' }))).toBe(true);
  });

  it('lists the roles of the opening query in the Outline and the strips on the canvas', async () => {
    // The default list with r drawn as a strip (strips are off by default).
    await mount(`${TRIGGERED}&readout=1&m=n&m=mean&m=std&m=~r&m=slope&${OFF_PRESETS}`, [
      X,
      Y1,
      Y2,
      T,
    ]);

    expect(rowPvs('x')).toEqual([X]);
    expect(rowPvs('y')).toEqual([Y1, Y2]);
    expect(rowPvs('trig')).toEqual([T]);
    expect((screen.getByTestId(CORRELATION_TESTIDS.triggerSource) as HTMLSelectElement).value).toBe(
      'pv'
    );
    expect(screen.getByRole('region', { name: 'Strip charts' })).toBeTruthy();
  });

  it('registers Pause, Clear, Export and the standard actions; no e-log without a logbook', async () => {
    await mount(TIMER);

    const names = actionsBar().textContent ?? '';
    for (const name of ['Pause', 'Clear', 'Export CSV', 'Export PNG']) {
      expect(names).toContain(name);
    }
    expect(names).toMatch(/Switch to (dark|light) mode/);
    expect(names).toContain('Report a bug');
    expect(names).toContain('Docs');
    // No logbook: hidden, not disabled.
    expect(names).not.toMatch(/E-Log/);
    // The view controls are not actions.
    expect(names).not.toMatch(/Density|Scatter|Shared Y/);
  });

  it('keeps the actions bar embedded=true alone, and drops it under the host bar', async () => {
    await mount(`${TIMER}&embedded=true`);
    expect(actionsBar().textContent).toContain('Pause');
    cleanup();
    await mount(`${TIMER}&embedded=true&hostbar=1`);
    expect(screen.queryByTestId(TESTIDS.actionsBar)).toBeNull();
  });

  it('keeps Export visible but disabled, with its reason, until a frame exists', async () => {
    await mount(TIMER);
    expect(action('Export CSV').getAttribute('aria-disabled')).toBe('true');
    expect(action('Export PNG').getAttribute('aria-disabled')).toBe('true');
    expect(actionsBar().textContent).toContain(NO_FRAME_REASON);

    act(() => engine.result(table(3, 'seeded')));
    expect(action('Export CSV').getAttribute('aria-disabled')).toBeNull();
    expect(action('Export PNG').getAttribute('aria-disabled')).toBeNull();

    fireEvent.click(action('Export CSV'));
    expect(downloads.csv).toEqual([{ cut: null }]);
    fireEvent.click(action('Export PNG'));
    expect(downloads.href).toEqual(['data:image/png;base64,AAAA']);
  });

  it('Pause is a pressed toggle', async () => {
    await mount(TIMER);
    act(() => engine.result(table(3, 'seeded')));
    expect(action('Pause').getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(action('Pause'));
    expect(action('Pause').getAttribute('aria-pressed')).toBe('true');
    expect(healthText()).toBe('paused');

    fireEvent.click(action('Pause'));
    expect(action('Pause').getAttribute('aria-pressed')).toBe('false');
    expect(healthText()).toBe('ok');
  });

  it('Clear cuts at the newest row on screen; the CSV carries the cut', async () => {
    await mount(TIMER);
    act(() => engine.result(table(3, 'seeded')));

    fireEvent.click(action('Clear'));
    fireEvent.click(action('Export CSV'));

    expect(downloads.csv).toEqual([{ cut: BASE + 2 * S }]);
  });

  it('shows Post to e-log once the logbook listing loaded', async () => {
    elog.enabled = true;
    await mount(TIMER);
    act(() => engine.result(table(3, 'seeded')));

    fireEvent.click(action('Post to E-Log'));
    expect(screen.getByAltText('Preview of Correlation')).toBeTruthy();
  });

  it('a Display › Plot as change reaches the chart through the state', async () => {
    await mount(TIMER);
    act(() => engine.result(table(3, 'seeded')));
    expect(document.querySelector('#density-y')).toBeNull();

    // The plot-wide sections start closed; the header opens Display.
    const display = document.querySelector<HTMLElement>('.wb-plot-section[data-section="display"]');
    fireEvent.click(display!.querySelector('.wb-plot-section__head')!);
    const view = screen.getByRole('radiogroup', { name: 'Plot as' });
    fireEvent.click(within(view).getByRole('radio', { name: 'Density' }));

    const densityY = document.querySelector<HTMLSelectElement>('#density-y');
    expect(densityY).not.toBeNull();
    fireEvent.change(densityY!, { target: { value: Y2 } });

    const series = lastOption().series as { type: string; name?: string }[];
    expect(series.some((s) => s.type === 'custom')).toBe(true);
    expect(series.filter((s) => s.type === 'custom').map((s) => s.name)).toEqual([Y2]);
  });

  it('draws what the state pins: a hidden Y is unselected in the legend', async () => {
    await mount(`${TIMER}&hide=2`);
    act(() => engine.result(table(3, 'seeded')));

    const legend = lastOption().legend as { selected?: Record<string, boolean> };
    expect(legend.selected?.[Y2]).toBe(false);
  });

  it('shows "connecting…" until the first result, then "ok" with the readout', async () => {
    await mount(`${TIMER}&readout=1`);
    expect(engine.subs).toHaveLength(1);
    expect(healthText()).toBe('connecting…');

    act(() => engine.result(table(4, 'seeded')));

    expect(healthText()).toBe('ok');
    expect(suffixes()).toEqual([]);
    const readout = screen.getByRole('region', { name: 'Readout' });
    expect(within(readout).getByTestId('readout-y1').textContent).toContain(Y1);
    expect(within(readout).getByTestId('readout-y2').textContent).toContain(Y2);
    // Rows are Ys only; X statistics are metrics. No strips by default.
    expect(within(readout).queryByTestId('readout-x')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Strip charts' })).toBeNull();
  });

  it('ends the health line with the row rate once the frame reaches 10 s back', async () => {
    await mount(TIMER);
    act(() => engine.result(table(12, 'seeded')));
    expect(suffixes()).toEqual(['1.000 rows/s']);
  });

  it('shows "not archived: <PV>" for every PV of a frame without an archive', async () => {
    await mount(TIMER);
    act(() => engine.result(table(3, 'not-archived')));

    expect(healthText()).toBe('ok');
    expect(suffixes()).toEqual([
      `not archived: ${X}`,
      `not archived: ${Y1}`,
      `not archived: ${Y2}`,
    ]);
    expect(screen.getByTestId('correlation-health').textContent).toBe(
      `ok · not archived: ${X} · not archived: ${Y1} · not archived: ${Y2}`
    );
  });

  it('shows each suffix of the contract fixture, and drops it with its field', async () => {
    await mount(TRIGGERED, [X, Y1, Y2, T]);
    const fixture = (JSON.parse(resultTriggerRaw) as { data: { table: TableResultDTO } }).data
      .table;
    act(() => engine.result(fixture));

    expect(healthText()).toBe(`no data: ${T}`);
    expect(suffixes()).toEqual([
      `no archive history for ${T}`,
      `not archived: ${Y1}`,
      `history truncated for ${Y2}`,
      `late data for ${Y1}`,
    ]);

    act(() => engine.result(table(3, 'seeded', { trig: true, totalRows: 10 })));
    expect(suffixes()).toEqual(['3 of 10 rows shown']);

    act(() => engine.result(table(3, 'seeded', { trig: true })));
    expect(suffixes()).toEqual([]);
  });

  it('shows "PV status unavailable" while the Hare socket is down', async () => {
    await mount(TIMER);
    act(() => engine.result(table(3, 'seeded')));
    expect(suffixes()).toEqual([]);

    hare.status = 'disconnected';
    advance(1000);
    expect(suffixes()).toEqual(['PV status unavailable']);

    hare.status = 'connected';
    advance(1000);
    expect(suffixes()).toEqual([]);
  });

  it('names a disconnected and an INVALID PV', async () => {
    await mount(TIMER);
    act(() => engine.result(table(3, 'seeded')));

    hare.setSeverity(Y2, AlarmSeverity.INVALID);
    advance(1000);
    expect(healthText()).toBe(`INVALID: ${Y2}`);

    act(() => hare.diff([[Y1, DOWN]]));
    await flush();
    advance(1000);
    expect(healthText()).toBe(`disconnected: ${Y1}`);
  });

  it('shows "stale" when a Timer table stops delivering frames', async () => {
    await mount(TIMER);
    act(() => engine.result(table(3, 'seeded')));
    expect(healthText()).toBe('ok');

    advance(6000);
    expect(healthText()).toBe('stale');
  });

  it('shows "trigger silent" when a triggered table stops delivering rows', async () => {
    await mount(TRIGGERED, [X, Y1, Y2, T]);
    act(() => engine.result(table(3, 'seeded', { trig: true })));
    expect(healthText()).toBe('ok');

    advance(11_000);
    expect(healthText()).toBe('trigger silent');
  });

  it('shows "waiting for data: …" on a retryable error and keeps the subscription', async () => {
    await mount(TIMER);
    act(() => engine.error({ code: 'seed_wait', message: 'seeding history', retryable: true }));

    expect(healthText()).toBe('waiting for data: seeding history');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(engine.subs).toHaveLength(1);
    expect(engine.newest.open).toBe(true);
  });

  it('shows "error: …" with Retry after a non-retryable error; Retry subscribes again', async () => {
    await mount(TIMER);
    act(() => engine.error({ message: 'table too large', retryable: false }));

    expect(healthText()).toBe('error: table too large');
    expect(engine.subs).toHaveLength(1);
    expect(engine.newest.open).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(engine.subs).toHaveLength(2);
    expect(healthText()).toBe('connecting…');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('shows "paused" while paused and keeps the suffixes of the latest frame', async () => {
    await mount(TIMER);
    act(() => engine.result(table(3, 'not-archived')));

    fireEvent.click(action('Pause'));
    expect(healthText()).toBe('paused');
    expect(suffixes()).toHaveLength(3);

    fireEvent.click(action('Pause'));
    expect(healthText()).toBe('ok');
  });

  it('removing the last Y from the Outline leaves no subscription', async () => {
    await mount(`x=${X}&y=${Y1}`, [X, Y1]);
    act(() => engine.result({ ...table(3, 'seeded'), columns: { x: [0, 1, 2], y: [1, 3, 5] } }));
    expect(healthText()).toBe('ok');

    fireEvent.click(screen.getByRole('button', { name: `Remove ${Y1}` }));
    await flush();
    advance(300);

    expect(healthText()).toBe('add an X and at least one Y');
    expect(engine.newest.open).toBe(false);
  });
});

describe('CorrelationApp drawings', () => {
  const box = () => document.querySelector('.correlation-plot__box') as HTMLDivElement;
  const key = (target: EventTarget, init: KeyboardEventInit) => {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(ev);
    });
    return ev;
  };
  const click = (x: number, y: number) => {
    const svg = box().querySelector('svg[data-annotation-layer]') as SVGSVGElement;
    for (const type of ['pointerdown', 'pointerup']) {
      act(() => {
        svg.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: type === 'pointerdown' ? 1 : 0,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
          })
        );
      });
    }
  };
  const drawn = () => box().querySelectorAll('[data-annotation-id]').length;

  it('a drawing placed on the plot is one undo step of the app', async () => {
    await mount(TIMER);
    act(() => engine.result(table(10, 'seeded')));
    act(() => finished.current?.());
    // The rail sits outside the scroller.
    const rail = document.querySelector('[data-drawing-rail]');
    expect(rail).not.toBeNull();
    expect(document.querySelector('.correlation-plot__stage')?.contains(rail)).toBe(false);

    key(box(), { key: '√', code: 'KeyV', altKey: true });
    click(330, 186);
    expect(drawn()).toBe(1);
    // Primary+Z (Ctrl off macOS) is the one document-level undo.
    key(document.body, { key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: true });
    expect(drawn()).toBe(0);
  });
});
