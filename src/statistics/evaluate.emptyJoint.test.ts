import { afterEach, describe, expect, it } from 'vitest';
import { evaluateMetrics, type StatFrame } from './evaluate';
import type { Metric, MetricCatalog } from './model';

const catalog = {
  id: 'empty-joint-test',
  vectorVars: ['y'],
  scalarVars: ['n'],
  jointVars: [],
  alignedRows: true,
} as unknown as MetricCatalog;

const metric = (id: string, expr: string): Metric =>
  ({ id, label: id, expr, unit: '', on: true }) as Metric;

/**
 * A synchronous loop cannot be interrupted by a test timeout, so a runaway
 * one is cut off here: past this many pushes the guard throws and the test
 * fails at once instead of growing an array until the process dies.
 */
const RUNAWAY_PUSHES = 1_000_000;

describe('a row whose joint column set is empty', () => {
  const realPush = Array.prototype.push;

  afterEach(() => {
    Array.prototype.push = realPush;
  });

  function evaluateGuarded(frame: StatFrame, metrics: Metric[]) {
    let pushes = 0;
    Array.prototype.push = function guardedPush(this: unknown[], ...items: unknown[]) {
      pushes += 1;
      if (pushes > RUNAWAY_PUSHES) throw new Error('runaway loop: unbounded array growth');
      return realPush.apply(this, items);
    };
    try {
      return evaluateMetrics(catalog, frame, metrics);
    } finally {
      Array.prototype.push = realPush;
    }
  }

  it('terminates for a row with no y: n is 0 and a constant still evaluates', () => {
    // `y` is required by the type; a row built from a missing result lacks it.
    const frame = { rows: [{ id: 'a', label: 'a', columns: {} }] } as unknown as StatFrame;
    const table = evaluateGuarded(frame, [metric('n', 'n'), metric('two', '1+1')]);
    expect(table.rows[0].cells.n.value).toBe(0);
    expect(table.rows[0].cells.two.value).toBe(2);
  });

  it('still counts the finite rows of a row that has y', () => {
    const frame: StatFrame = { rows: [{ id: 'a', label: 'a', columns: { y: [1, NaN, 3] } }] };
    const table = evaluateGuarded(frame, [metric('n', 'n')]);
    expect(table.rows[0].cells.n.value).toBe(2);
  });
});
