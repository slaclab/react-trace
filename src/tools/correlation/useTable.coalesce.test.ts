// Client-side back-pressure: every result frame is a whole table, so frames
// that arrive faster than the page draws are coalesced. The first frame of a
// window is handed over at once, later ones only replace the pending frame,
// and the newest is handed over when the window closes (the next animation
// frame; under pressure at LARGE_FRAME_ROWS rows or more, the window after a
// coalesced hand-over stays open LARGE_FRAME_INTERVAL_MS). Health still sees
// every arrival.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FormulaEngineSubscribeOptions,
  FormulaSpec,
  TableResultDTO,
} from '@slaclab/canopy-client';
import { parseCorrelationQuery } from './query';
import { buildTableSpec } from './spec';
import type { PvModel } from '../shared/pvTracker';
import {
  LARGE_FRAME_INTERVAL_MS,
  LARGE_FRAME_ROWS,
  TableController,
  type FrameScheduler,
} from './useTable';

const OK = { history: 'seeded', status: 'ok', lateAfterFinal: false } as const;

let ts = 0;
function table(rowCount = 1): TableResultDTO {
  const tsNs = Array.from({ length: rowCount }, () => 1e18 + ++ts * 1e8);
  return {
    tsNs,
    columns: { x: tsNs.map(() => 1), y: tsNs.map(() => 2) },
    inputs: { x: { ...OK }, y: { ...OK }, trig: { ...OK } },
    totalRows: rowCount,
  };
}

/** A scheduler the test drives: `run()` closes the open window. */
function manualScheduler() {
  const pending: { flush: () => void; delayMs: number; cancelled: boolean }[] = [];
  const schedule: FrameScheduler = (flush, delayMs) => {
    const entry = { flush, delayMs, cancelled: false };
    pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return {
    schedule,
    pending,
    run(): void {
      const due = pending.splice(0);
      for (const e of due) if (!e.cancelled) e.flush();
    },
  };
}

function live(scheduler: FrameScheduler) {
  const calls: FormulaEngineSubscribeOptions[] = [];
  const service = {
    status: 'connected' as const,
    connect: () => {},
    dispose: () => {},
    subscribe: (_spec: FormulaSpec, opts: FormulaEngineSubscribeOptions) => {
      calls.push(opts);
      return () => {};
    },
  };
  const c = new TableController(scheduler);
  c.attach(service);
  c.setWanted(true);
  const state = parseCorrelationQuery('x=TEST:SINE&y=DEMO:Y&trig=DEMO:TRIG');
  const model: PvModel = {
    x: { pv: 'TEST:SINE', status: 'ok', units: '' },
    ys: [{ pv: 'DEMO:Y', status: 'ok', units: '' }],
    trig: { pv: 'DEMO:TRIG', status: 'ok', units: '' },
    axisUnit: null,
    decided: true,
  };
  c.setSpec(buildTableSpec(state, model));
  vi.advanceTimersByTime(300);
  expect(calls).toHaveLength(1);
  const push = (t: TableResultDTO) =>
    calls[0].onResult({ kind: 'table', scalar: null, timeseries: null, waveform: null, table: t });
  return { c, push };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('frame coalescing', () => {
  it('a burst of frames hands over the first at once and the newest when the window closes', () => {
    const s = manualScheduler();
    const { c, push } = live(s.schedule);
    const frames: (TableResultDTO | undefined)[] = [];
    c.subscribe(() => frames.push(c.getSnapshot().frame?.table));

    const first = table();
    push(first);
    expect(c.getSnapshot().frame?.table).toBe(first);

    const burst = Array.from({ length: 5 }, () => table());
    for (const t of burst) push(t);
    // Still the first frame: the rest wait for the window to close.
    expect(c.getSnapshot().frame?.table).toBe(first);
    // Health saw every arrival.
    expect(c.getSnapshot().health.latest).toBe(burst[4]);
    expect(c.getSnapshot().health.arrivals).toHaveLength(6);

    s.run();
    expect(c.getSnapshot().frame?.table).toBe(burst[4]);
    // Only two frames ever reached the plot.
    expect(new Set(frames.filter((t) => t !== undefined))).toEqual(new Set([first, burst[4]]));

    // A quiet window closes without handing anything over.
    const handed = frames.length;
    s.run();
    expect(frames.length).toBe(handed);
    c.dispose();
  });

  it('under pressure, frames at the row cap are handed over at most every LARGE_FRAME_INTERVAL_MS', () => {
    const s = manualScheduler();
    const { c, push } = live(s.schedule);
    // One frame at a time (a quiet window between): each is handed over at once.
    push(table(10));
    expect(s.pending.at(-1)?.delayMs).toBe(0);
    s.run();
    const big = table(LARGE_FRAME_ROWS);
    push(big);
    expect(c.getSnapshot().frame?.table).toBe(big);
    expect(s.pending.at(-1)?.delayMs).toBe(0);
    // A frame while that one is drawn: coalesced, handed over when the window
    // closes, and the next window stays open longer.
    const newer = table(LARGE_FRAME_ROWS);
    push(newer);
    s.run();
    expect(c.getSnapshot().frame?.table).toBe(newer);
    expect(s.pending.at(-1)?.delayMs).toBe(LARGE_FRAME_INTERVAL_MS);
    // Small coalesced frames keep the animation-frame window.
    push(table(10));
    s.run();
    s.run();
    push(table(10));
    push(table(10));
    s.run();
    expect(s.pending.at(-1)?.delayMs).toBe(0);
    c.dispose();
  });

  it('the default scheduler hands the newest frame over within an animation frame', () => {
    const { c, push } = live(undefined as unknown as FrameScheduler);
    const first = table();
    push(first);
    const last = table();
    push(table());
    push(last);
    expect(c.getSnapshot().frame?.table).toBe(first);
    vi.advanceTimersByTime(50);
    expect(c.getSnapshot().frame?.table).toBe(last);
    c.dispose();
  });

  it('dispose cancels a pending hand-over', () => {
    const s = manualScheduler();
    const { c, push } = live(s.schedule);
    push(table());
    push(table());
    c.dispose();
    expect(s.pending.every((e) => e.cancelled)).toBe(true);
  });
});
