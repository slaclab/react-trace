import { describe, it, expect, vi } from 'vitest';
import { ArchiveStore, type FetchDataFn } from './archiveStore';
import type { WireAlarmSeverity, ArchiverDataDTO } from '@slaclab/canopy-client';
import type { FetchDataParams } from '@slaclab/canopy-client';

// Regression tests for #120: the buffer keeps each sample's severity, so
// PlotArea can break the line at INVALID samples.

const PV = 'AV:TEMP';
// The store's clock sits at the window end, so moving the window forward
// 5 s is a tail fetch spliced into the buffer.
const TO_MS = 1_700_000_000_000;
const SPAN_S = 30;

// Every third second is INVALID; the rest alternate NO_ALARM / MINOR.
const severityAt = (s: number): WireAlarmSeverity =>
  s % 3 === 0 ? 'INVALID' : s % 2 === 0 ? 'MINOR' : 'NO_ALARM';

// One sample per whole second in the requested range, value = epoch second.
function secondsDto(params: FetchDataParams): ArchiverDataDTO {
  const toNs = params.toNs ?? params.fromNs;
  const samples = [];
  for (let s = Math.ceil(params.fromNs / 1e9); s * 1e9 <= toNs; s++) {
    samples.push({ tsNs: s * 1e9, value: s, severity: severityAt(s), source: 'archive' as const });
  }
  return {
    mode: 'raw',
    pv: PV,
    archiver: 'lcls',
    from: params.fromNs,
    to: toNs,
    decimated: false,
    samples,
  };
}

function setup(impl: (params: FetchDataParams) => ArchiverDataDTO) {
  const fetchData = vi.fn(async (_pv: string, params: FetchDataParams) => impl(params));
  const store = new ArchiveStore({ fetchData: fetchData as FetchDataFn, now: () => TO_MS });
  const request = (toMs: number) =>
    store.request('t1', {
      pv: PV,
      archiver: undefined,
      window: { fromNs: (toMs - SPAN_S * 1000) * 1e6, toNs: toMs * 1e6 },
    });
  return { store, fetchData, request };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('archiveStore: severity (#120)', () => {
  it('keeps each raw sample’s severity', async () => {
    const h = setup((params) => {
      const dto = secondsDto(params);
      if (dto.mode === 'raw') {
        // Non-numeric samples are still skipped.
        dto.samples.push({
          tsNs: TO_MS * 1e6,
          value: null,
          severity: 'INVALID',
          source: 'archive',
        });
      }
      return dto;
    });
    h.request(TO_MS);
    await flush();

    const mean = h.store.getSnapshot().get('t1')!.mean;
    expect(mean).toHaveLength(SPAN_S + 1);
    for (const p of mean) {
      expect(p).toEqual({
        time: p.time,
        value: p.time / 1000,
        severity: severityAt(p.time / 1000),
      });
    }
    expect(mean.some((p) => p.severity === 'INVALID')).toBe(true);
  });

  it('keeps severity on both sides of a tail splice', async () => {
    const h = setup(secondsDto);
    h.request(TO_MS);
    await flush();
    h.request(TO_MS + 5_000);
    await flush();

    // The second request was a tail fetch, spliced into the buffer.
    expect(h.fetchData).toHaveBeenCalledTimes(2);
    const tail = h.fetchData.mock.calls[1][1];
    expect(((tail.toNs ?? 0) - tail.fromNs) / 1e9).toBeLessThan(SPAN_S);

    const mean = h.store.getSnapshot().get('t1')!.mean;
    const tailFromMs = tail.fromNs / 1e6;
    expect(mean.some((p) => p.time < tailFromMs)).toBe(true);
    expect(mean.some((p) => p.time >= tailFromMs)).toBe(true);
    for (const p of mean) expect(p.severity).toBe(severityAt(p.time / 1000));
  });

  it('keeps severity on binned mean and band points', async () => {
    const h = setup((params) => ({
      mode: 'binned',
      pv: PV,
      archiver: 'lcls',
      from: params.fromNs,
      to: params.toNs ?? params.fromNs,
      binning: 'auto',
      binSizeNs: null,
      targetBuckets: 5000,
      points: [
        {
          tsNs: 1e12,
          binNs: 1e9,
          mean: 1,
          stdDev: 0,
          min: 0,
          max: 2,
          count: 3,
          severity: 'NO_ALARM',
        },
        {
          tsNs: 2e12,
          binNs: 1e9,
          mean: 5,
          stdDev: 0,
          min: 4,
          max: 6,
          count: 3,
          severity: 'INVALID',
        },
      ],
    }));
    // Over 30 min: binned mode.
    h.store.request('t1', {
      pv: PV,
      archiver: undefined,
      window: { fromNs: (TO_MS - 3_600_000) * 1e6, toNs: TO_MS * 1e6 },
    });
    await flush();

    const entry = h.store.getSnapshot().get('t1')!;
    expect(entry.mode).toBe('binned');
    expect(entry.mean).toEqual([
      { time: 1e6, value: 1, severity: 'NO_ALARM' },
      { time: 2e6, value: 5, severity: 'INVALID' },
    ]);
    expect(entry.band).toEqual([
      { time: 1e6, min: 0, max: 2, severity: 'NO_ALARM' },
      { time: 2e6, min: 4, max: 6, severity: 'INVALID' },
    ]);
  });
});
