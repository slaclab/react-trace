// @vitest-environment jsdom
//
// Fetch behavior of the Data Insight Tool's data hook (#93): a PV the archiver
// doesn't have is asked about once, not every time the window crosses a
// second; a trace with Archive off never queries the archiver; other failures
// back off. The pure merge logic is covered in useInsightData.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

vi.mock('../api/mole', () => ({ fetchData: vi.fn(), fetchMetadata: vi.fn() }));

import { fetchData, fetchMetadata } from '../api/mole';
import { CanopyError } from '../api/client';
import { archiveStore } from '../state/archiveStore';
import { liveStore, type LiveEntry } from '../state/liveStore';
import type { TimeWindowNs } from '../api/time';
import type { PVMetadataDTO } from '../api/types';
import {
  ARCHIVE_OFF_NOTE,
  NOT_ARCHIVED_NOTE,
  useInsightData,
  type InsightStatus,
} from './useInsightData';

const T0_MS = 1_700_000_000_000;
const PV = 'TEST:PV';
const SPAN_S = 60;

const dataMock = vi.mocked(fetchData);
const metaMock = vi.mocked(fetchMetadata);

const notFound = () =>
  new CanopyError('pv_not_found_in_archiver', 404, `PV '${PV}' not in archiver 'lcls' (HTTP 404)`);

function windowAt(nowMs: number): TimeWindowNs {
  const toNs = nowMs * 1e6;
  return { fromNs: toNs - SPAN_S * 1e9, toNs };
}

// Two live samples inside the first window, with units on the latest value.
function liveEntry(): LiveEntry {
  return {
    pv: PV,
    status: 'connected',
    connected: true,
    severity: 'NO_ALARM',
    latest: {
      pv: PV,
      value: 2,
      severity: 'NO_ALARM',
      tsNs: (T0_MS - 5_000) * 1e6,
      connected: true,
      units: 'mm',
      precision: 3,
      error: null,
    },
    error: null,
    points: [
      { time: T0_MS - 10_000, value: 1, severity: 'NO_ALARM' },
      { time: T0_MS - 5_000, value: 2, severity: 'NO_ALARM' },
    ],
  };
}

interface Props {
  pv: string | undefined;
  window: TimeWindowNs;
  archive: boolean;
}

function mount(initial: Partial<Props> = {}) {
  const statuses: InsightStatus[] = [];
  let props: Props = { pv: PV, window: windowAt(Date.now()), archive: true, ...initial };
  const hook = renderHook(
    (p: Props) => {
      const r = useInsightData(p.pv, undefined, p.window, 't1', { archive: p.archive });
      statuses.push(r.status);
      return r;
    },
    { initialProps: props }
  );
  return {
    ...hook,
    statuses,
    async update(next: Partial<Props>) {
      props = { ...props, ...next };
      await act(async () => {
        hook.rerender(props);
        await settle();
      });
    },
    // Advance the clock in one-second steps, re-rendering with the moving
    // window as a live relative-range plot would.
    async tick(seconds: number) {
      for (let i = 0; i < seconds; i++) {
        vi.setSystemTime(Date.now() + 1000);
        await this.update({ window: windowAt(Date.now()) });
      }
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// Let time pass in one-second steps without re-rendering: a fixed or panned
// window, which nothing else moves.
async function wait(seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(settle);
  }
}

function loadingAfterFirstSettled(statuses: InsightStatus[]): number {
  const first = statuses.findIndex((s) => s === 'ready' || s === 'error');
  return first < 0 ? 0 : statuses.slice(first).filter((s) => s === 'loading').length;
}

const META: PVMetadataDTO = {
  pv: PV,
  archiver: 'lcls',
  description: 'BPM X',
  units: 'mm',
  precision: 3,
  displayLow: null,
  displayHigh: null,
  alarmLow: null,
  alarmHigh: null,
  warningLow: null,
  warningHigh: null,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(T0_MS);
  dataMock.mockReset();
  metaMock.mockReset();
  metaMock.mockResolvedValue(META);
  vi.spyOn(liveStore, 'getEntrySnapshot').mockReturnValue(liveEntry());
});

afterEach(() => {
  // Unmount first (vitest globals are off, so RTL doesn't auto-clean), then
  // clear the shared not-archived registry (no plot entries exist here).
  cleanup();
  archiveStore.refetchAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useInsightData: PV not in the archiver', () => {
  it('asks once, then shows live rows while the window moves for 60 s', async () => {
    dataMock.mockRejectedValue(notFound());
    const h = mount();
    await act(settle);

    expect(h.result.current.status).toBe('ready');
    expect(h.result.current.archiveNote).toBe(NOT_ARCHIVED_NOTE);
    expect(h.result.current.rows.map((r) => r.source)).toEqual(['Live', 'Live']);
    expect(h.result.current.meta).toEqual({ pv: PV, units: 'mm', description: null });
    // Shared with the plot's archive store.
    expect(archiveStore.getNotArchived(PV, undefined)?.code).toBe('pv_not_found_in_archiver');

    await h.tick(60);
    expect(dataMock).toHaveBeenCalledTimes(1);
    expect(metaMock).toHaveBeenCalledTimes(1);
    expect(h.result.current.status).toBe('ready');
    expect(loadingAfterFirstSettled(h.statuses)).toBe(0);
  });

  it('skips the archiver when the plot already learned the PV is not archived', async () => {
    archiveStore.markNotArchived(PV, undefined, notFound());
    const h = mount();
    await act(settle);
    await h.tick(10);

    expect(dataMock).not.toHaveBeenCalled();
    expect(metaMock).not.toHaveBeenCalled();
    expect(h.result.current.archiveNote).toBe(NOT_ARCHIVED_NOTE);
    expect(h.result.current.refreshing).toBe(false);
  });

  it('asks again on Refresh and for a different PV', async () => {
    dataMock.mockRejectedValue(notFound());
    const h = mount();
    await act(settle);
    await h.tick(5);
    expect(dataMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      h.result.current.refetch();
      await settle();
    });
    expect(dataMock).toHaveBeenCalledTimes(2);
    await h.tick(5);
    expect(dataMock).toHaveBeenCalledTimes(2);

    await h.update({ pv: 'OTHER:PV' });
    expect(dataMock).toHaveBeenCalledTimes(3);
    expect(dataMock.mock.calls[2][0]).toBe('OTHER:PV');
  });

  it('asks again after the toolbar archive refresh clears the verdict', async () => {
    dataMock.mockRejectedValue(notFound());
    const h = mount();
    await act(settle);
    await act(async () => {
      archiveStore.refetchAll();
      await settle();
    });
    expect(dataMock).toHaveBeenCalledTimes(2);
    await h.tick(5);
    expect(dataMock).toHaveBeenCalledTimes(2);
  });
});

describe('useInsightData: Archive off', () => {
  it('never queries the archiver and shows the live rows', async () => {
    const h = mount({ archive: false });
    await act(settle);
    await h.tick(30);

    expect(dataMock).not.toHaveBeenCalled();
    expect(metaMock).not.toHaveBeenCalled();
    expect(h.result.current.status).toBe('ready');
    expect(h.result.current.archiveNote).toBe(ARCHIVE_OFF_NOTE);
    expect(h.result.current.meta).toEqual({ pv: PV, units: 'mm', description: null });
    expect(h.statuses).not.toContain('loading');
  });

  it('queries the archiver once Archive is turned on', async () => {
    dataMock.mockResolvedValue({
      mode: 'raw',
      pv: PV,
      archiver: 'lcls',
      from: 0,
      to: 0,
      decimated: false,
      samples: [
        { tsNs: (T0_MS - 20_000) * 1e6, value: 0, severity: 'NO_ALARM', source: 'archive' },
      ],
    });
    const h = mount({ archive: false });
    await act(settle);
    await h.update({ archive: true });

    expect(dataMock).toHaveBeenCalledTimes(1);
    expect(h.result.current.archiveNote).toBeUndefined();
    expect(h.result.current.meta?.description).toBe('BPM X');
    expect(h.result.current.rows.map((r) => r.source)).toEqual(['Archive', 'Live', 'Live']);
  });
});

describe('useInsightData: other failures', () => {
  it('backs off instead of retrying every second, without flashing loading', async () => {
    const times: number[] = [];
    dataMock.mockImplementation(async () => {
      times.push((Date.now() - T0_MS) / 1000);
      throw new CanopyError('archiver_unavailable', 503, 'Appliance returned HTTP 503');
    });
    const h = mount();
    await act(settle);
    await h.tick(59);

    expect(times).toEqual([0, 1, 3, 7, 15, 30, 45]);
    expect(h.result.current.status).toBe('error');
    expect(h.result.current.error).toBe('Appliance returned HTTP 503');
    expect(h.result.current.refreshing).toBe(false);
    expect(loadingAfterFirstSettled(h.statuses)).toBe(0);
  });

  const FIXED = windowAt(T0_MS - 3_600_000);

  function failing(): number[] {
    const times: number[] = [];
    dataMock.mockImplementation(async () => {
      times.push((Date.now() - T0_MS) / 1000);
      throw new CanopyError('archiver_unavailable', 503, 'Appliance returned HTTP 503');
    });
    return times;
  }

  it('retries a fixed window when the backoff expires', async () => {
    const times = failing();
    const h = mount({ window: FIXED });
    await act(settle);
    await wait(20);

    expect(times).toEqual([0, 1, 3, 7, 15]);
    expect(h.result.current.status).toBe('error');
    expect(loadingAfterFirstSettled(h.statuses)).toBe(0);
  });

  for (const stop of ['unmount', 'Archive off'] as const) {
    it(`stops retrying on ${stop}`, async () => {
      const times = failing();
      const h = mount({ window: FIXED });
      await act(settle);
      if (stop === 'unmount') h.unmount();
      else await h.update({ archive: false });
      await wait(20);

      expect(times).toEqual([0]);
    });
  }

  it('Refresh bypasses the backoff', async () => {
    dataMock.mockRejectedValue(new CanopyError('archiver_timeout', 504, 'timed out'));
    const h = mount();
    await act(settle);
    await act(async () => {
      h.result.current.refetch();
      await settle();
    });
    expect(dataMock).toHaveBeenCalledTimes(2);
  });
});
