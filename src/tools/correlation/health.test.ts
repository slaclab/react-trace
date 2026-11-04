import { describe, expect, it } from 'vitest';
import {
  AlarmSeverity,
  DISCONNECTED_PV,
  type HareConnectionStatus,
  type PVData,
  type TableResultDTO,
} from '@slaclab/canopy-client';
import resultEmptyRaw from './__fixtures__/table-result-empty.json?raw';
import resultTriggerRaw from './__fixtures__/table-result-trigger.json?raw';
import {
  healthLine,
  initialHealth,
  reduceHealth,
  type HealthContext,
  type HealthEvent,
  type HealthState,
} from './health';

const BINDINGS = { x: 'X:PV', y1: 'Y1:PV', y2: 'Y2:PV', trig: 'TRIG:PV' };

function fixtureTable(raw: string): TableResultDTO {
  return (JSON.parse(raw) as { data: { table: TableResultDTO } }).data.table;
}

const OK_INPUT = { history: 'seeded', status: 'ok', lateAfterFinal: false } as const;

function table(tsNs: number[], totalRows = tsNs.length): TableResultDTO {
  return {
    tsNs,
    columns: { x: tsNs.map(() => 1), y1: tsNs.map(() => 2) },
    inputs: { x: { ...OK_INPUT }, y1: { ...OK_INPUT } },
    totalRows,
  };
}

function pvs(
  status: HareConnectionStatus = 'connected',
  snaps: Record<string, Partial<PVData>> = {}
): HealthContext['pvs'] {
  return {
    status,
    getSnapshot: (pv) =>
      snaps[pv] === undefined
        ? undefined
        : { ...DISCONNECTED_PV, connected: true, severity: AlarmSeverity.NO_ALARM, ...snaps[pv] },
  };
}

function ctx(over: Partial<HealthContext> = {}): HealthContext {
  return {
    paused: false,
    trigger: { mode: 'pv', pv: 'TRIG:PV' },
    bindingPvs: BINDINGS,
    pvs: pvs(),
    rowsPerS: null,
    ...over,
  };
}

function run(events: HealthEvent[], start: HealthState = initialHealth()): HealthState {
  return events.reduce(reduceHealth, start);
}

const OPEN: HealthEvent = { type: 'status', status: 'connected' };
const CLOSE: HealthEvent = { type: 'status', status: 'disconnected' };
const CONNECTING: HealthEvent = { type: 'status', status: 'connecting' };

function result(id: number, now: number, t = table([now * 1e6])): HealthEvent {
  return { type: 'result', id, table: t, now };
}

function live(now = 0): HealthState {
  return run([CONNECTING, OPEN, { type: 'subscribe', id: 1 }, result(1, now)]);
}

describe('health states, first match wins', () => {
  it('none: no spec → "add an X and at least one Y"', () => {
    const line = healthLine(initialHealth(), ctx(), 0);
    expect(line.kind).toBe('none');
    expect(line.line).toBe('add an X and at least one Y');
    expect(line.retry).toBe(false);
  });

  it('paused outranks everything', () => {
    const errored = run([
      OPEN,
      { type: 'subscribe', id: 1 },
      { type: 'error', id: 1, error: { code: 'x', message: 'bad', retryable: false } },
    ]);
    expect(healthLine(errored, ctx({ paused: true }), 0).text).toBe('paused');
    expect(healthLine(initialHealth(), ctx({ paused: true }), 0).text).toBe('paused');
  });

  it('errored → "error: …" with Retry, also over a socket outage', () => {
    const s = run([
      OPEN,
      { type: 'subscribe', id: 1 },
      {
        type: 'error',
        id: 1,
        error: { code: 'table_limit', message: 'too many', retryable: false },
      },
      CLOSE,
      CONNECTING,
    ]);
    const line = healthLine(s, ctx(), 0);
    expect(line.kind).toBe('errored');
    expect(line.text).toBe('error: too many');
    expect(line.retry).toBe(true);
  });

  it('errored survives a close and reopen; only a new id leaves it', () => {
    let s = run([
      OPEN,
      { type: 'subscribe', id: 1 },
      { type: 'error', id: 1, error: { code: 'invalid_spec', message: 'nope', retryable: false } },
      CLOSE,
      CONNECTING,
      OPEN,
    ]);
    expect(healthLine(s, ctx(), 0).text).toBe('error: nope');
    s = reduceHealth(s, result(1, 5));
    expect(healthLine(s, ctx(), 5).kind).toBe('errored');
    s = reduceHealth(s, { type: 'subscribe', id: 2 });
    expect(healthLine(s, ctx(), 5).text).toBe('connecting…');
  });

  it('socket down → "connection lost", or "cannot reach the Formula Engine" if it never opened', () => {
    expect(healthLine(run([OPEN, { type: 'subscribe', id: 1 }, CLOSE]), ctx(), 0).text).toBe(
      'connection lost'
    );
    expect(healthLine(run([{ type: 'subscribe', id: 1 }, CONNECTING, CLOSE]), ctx(), 0).text).toBe(
      'cannot reach the Formula Engine'
    );
  });

  it('connecting after a close stays down; a first connecting is "connecting…"', () => {
    const sub: HealthEvent = { type: 'subscribe', id: 1 };
    expect(healthLine(run([sub, CONNECTING]), ctx(), 0).text).toBe('connecting…');
    expect(healthLine(run([sub, CONNECTING, CLOSE, CONNECTING]), ctx(), 0).text).toBe(
      'cannot reach the Formula Engine'
    );
    expect(healthLine(run([sub, CONNECTING, OPEN, CLOSE, CONNECTING]), ctx(), 0).text).toBe(
      'connection lost'
    );
  });

  it('SDK status idle with a subscription → "connecting…"', () => {
    const s = run([{ type: 'subscribe', id: 1 }]);
    expect(s.status).toBe('idle');
    expect(healthLine(s, ctx(), 0).text).toBe('connecting…');
  });

  it('a retryable error → "waiting for data: <message>" until the next result', () => {
    let s = run([
      OPEN,
      { type: 'subscribe', id: 1 },
      { type: 'error', id: 1, error: { code: 'seed', message: 'seeding', retryable: true } },
    ]);
    expect(healthLine(s, ctx(), 0).text).toBe('waiting for data: seeding');
    s = reduceHealth(s, result(1, 1));
    expect(healthLine(s, ctx(), 1).text).toBe('ok');
  });

  it('pending → live on a result; a socket reopen makes it pending again', () => {
    let s = run([OPEN, { type: 'subscribe', id: 1 }]);
    expect(healthLine(s, ctx(), 0).text).toBe('connecting…');
    s = reduceHealth(s, result(1, 0));
    expect(healthLine(s, ctx(), 0).text).toBe('ok');
    s = run([CLOSE, CONNECTING, OPEN], s);
    expect(healthLine(s, ctx(), 0).text).toBe('connecting…');
    s = reduceHealth(s, result(1, 100));
    expect(healthLine(s, ctx(), 100).text).toBe('ok');
  });

  it('disconnected / INVALID PVs only while Hare is up', () => {
    const s = live();
    const down = pvs('connected', { 'Y1:PV': { connected: false } });
    expect(healthLine(s, ctx({ pvs: down }), 0).text).toBe('disconnected: Y1:PV');
    const invalid = pvs('connected', { 'X:PV': { severity: AlarmSeverity.INVALID } });
    expect(healthLine(s, ctx({ pvs: invalid }), 0).text).toBe('INVALID: X:PV');
    const outage = pvs('disconnected', { 'Y1:PV': { connected: false } });
    const line = healthLine(s, ctx({ pvs: outage }), 0);
    expect(line.text).toBe('ok');
    expect(line.suffixes).toContain('PV status unavailable');
  });

  it('no data: <PV> from status no-data', () => {
    const t = table([1]);
    t.inputs.y1 = { history: 'seeded', status: 'no-data', lateAfterFinal: false };
    const s = run([OPEN, { type: 'subscribe', id: 1 }, result(1, 0, t)]);
    expect(healthLine(s, ctx(), 0).text).toBe('no data: Y1:PV');
  });

  it('ok', () => {
    expect(healthLine(live(), ctx(), 0).line).toBe('ok');
  });
});

describe('superseded ids', () => {
  it('a result or retryable frame of an old id leaves a pending new id pending', () => {
    let s = run([OPEN, { type: 'subscribe', id: 1 }, result(1, 0), { type: 'subscribe', id: 2 }]);
    s = reduceHealth(s, result(1, 1));
    expect(healthLine(s, ctx(), 1).text).toBe('connecting…');
    s = reduceHealth(s, {
      type: 'error',
      id: 1,
      error: { code: 'seed', message: 'old', retryable: true },
    });
    expect(healthLine(s, ctx(), 1).text).toBe('connecting…');
    s = reduceHealth(s, {
      type: 'error',
      id: 1,
      error: { code: 'x', message: 'old', retryable: false },
    });
    expect(healthLine(s, ctx(), 1).text).toBe('connecting…');
  });

  it('a waiting new id stays waiting on an old id’s result', () => {
    let s = run([
      OPEN,
      { type: 'subscribe', id: 1 },
      { type: 'subscribe', id: 2 },
      { type: 'error', id: 2, error: { code: 'seed', message: 'seeding', retryable: true } },
    ]);
    s = reduceHealth(s, result(1, 1));
    expect(healthLine(s, ctx(), 1).text).toBe('waiting for data: seeding');
  });

  it('an errored id stays errored on any frame', () => {
    let s = run([
      OPEN,
      { type: 'subscribe', id: 2 },
      { type: 'error', id: 2, error: { code: 'x', message: 'bad', retryable: false } },
    ]);
    for (const e of [
      result(1, 1),
      result(2, 1),
      { type: 'error', id: 2, error: { code: 's', message: 'w', retryable: true } } as HealthEvent,
    ]) {
      s = reduceHealth(s, e);
      expect(healthLine(s, ctx(), 1).text).toBe('error: bad');
    }
  });
});

describe('silence and staleness', () => {
  const sub: HealthEvent = { type: 'subscribe', id: 1 };

  it('an empty first result ends pending and goes silent after 10 s', () => {
    const s = run([OPEN, sub, result(1, 0, fixtureTable(resultEmptyRaw))]);
    expect(s.sub).toBe('live');
    const quiet = ctx({ bindingPvs: { x: 'X:PV', y: 'Y:PV' } });
    // result-empty says no-data for both inputs; that outranks silence.
    expect(healthLine(s, quiet, 9_999).kind).toBe('no-data');
    const noInputs = run([OPEN, sub, result(1, 0, table([]))]);
    expect(healthLine(noInputs, ctx(), 9_999).text).toBe('ok');
    expect(healthLine(noInputs, ctx(), 10_000).text).toBe('trigger silent');
  });

  it('a seeded first frame of 1000 rows with no further arrival goes silent after 10 s', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => 1e18 + i * 1e8);
    let s = run([OPEN, sub, result(1, 0, table(rows))]);
    // The same rows again are no arrival.
    s = reduceHealth(s, result(1, 5_000, table(rows)));
    expect(s.arrivals).toHaveLength(1);
    expect(healthLine(s, ctx(), 9_999).text).toBe('ok');
    expect(healthLine(s, ctx(), 10_000).text).toBe('trigger silent');
  });

  it('the median rule: silent after max(5 × median interval, 2 s)', () => {
    let s = run([OPEN, sub]);
    for (let i = 0; i < 5; i++) s = reduceHealth(s, result(1, i * 1000, table([(i + 1) * 1e9])));
    // last arrival at 4000, median 1000 → limit 5000
    expect(healthLine(s, ctx(), 9_000).text).toBe('ok');
    expect(healthLine(s, ctx(), 9_001).text).toBe('trigger silent');

    let fast = run([OPEN, sub]);
    for (let i = 0; i < 5; i++)
      fast = reduceHealth(fast, result(1, i * 100, table([(i + 1) * 1e8])));
    // median 100 → 500 < 2 s floor
    expect(healthLine(fast, ctx(), 400 + 2_000).text).toBe('ok');
    expect(healthLine(fast, ctx(), 400 + 2_001).text).toBe('trigger silent');
  });

  it('Timer Δt = 0.1 s goes stale after 3 × 500 ms + 2 s', () => {
    const timer = ctx({ trigger: { mode: 'timer', dtS: 0.1 } });
    const s = run([OPEN, sub, result(1, 0)]);
    expect(healthLine(s, timer, 3_500).text).toBe('ok');
    expect(healthLine(s, timer, 3_501).text).toBe('stale');
    const fresh = reduceHealth(s, result(1, 3_000, table([2e18])));
    expect(healthLine(fresh, timer, 6_000).text).toBe('ok');
  });

  it('Timer staleness uses Δt when it is above the poll floor', () => {
    const timer = ctx({ trigger: { mode: 'timer', dtS: 2 } });
    const s = run([OPEN, sub, result(1, 0)]);
    expect(healthLine(s, timer, 8_000).text).toBe('ok');
    expect(healthLine(s, timer, 8_001).text).toBe('stale');
  });

  it('timers start at the current id’s first result', () => {
    const s = run([OPEN, sub, result(1, 0), { type: 'subscribe', id: 2 }]);
    expect(healthLine(s, ctx(), 60_000).text).toBe('connecting…');
    const s2 = reduceHealth(s, result(2, 60_000));
    expect(healthLine(s2, ctx(), 69_999).text).toBe('ok');
  });
});

describe('suffixes from the current id’s latest frame', () => {
  it('each suffix of result-trigger.json, named by PV', () => {
    const s = run([
      OPEN,
      { type: 'subscribe', id: 1 },
      result(1, 0, fixtureTable(resultTriggerRaw)),
    ]);
    const line = healthLine(s, ctx(), 0);
    expect(line.suffixes).toEqual([
      'no archive history for TRIG:PV',
      'not archived: Y1:PV',
      'history truncated for Y2:PV',
      'late data for Y1:PV',
    ]);
    expect(line.line).toContain(' · not archived: Y1:PV');
  });

  it('"N of M rows shown" iff totalRows > len(tsNs)', () => {
    const t = fixtureTable(resultTriggerRaw);
    const s = run([OPEN, { type: 'subscribe', id: 1 }, result(1, 0, { ...t, totalRows: 1500 })]);
    expect(healthLine(s, ctx(), 0).suffixes).toContain('3 of 1500 rows shown');
    const exact = run([OPEN, { type: 'subscribe', id: 1 }, result(1, 0, t)]);
    expect(healthLine(exact, ctx(), 0).suffixes.some((x) => x.includes('rows shown'))).toBe(false);
  });

  it('a suffix disappears when the latest frame no longer says so', () => {
    let s = run([OPEN, { type: 'subscribe', id: 1 }, result(1, 0, fixtureTable(resultTriggerRaw))]);
    s = reduceHealth(s, result(1, 1, table([2e18])));
    expect(healthLine(s, ctx(), 1).suffixes).toEqual([]);
  });

  it('the row rate is the last suffix once known, absent while null', () => {
    const s = run([
      OPEN,
      { type: 'subscribe', id: 1 },
      result(1, 0, { ...fixtureTable(resultTriggerRaw), totalRows: 1500 }),
    ]);
    const line = healthLine(s, ctx({ pvs: pvs('disconnected'), rowsPerS: 2 }), 0);
    expect(line.suffixes[line.suffixes.length - 1]).toBe('2.000 rows/s');
    expect(line.suffixes).toContain('PV status unavailable');
    expect(line.line.endsWith(' · 2.000 rows/s')).toBe(true);
    expect(healthLine(s, ctx(), 0).suffixes.some((x) => x.endsWith('rows/s'))).toBe(false);
    // No suffixes at all while there is nothing to subscribe.
    expect(healthLine(initialHealth(), ctx({ rowsPerS: 2 }), 0).suffixes).toEqual([]);
  });

  it('a new id starts without suffixes', () => {
    let s = run([OPEN, { type: 'subscribe', id: 1 }, result(1, 0, fixtureTable(resultTriggerRaw))]);
    s = reduceHealth(s, { type: 'subscribe', id: 2 });
    expect(healthLine(s, ctx(), 0).suffixes).toEqual([]);
  });
});
