// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FormulaResultDTO,
  FormulaSpec,
  FormulaEngineConnectionStatus,
  FormulaEngineSubscribeOptions,
  TableResultDTO,
} from '@slaclab/canopy-client';
import { SPEC_DEBOUNCE_MS, TableController, type FormulaEngineTableService } from './useTable';
import type { TableSpecResult } from './spec';
import { applyCut, CSV_CUT_PREFIX, csvColumns, frameCsv, newestTsNs } from './export';
import { fitStats, type FrameLike } from './stats';

const S = 1_000_000_000;
const BASE = 1_790_000_000_000_000_000;
const X = 'SIM:MAG:HCM:01:CURRENT:SP';
const Y1 = 'SIM:DIAG:BPM:01:POSITION:X';
const Y2 = 'SIM:DIAG:BPM:12:POSITION:X';

/** A table of `rows` rows starting `start` seconds after BASE, 1 s apart. */
function table(start: number, rows: number, columns: string[]): TableResultDTO {
  const tsNs = Array.from({ length: rows }, (_, i) => BASE + (start + i) * S);
  const cols: Record<string, (number | null)[]> = {};
  for (const c of columns) {
    cols[c] = tsNs.map((_, i) => (c === 'x' ? start + i : (start + i) * 2 + c.length));
  }
  return { tsNs, columns: cols, inputs: {}, totalRows: rows };
}

function frame(t: TableResultDTO, columnPvs: Record<string, string>): FrameLike {
  return { table: t, columnPvs };
}

/** CSV data rows (no `#` comments, no header) as tsNs strings. */
function csvTs(csv: string): string[] {
  return csv
    .trim()
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .slice(1)
    .map((l) => l.split(',')[0]);
}

function csvHeader(csv: string): string[] {
  return csv
    .split('\n')
    .filter((l) => !l.startsWith('#'))[0]
    .split(',');
}

// ── A fake Formula Engine service recording subscribe / unsubscribe ──────────────────

interface Sub {
  spec: FormulaSpec;
  opts: FormulaEngineSubscribeOptions;
  unsubscribed: boolean;
}

class FakeFox implements FormulaEngineTableService {
  status: FormulaEngineConnectionStatus = 'connected';
  readonly subs: Sub[] = [];
  unsubscribes = 0;
  connect(): void {}
  dispose(): void {}
  subscribe(spec: FormulaSpec, opts: FormulaEngineSubscribeOptions): () => void {
    const sub: Sub = { spec, opts, unsubscribed: false };
    this.subs.push(sub);
    return () => {
      sub.unsubscribed = true;
      this.unsubscribes++;
    };
  }
  /** Deliver a table result to the newest subscription. */
  emit(t: TableResultDTO): void {
    const sub = this.subs[this.subs.length - 1];
    const data = { kind: 'table', table: t } as unknown as FormulaResultDTO;
    sub.opts.onResult?.(data);
  }
}

function ready(columnPvs: Record<string, string>): TableSpecResult {
  const columns = Object.fromEntries(Object.keys(columnPvs).map((c) => [c, `{${c}}`]));
  const spec = {
    kind: 'table',
    index: 'grid',
    mode: 'raw',
    align: 'last',
    gridDtNs: S,
    bindings: { ...columnPvs },
    columns,
    maxPoints: 1000,
  } as unknown as FormulaSpec;
  return {
    kind: 'ready',
    table: {
      spec,
      t0Ns: -3600 * S,
      columnPvs,
      bindingPvs: { ...columnPvs },
      trigger: { mode: 'timer', dtS: 1 },
      key: JSON.stringify(columnPvs),
    },
  };
}

describe('Clear (data-clock cut)', () => {
  const pvs = { x: X, y1: Y1, y2: Y2 };

  it('drops rows ≤ the cut, and later frames stay filtered', () => {
    const f1 = frame(table(0, 5, ['x', 'y1', 'y2']), pvs);
    const cut = newestTsNs(f1);
    expect(cut).toBe(BASE + 4 * S);
    expect(applyCut(f1, cut).table.tsNs).toEqual([]);
    expect(fitStats(applyCut(f1, cut)).x?.stats.n).toBe(0);

    // The next frame overlaps the cut (rows 2..7): only 5..7 remain.
    const f2 = frame(table(2, 6, ['x', 'y1', 'y2']), pvs);
    const shown = applyCut(f2, cut);
    expect(shown.table.tsNs).toEqual([BASE + 5 * S, BASE + 6 * S, BASE + 7 * S]);
    expect(shown.table.columns.x).toEqual([5, 6, 7]);
    expect(shown.table.columns.y2).toHaveLength(3);
    // A later frame still entirely after the cut is untouched.
    const f3 = frame(table(10, 2, ['x', 'y1']), pvs);
    expect(applyCut(f3, cut)).toBe(f3);
    expect(applyCut(f3, null)).toBe(f3);
  });

  it('Clear, then a new frame, then export: every row is newer than the cut and the header records it', () => {
    const f1 = frame(table(0, 5, ['x', 'y1', 'y2']), pvs);
    const cut = newestTsNs(f1) as number;
    const f2 = applyCut(frame(table(3, 4, ['x', 'y1', 'y2']), pvs), cut);
    const csv = frameCsv(f2, cut);
    expect(csv.split('\n')).toContain(`${CSV_CUT_PREFIX}${cut}`);
    const ts = csvTs(csv);
    expect(ts).toHaveLength(2);
    for (const t of ts) expect(Number(t)).toBeGreaterThan(cut);
    expect(ts[0]).toBe(String(BASE + 5 * S));
  });

  it('without a Clear the header says none', () => {
    const csv = frameCsv(frame(table(0, 2, ['x', 'y']), { x: X, y: Y1 }), null);
    expect(csv.split('\n')).toContain(`${CSV_CUT_PREFIX}none`);
  });
});

describe('CSV shape', () => {
  it('is wide: tsNs, iso, X PV, Y PVs in colour order; null is an empty cell', () => {
    const t = table(0, 2, ['x', 'y1', 'y2']);
    t.columns.y1[1] = null;
    const csv = frameCsv(frame(t, { y2: Y2, x: X, y1: Y1 }), null);
    expect(csvHeader(csv)).toEqual(['tsNs', 'iso', X, Y1, Y2]);
    const rows = csv
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .slice(1);
    expect(rows[0]).toBe(`${BASE},${new Date(BASE / 1e6).toISOString()},0,2,2`);
    expect(rows[1].split(',')[3]).toBe('');
    expect(csvColumns({ x: X, y: Y1 })).toEqual(['x', 'y']);
  });

  it('quotes a PV name that needs it', () => {
    const csv = frameCsv(frame(table(0, 1, ['x', 'y']), { x: 'a,b', y: 'q"z' }), null);
    expect(csvHeader(csv.replace('"a,b"', 'AB'))).toEqual(['tsNs', 'iso', 'AB', '"q""z"']);
  });
});

describe('Pause and export through the table controller', () => {
  let engine: FakeFox;
  let ctl: TableController;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = new FakeFox();
    ctl = new TableController();
    ctl.attach(engine);
    ctl.setWanted(true);
  });

  afterEach(() => {
    ctl.dispose();
    vi.useRealTimers();
  });

  function subscribeTo(columnPvs: Record<string, string>) {
    ctl.setSpec(ready(columnPvs));
    vi.advanceTimersByTime(SPEC_DEBOUNCE_MS);
  }

  it('Pause/Resume make no subscribe or unsubscribe call', () => {
    subscribeTo({ x: X, y1: Y1, y2: Y2 });
    engine.emit(table(0, 3, ['x', 'y1', 'y2']));
    const subs = engine.subs.length;
    const unsubs = engine.unsubscribes;
    ctl.setPaused(true);
    engine.emit(table(1, 3, ['x', 'y1', 'y2']));
    ctl.setPaused(false);
    ctl.setPaused(true);
    ctl.setPaused(false);
    expect(engine.subs.length).toBe(subs);
    expect(engine.unsubscribes).toBe(unsubs);
    expect(subs).toBe(1);
    expect(unsubs).toBe(0);
  });

  it('Pause, then new frames arrive, then export: the CSV holds exactly the paused frame rows the readout used', () => {
    const pvs = { x: X, y1: Y1, y2: Y2 };
    subscribeTo(pvs);
    const paused = table(0, 4, ['x', 'y1', 'y2']);
    engine.emit(paused);
    ctl.setPaused(true);
    engine.emit(table(1, 6, ['x', 'y1', 'y2']));
    engine.emit(table(3, 9, ['x', 'y1', 'y2']));

    const shown = ctl.getSnapshot().frame;
    expect(shown).not.toBeNull();
    const csv = frameCsv(shown as FrameLike, null);
    const used = fitStats(shown);
    expect(csvTs(csv)).toEqual(paused.tsNs.map(String));
    expect(used.x?.stats.n).toBe(paused.tsNs.length);
    expect(used.ys.map((y) => y.stats.n)).toEqual([4, 4]);

    // Resume shows the newest at once.
    ctl.setPaused(false);
    expect(ctl.getSnapshot().frame?.table.tsNs).toHaveLength(9);
  });

  it('remove Y1 while paused, then export: the header names the frozen frame PVs', () => {
    subscribeTo({ x: X, y1: Y1, y2: Y2 });
    engine.emit(table(0, 3, ['x', 'y1', 'y2']));
    ctl.setPaused(true);

    // Y1 removed: one Y left, its column is `y`.
    subscribeTo({ x: X, y: Y2 });
    expect(engine.subs).toHaveLength(2);
    engine.emit(table(1, 3, ['x', 'y']));

    const shown = ctl.getSnapshot().frame as FrameLike;
    expect(csvHeader(frameCsv(shown, null))).toEqual(['tsNs', 'iso', X, Y1, Y2]);
    expect(fitStats(shown).ys.map((y) => y.pv)).toEqual([Y1, Y2]);

    ctl.setPaused(false);
    const resumed = ctl.getSnapshot().frame as FrameLike;
    expect(csvHeader(frameCsv(resumed, null))).toEqual(['tsNs', 'iso', X, Y2]);
  });
});
