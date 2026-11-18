// @vitest-environment jsdom
//
// Live resumes end to end: the real LiveStore over the SDK's fake socket, its
// entry handed to the option builder. After a kept break (an outage no Vole
// backfill covers) the line resumes where the PV reported connected again,
// instead of staying blank until its next change. The resume is a drawn point
// only, never a sample: the read-out, the statistics, the data-point count and
// CSV export never see it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeWebSocketFactory } from '@slaclab/canopy-client/testing';
import type { PVValueDTO } from '@slaclab/canopy-client';
import { drawingThemeFor } from '../annotationTheme';
import { LiveStore, type LiveEntry } from '../state/liveStore';
import type { VoleSeriesDTO } from '../api/types';
import { msToNs } from '../api/time';
import { buildCsvFiles } from '../io/exportCsv';
import { traceStatFrame } from '../tools/trace/metrics';
import { dataPointCount } from '../tools/trace/curveStatus';
import type { Plot, PVTrace } from '../types';
import { buildPlotOption } from './plotOption';
import { traceLineData } from './traceGaps';

vi.mock('../api/vole', () => ({
  fetchBackfill: vi.fn(),
  subscribeVoleBuffer: vi.fn(),
}));

import { fetchBackfill, subscribeVoleBuffer } from '../api/vole';
const mockFetchBackfill = vi.mocked(fetchBackfill);

const S = 1_000;
const MIN = 60 * S;
const PV = 'SLOW';

let fake: ReturnType<typeof createFakeWebSocketFactory>;

beforeEach(() => {
  fake = createFakeWebSocketFactory();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-05T12:00:00Z'));
  // A backfill that covers nothing, so every break is kept.
  mockFetchBackfill.mockResolvedValue({ pv: PV, count: 0, samples: [] });
  vi.mocked(subscribeVoleBuffer).mockResolvedValue({ subscribed: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

function value(v: number | null, tsMs: number, connected = true): PVValueDTO {
  return {
    pv: PV,
    value: v,
    valueKind: 'scalar',
    severity: 'NO_ALARM',
    tsNs: tsMs * 1e6,
    connected,
    error: null,
  };
}

const initial = (dto: PVValueDTO) => ({ type: 'initial', data: { [PV]: dto }, meta: {}, count: 1 });
const diff = (dto: PVValueDTO) => ({
  type: 'diff',
  data: { [PV]: dto },
  count: 1,
  timestamp: Date.now(),
});

function liveTrace(lineType: 'step' | 'direct' = 'step'): PVTrace {
  return {
    id: 't1',
    pvName: PV,
    displayName: '',
    color: '#0f62fe',
    visible: true,
    axisId: 'a1',
    useLive: true,
    useArchive: false,
    lineWidth: 2,
    lineType,
    lineStyle: 'solid',
    showSymbol: true,
    symbolShape: 'circle',
    symbolSize: 6,
    data: [],
  };
}

function plotOf(trace: PVTrace): Plot {
  return {
    id: 'p1',
    title: 'Plot',
    xAxis: { timeRange: '-1h' },
    axes: [
      { id: 'a1', name: 'Y', orientation: 'left', autoScale: true, logScale: false, visible: true },
    ],
    traces: [trace],
  } as unknown as Plot;
}

// A slow PV that last changed 10 minutes ago, watched by a real store.
async function watched() {
  const store = new LiveStore({
    connection: { baseUrl: 'http://canopy.test' },
    webSocketFactory: fake.factory,
  });
  store.watch('t1', PV, 30 * MIN);
  const ws = fake.instances[0];
  ws.open();
  const t0 = Date.now() - 10 * MIN;
  ws.message(initial(value(7, t0)));
  await vi.advanceTimersByTimeAsync(0);
  return { store, ws, t0 };
}

// The socket drops 5 s on; the next one opens after the 1 s backoff. Returns
// the drop and reconnect times and the new socket.
function dropAndReopen(ws: { close(code?: number): void }) {
  vi.setSystemTime(Date.now() + 5 * S);
  const tDrop = Date.now();
  ws.close(1006);
  vi.advanceTimersByTime(1_000);
  const tBack = Date.now();
  const ws2 = fake.instances.at(-1)!;
  ws2.open();
  return { tDrop, tBack, ws2 };
}

const entryOf = (store: LiveStore): LiveEntry => store.getSnapshot().get('t1')!;

type Series = { id: string; data: unknown };
type Hold = { value: [number, number]; symbol: 'none' };
type Drawn = [number, number | null] | Hold;

function optionFor(trace: PVTrace, live: LiveEntry, endMs = Date.now()) {
  return buildPlotOption({
    plot: plotOf(trace),
    archiveResults: new Map(),
    liveResults: new Map([['t1', live]]),
    formulaResults: new Map(),
    theme: drawingThemeFor('dark'),
    endMs,
  });
}

function seriesOf(option: ReturnType<typeof optionFor>, id: string): Series | undefined {
  return (option.series as unknown as Series[]).find((s) => s.id === id);
}

// The curve's series data as points (the flat typed array, when unbroken, too).
function mainData(option: ReturnType<typeof optionFor>): Drawn[] {
  const data = seriesOf(option, 't1')!.data;
  if (!(data instanceof Float64Array)) return data as Drawn[];
  const out: Drawn[] = [];
  for (let i = 0; i + 1 < data.length; i += 2) out.push([data[i], data[i + 1]]);
  return out;
}

const timeOf = (p: Drawn) => (Array.isArray(p) ? p[0] : p.value[0]);
const hold = (t: number, v: number): Hold => ({ value: [t, v], symbol: 'none' });

// Where the dashed extension starts, and its value; undefined when none.
function extensionStart(option: ReturnType<typeof optionFor>): [number, number] | undefined {
  const data = seriesOf(option, 't1-extension')?.data as Float64Array | undefined;
  return data ? [data[0], data[1]] : undefined;
}

describe('live resumes', () => {
  it('an uncovered socket blip: held to the disconnect, a gap, then resumed at reconnect', async () => {
    const { store, ws, t0 } = await watched();
    const { tDrop, tBack, ws2 } = dropAndReopen(ws);
    // Hare replays the unchanged value with its old stamp; the backfill covers nothing.
    ws2.message(initial(value(7, t0)));
    await vi.advanceTimersByTimeAsync(0);

    const live = entryOf(store);
    expect(live.points).toEqual([{ time: t0, value: 7, severity: 'NO_ALARM' }]);
    expect(live.breaks).toEqual([tDrop]);
    expect(live.resumes).toEqual([{ after: tDrop, time: tBack, value: 7 }]);

    vi.setSystemTime(tBack + 30 * S);
    const option = optionFor(liveTrace(), live);
    expect(mainData(option)).toEqual([[t0, 7], hold(tDrop, 7), [tDrop, null], hold(tBack, 7)]);
    // The extension goes on from the resume, not from the old sample.
    expect(extensionStart(option)).toEqual([tBack, 7]);
  });

  it('a direct line resumes from the same point', async () => {
    const { store, ws, t0 } = await watched();
    const { tDrop, tBack, ws2 } = dropAndReopen(ws);
    ws2.message(initial(value(7, t0)));
    await vi.advanceTimersByTimeAsync(0);

    const option = optionFor(liveTrace('direct'), entryOf(store), tBack + 30 * S);
    expect(mainData(option)).toEqual([[t0, 7], [tDrop, null], hold(tBack, 7)]);
    expect(extensionStart(option)).toEqual([tBack, 7]);
  });

  it('a window cut after the break still draws the resume as a hold, not a sample', async () => {
    const { store, ws, t0 } = await watched();
    const { tBack, ws2 } = dropAndReopen(ws);
    ws2.message(initial(value(7, t0)));
    await vi.advanceTimersByTimeAsync(0);

    // The cut keeps one neighbour before the window: the resume alone. With no
    // null in it, it must still not take the typed-array path (which would
    // draw a sample's symbol there).
    const option = buildPlotOption({
      plot: plotOf(liveTrace()),
      archiveResults: new Map(),
      liveResults: new Map([['t1', entryOf(store)]]),
      formulaResults: new Map(),
      theme: drawingThemeFor('dark'),
      viewWindow: { fromNs: msToNs(tBack + 5 * S), toNs: msToNs(tBack + 30 * S) },
    });
    expect(seriesOf(option, 't1')!.data).toEqual([hold(tBack, 7)]);
    expect(extensionStart(option)).toEqual([tBack + 5 * S, 7]);
  });

  it('an IOC bounce with an unchanged value resumes when the PV comes back', async () => {
    const { store, ws, t0 } = await watched();
    vi.setSystemTime(Date.now() + 5 * S);
    const tDown = Date.now();
    ws.message(diff(value(null, t0, false)));
    vi.setSystemTime(Date.now() + 20 * S);
    const tUp = Date.now();
    ws.message(diff(value(7, t0)));

    const live = entryOf(store);
    expect(live.points.map((p) => p.time)).toEqual([t0]);
    expect(live.breaks).toEqual([tDown]);
    expect(live.resumes).toEqual([{ after: tDown, time: tUp, value: 7 }]);
    const option = optionFor(liveTrace(), live, tUp + 30 * S);
    expect(mainData(option)).toEqual([[t0, 7], hold(tDown, 7), [tDown, null], hold(tUp, 7)]);
    expect(extensionStart(option)).toEqual([tUp, 7]);
  });

  it('a value that changed before the drop resumes with the new value', async () => {
    const { store, ws, t0 } = await watched();
    const { tDrop, tBack, ws2 } = dropAndReopen(ws);
    // Changed 2 s before the drop; the update never arrived.
    ws2.message(initial(value(8, tDrop - 2 * S)));
    await vi.advanceTimersByTimeAsync(0);

    const live = entryOf(store);
    expect(live.resumes).toEqual([{ after: tDrop, time: tBack, value: 8 }]);
    expect(mainData(optionFor(liveTrace(), live))).toEqual([
      [t0, 7],
      [tDrop - 2 * S, 8],
      hold(tDrop, 8),
      [tDrop, null],
      hold(tBack, 8),
    ]);
  });

  it('a value that changed during the outage takes over from the resume', async () => {
    const { store, ws, t0 } = await watched();
    const { tDrop, ws2 } = dropAndReopen(ws);
    ws2.message(initial(value(8, tDrop + 500)));
    await vi.advanceTimersByTimeAsync(0);

    // The real sample after the break resumes the line itself.
    const option = optionFor(liveTrace(), entryOf(store));
    expect(mainData(option)).toEqual([[t0, 7], hold(tDrop, 7), [tDrop, null], [tDrop + 500, 8]]);
    expect(extensionStart(option)).toEqual([tDrop + 500, 8]);
  });

  it('a covering backfill removes the break and its resume', async () => {
    const { store, ws, t0 } = await watched();
    let resolve!: (v: VoleSeriesDTO) => void;
    mockFetchBackfill.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { tDrop, ws2 } = dropAndReopen(ws);
    ws2.message(initial(value(7, t0)));
    expect(entryOf(store).resumes).toHaveLength(1);
    // Vole's buffer reaches back to `from` (the newest point).
    resolve({
      pv: PV,
      count: 1,
      samples: [{ tsNs: msToNs(t0), value: 7, severity: 'NO_ALARM', source: 'live' }],
    });
    await vi.advanceTimersByTimeAsync(0);

    const live = entryOf(store);
    expect(live.breaks).toEqual([]);
    expect(live.resumes).toEqual([]);
    const option = optionFor(liveTrace(), live);
    expect(mainData(option)).toEqual([[t0, 7]]);
    expect(extensionStart(option)).toEqual([t0, 7]);
    expect(tDrop).toBeGreaterThan(t0);
  });

  it('never reaches the read-out, the statistics, the data-point count or CSV export', async () => {
    const { store, ws, t0 } = await watched();
    const { tDrop, tBack, ws2 } = dropAndReopen(ws);
    ws2.message(initial(value(7, t0)));
    await vi.advanceTimersByTimeAsync(0);
    const live = entryOf(store);
    const trace = liveTrace();
    const plot = plotOf(trace);
    expect(live.resumes).toHaveLength(1);

    // The read-out at the resume names the real sample, 10 min back, not a
    // sample at the cursor.
    const option = optionFor(trace, live);
    const tooltip = option.tooltip as { formatter: (p: { axisValue: number }[]) => string };
    const html = tooltip.formatter([{ axisValue: tBack }]);
    expect(html).toContain('(−10m)');
    expect(html).not.toContain('(0s)');

    // The line data that statistics, the context-menu read-out and snapping
    // read has only the sample and the gap.
    expect(traceLineData(trace, undefined, live, undefined)).toEqual([
      [t0, 7],
      [tDrop, null],
    ]);
    const frame = traceStatFrame(
      plot,
      { archive: new Map(), live: new Map([['t1', live]]), formula: new Map() },
      { fromNs: msToNs(tBack - 30 * MIN), toNs: msToNs(tBack + MIN) }
    );
    expect(frame?.rows[0].columns.y).toEqual([7]);

    expect(dataPointCount(trace, live, undefined)).toBe(1);

    // CSV export reads archive and formula results only: no live row at all.
    expect(buildCsvFiles([plot], new Map(), new Map())).toEqual([]);
  });

  it('keeps the drawing data sorted when the receipt time is before the last IOC sample', async () => {
    // The IOC's clock runs 2 s ahead of this one.
    const { store, instances } = (() => {
      const s = new LiveStore({
        connection: { baseUrl: 'http://canopy.test' },
        webSocketFactory: fake.factory,
      });
      s.watch('t1', PV, 30 * MIN);
      return { store: s, instances: fake.instances };
    })();
    instances[0].open();
    const t0 = Date.now() + 2 * S;
    instances[0].message(initial(value(7, t0)));
    await vi.advanceTimersByTimeAsync(0);
    instances[0].close(1006);
    vi.advanceTimersByTime(1_000);
    const ws2 = instances[1];
    ws2.open();
    // Received before t0 by this clock: the resume is clamped to the break + 1 ms.
    expect(Date.now()).toBeLessThan(t0);
    ws2.message(initial(value(7, t0)));
    ws2.message(diff(value(8, t0 + 3 * S)));
    await vi.advanceTimersByTimeAsync(0);

    const live = entryOf(store);
    expect(live.breaks).toEqual([t0 + 1]);
    expect(live.resumes).toEqual([{ after: t0 + 1, time: t0 + 2, value: 7 }]);
    const drawn = mainData(optionFor(liveTrace(), live, t0 + MIN));
    expect(drawn).toEqual([
      [t0, 7],
      hold(t0 + 1, 7),
      [t0 + 1, null],
      hold(t0 + 2, 7),
      [t0 + 3 * S, 8],
    ]);
    const times = drawn.map(timeOf);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('keeps the drawing data sorted when the IOC stamps lag behind the break', async () => {
    const { store, ws, t0 } = await watched();
    const { tDrop, tBack, ws2 } = dropAndReopen(ws);
    ws2.message(initial(value(7, t0)));
    // The IOC's clock runs behind: a change after the reconnect is stamped
    // before the break, and lands there. The line resumes with it, as the
    // legend reads it.
    ws2.message(diff(value(8, tDrop - S)));
    await vi.advanceTimersByTimeAsync(0);

    const drawn = mainData(optionFor(liveTrace(), entryOf(store)));
    expect(drawn).toEqual([[t0, 7], [tDrop - S, 8], hold(tDrop, 8), [tDrop, null], hold(tBack, 8)]);
    const times = drawn.map(timeOf);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
