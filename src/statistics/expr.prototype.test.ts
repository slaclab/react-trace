import { describe, expect, it } from 'vitest';
import { compileExpression, type ExprLanguage } from './expr';
import { evaluateMetrics, type StatFrame } from './evaluate';
import type { Metric, MetricCatalog } from './model';

const LANG: ExprLanguage = { isVector: (name) => name === 'y' };

// Object.prototype member names must never resolve to a function or a
// constant: each is an unknown function or variable, reported as an error.
const PROTOTYPE_NAMES = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];

describe('names of Object.prototype members', () => {
  it.each(PROTOTYPE_NAMES)('%s(y) is an unknown function, not a throw', (name) => {
    const r = compileExpression(`${name}(y)`, LANG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(`Unknown function ${name}`);
  });

  it.each(PROTOTYPE_NAMES)('%s is a variable, unbound in an empty environment', (name) => {
    const r = compileExpression(`mean(y) + ${name}`, LANG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.compiled.evaluate({ y: Float64Array.from([1, 2]) })).toBeNull();
  });
});

describe('evaluateMetrics', () => {
  const catalog = {
    id: 'proto-test',
    vectorVars: ['y'],
    scalarVars: ['n'],
    jointVars: ['y'],
    alignedRows: true,
  } as unknown as MetricCatalog;
  const frame: StatFrame = { rows: [{ id: 'a', label: 'a', columns: { y: [1, 2, 3] } }] };
  const metric = (id: string, expr: string): Metric =>
    ({ id, label: id, expr, unit: '', on: true }) as Metric;

  it('reports a prototype-member call as that metric error, the others still evaluate', () => {
    const table = evaluateMetrics(catalog, frame, [
      metric('bad', 'constructor(y)'),
      metric('mean', 'mean(y)'),
    ]);
    expect(table.errors.bad).toBe('Unknown function constructor');
    expect(table.rows[0].cells.bad.value).toBeNull();
    expect(table.rows[0].cells.mean.value).toBe(2);
  });
});
