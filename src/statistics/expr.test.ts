import { describe, expect, it } from 'vitest';
import ormFrameRaw from '../tools/correlation/__fixtures__/orm-frame.json?raw';
import { CORRELATION_METRICS } from '../tools/correlation/metrics';
import { validateExpression } from './model';
import { columnStats, pairStats, yColumns, type FrameLike } from '../tools/correlation/stats';
import {
  compileExpression as compileIn,
  FUNCTION_REFERENCE,
  NOT_SCALAR,
  type CompiledExpression,
  type ExprEnv,
} from './expr';
import { languageOf } from './model';

const LANG = languageOf(CORRELATION_METRICS);
const compileExpression = (expr: string) => compileIn(expr, LANG);

function compile(expr: string): CompiledExpression {
  const r = compileExpression(expr);
  if (!r.ok) throw new Error(`${expr}: ${r.error} at ${r.position}`);
  return r.compiled;
}

const run = (expr: string, env: ExprEnv = {}) => compile(expr).evaluate(env);
const vec = (...xs: number[]) => Float64Array.from(xs);

/** Relative `rel`, absolute 1e-15 near zero. */
function expectClose(actual: number | null, expected: number | null, rel = 1e-12) {
  if (expected === null) {
    expect(actual).toBeNull();
    return;
  }
  expect(actual).not.toBeNull();
  const tol = Math.max(rel * Math.abs(expected), 1e-15);
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tol);
}

describe('precedence and arithmetic', () => {
  it.each([
    ['-2^2', -4],
    ['2^3^2', 512],
    ['1+2*3', 7],
    ['(1+2)*3', 9],
    ['10/4', 2.5],
    ['2*-3', -6],
    ['--2', 2],
    ['2^-1', 0.5],
    ['1 - 2 - 3', -4],
    ['8 / 2 / 2', 2],
    ['1.5e2 + .5', 150.5],
    ['pi', Math.PI],
    ['e', Math.E],
  ])('%s = %d', (expr, value) => {
    expectClose(run(expr), value);
  });

  it('unary minus on a vector is element-wise', () => {
    expect(run('sum(-v * v)', { v: vec(1, 2, 3) })).toBe(-14);
    expect(run('first(-v)', { v: vec(4, 5) })).toBe(-4);
  });

  it('broadcasts a scalar over a vector and combines vectors element-wise', () => {
    const env = { a: vec(1, 2, 3), b: vec(10, 20, 30) };
    expect(run('sum(a + b)', env)).toBe(66);
    expect(run('sum(2 * a)', env)).toBe(12);
    expect(run('sum(a ^ 2)', env)).toBe(14);
    expect(run('sum(pow(2, a))', env)).toBe(14);
    expect(run('last(b / a)', env)).toBe(10);
  });

  it('vectors of different lengths are undefined', () => {
    expect(run('sum(a + b)', { a: vec(1, 2), b: vec(1, 2, 3) })).toBeNull();
    expect(run('corr(a, b)', { a: vec(1, 2, 3), b: vec(1, 2, 3, 4) })).toBeNull();
  });
});

describe('functions', () => {
  const v = vec(3, -1, 4, 1, -5, 9, 2, 6);

  it('element-wise', () => {
    expect(run('sum(abs(v))', { v })).toBe(31);
    expect(run('sqrt(16)')).toBe(4);
    expectClose(run('ln(exp(2))'), 2);
    expect(run('log10(1000)')).toBe(3);
    expect(run('log2(8)')).toBe(3);
    expectClose(run('sin(pi/2) + cos(0) + tan(0)'), 2);
    expect(run('floor(-1.5) + ceil(1.2)')).toBe(0);
    expect(run('round(2.5) + round(-2.5) + round(1.4)')).toBe(1);
    expect(run('sum(sign(v))', { v })).toBe(4);
  });

  it('aggregates', () => {
    expect(run('count(v)', { v })).toBe(8);
    expect(run('sum(v)', { v })).toBe(19);
    expect(run('mean(v)', { v })).toBe(19 / 8);
    expect(run('median(v)', { v })).toBe(2.5);
    expect(run('median(vec)', { vec: vec(5, 1, 3) })).toBe(3);
    expect(run('min(v)', { v })).toBe(-5);
    expect(run('max(v)', { v })).toBe(9);
    expect(run('ptp(v)', { v })).toBe(14);
    expect(run('first(v) + last(v)', { v })).toBe(9);
    expectClose(run('var(v)', { v }), run('std(v)^2', { v }));
    expectClose(run('rms(v)', { v }), Math.sqrt(173 / 8));
  });

  it('min and max with several arguments are element-wise', () => {
    expect(run('sum(max(v, 0))', { v })).toBe(25);
    expect(run('sum(min(v, 0, 2))', { v })).toBe(-6);
    expect(run('max(1, 7, 3)')).toBe(7);
  });

  it('percentile interpolates linearly like numpy', () => {
    const w = vec(10, 20, 30, 40);
    expect(run('percentile(w, 0)', { w })).toBe(10);
    expect(run('percentile(w, 100)', { w })).toBe(40);
    expect(run('percentile(w, 25)', { w })).toBe(17.5);
    expect(run('percentile(w, 90)', { w })).toBeCloseTo(37, 12);
    expect(run('percentile(w, 101)', { w })).toBeNull();
    expect(run('percentile(w, w)', { w })).toBeNull();
  });

  it('aggregates treat a scalar as one value', () => {
    expect(run('count(5)')).toBe(1);
    expect(run('mean(5)')).toBe(5);
    expect(run('std(5)')).toBeNull();
  });

  it('pairs: cov and r2 on a small exact case', () => {
    const env = { a: vec(1, 2, 3, 4), b: vec(2, 4, 6, 8.5) };
    const p = pairStats([1, 2, 3, 4], [2, 4, 6, 8.5]);
    // mean(b) = 5.125: (1.5·3.125 + 0.5·1.125 + 0.5·0.875 + 1.5·3.375) / 3
    expectClose(run('cov(a, b)', env), 10.75 / 3);
    expectClose(run('r2(a, b)', env), p.r2);
    expectClose(run('corr(a, b)', env), p.r);
  });
});

describe('on the oracle frame, stats.ts and the language agree', () => {
  const frame = JSON.parse(ormFrameRaw) as FrameLike;
  const xCells = frame.table.columns.x ?? [];
  const ys = yColumns(frame.columnPvs);

  /** The pairwise-finite rows of x and one Y, as the caller builds them. */
  function envFor(column: string): { x: Float64Array; y: Float64Array; n: number } {
    const yCells = frame.table.columns[column] ?? [];
    const xs: number[] = [];
    const yv: number[] = [];
    for (let i = 0; i < Math.min(xCells.length, yCells.length); i++) {
      const x = xCells[i];
      const y = yCells[i];
      if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      xs.push(x);
      yv.push(y);
    }
    return { x: Float64Array.from(xs), y: Float64Array.from(yv), n: xs.length };
  }

  it('has Y columns', () => {
    expect(ys.length).toBeGreaterThan(1);
  });

  it.each(ys)('%s: mean, std, corr, slope, intercept, r2 match pairStats', (column) => {
    const env = envFor(column);
    const p = pairStats(xCells, frame.table.columns[column] ?? []);
    expect(run('n', env)).toBe(p.n);
    expect(run('count(y)', env)).toBe(p.n);
    expectClose(run('mean(y)', env), p.mean);
    expectClose(run('std(y)', env), p.std);
    expectClose(run('corr(x, y)', env), p.r);
    expectClose(run('slope(x, y)', env), p.slope);
    expectClose(run('intercept(x, y)', env), p.intercept);
    expectClose(run('r2(x, y)', env), p.r2);
  });

  it.each(ys)('%s: derived identities', (column) => {
    const env = envFor(column);
    const n = env.n;
    const std = run('std(y)', env) as number;
    expectClose(run('std(y - mean(y))', env), std);
    // rms is population (÷n) about zero; std is sample (÷(n−1)).
    expectClose(run('rms(y - mean(y))', env), std * Math.sqrt((n - 1) / n));
    expectClose(run('max(abs(y))', env), Math.max(...Array.from(env.y, Math.abs)));
    expectClose(
      run('ptp(y)', env),
      (run('max(y)', env) as number) - (run('min(y)', env) as number)
    );
    expect(run('percentile(y, 50)', env)).toBe(run('median(y)', env));
  });

  it('mean(x) and std(x) match columnStats', () => {
    const c = columnStats(xCells);
    const x = Float64Array.from(
      xCells.filter((v): v is number => v !== null && Number.isFinite(v))
    );
    expectClose(run('mean(x)', { x }), c.mean);
    expectClose(run('std(x)', { x }), c.std);
  });

  it('12 expressions × 8 Ys over 10 000 rows stays fast', () => {
    const rows = 10_000;
    const x = new Float64Array(rows).map((_, i) => Math.sin(i / 100));
    const ysBig = Array.from({ length: 8 }, (_, k) =>
      new Float64Array(rows).map((_, i) => k * Math.cos(i / 37) + i * 1e-4)
    );
    const exprs = [
      'mean(y)',
      'std(y)',
      'corr(x, y)',
      'slope(x, y)',
      'intercept(x, y)',
      'r2(x, y)',
      'rms(y - mean(y))',
      'max(abs(y))',
      'ptp(y)',
      'percentile(y, 90)',
      'cov(x, y)',
      'mean((y - mean(y)) * (x - mean(x))) / (std(x) * std(y))',
    ].map(compile);
    const pass = () => {
      for (const y of ysBig) for (const c of exprs) c.evaluate({ x, y, n: rows, t: x });
    };
    pass(); // warm up the JIT
    const start = performance.now();
    pass();
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe('undefined results are null', () => {
  it.each([
    ['corr(x, y)', { x: vec(1, 2, 3, 4), y: vec(5, 5, 5, 5) }],
    ['slope(x, y)', { x: vec(2, 2, 2), y: vec(1, 2, 3) }],
    ['corr(x, y)', { x: vec(1, 2), y: vec(3, 5) }],
    ['std(y)', { y: vec(1) }],
    ['cov(x, y)', { x: vec(1), y: vec(1) }],
    ['mean(y)', { y: vec() }],
    ['median(y)', { y: vec() }],
    ['max(y)', { y: vec() }],
    ['1/0', {}],
    ['0/0', {}],
    ['sqrt(-1)', {}],
    ['mean(z)', { y: vec(1, 2) }],
  ])('%s', (expr, env) => {
    expect(run(expr, env)).toBeNull();
  });

  it('slope and intercept exist with two rows; corr does not', () => {
    const env = { x: vec(0, 2), y: vec(1, 5) };
    expect(run('slope(x, y)', env)).toBe(2);
    expect(run('intercept(x, y)', env)).toBe(1);
    expect(run('corr(x, y)', env)).toBeNull();
  });

  it('a NaN inside an aggregate propagates', () => {
    expect(run('max(sqrt(y))', { y: vec(4, -1, 9) })).toBeNull();
    expect(run('median(ln(y))', { y: vec(1, -1, 2) })).toBeNull();
  });
});

describe('vector results', () => {
  it.each(['y * 2', 'y', 'x - mean(x)', 'abs(y1)', 'min(x, 0)', '-t', 'pow(y, 2)', '(y + 1) ^ 2'])(
    '%s is a compile error naming the fix',
    (expr) => {
      const result = compileExpression(expr);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(NOT_SCALAR);
        expect(result.position).toBe(0);
      }
    }
  );

  it.each(['mean(y) * 2', 'n', 'min(y)', 'mean(max(x, 1))', 'count(abs(y1))'])(
    '%s compiles',
    (expr) => {
      expect(compileExpression(expr).ok).toBe(true);
    }
  );

  it('validateExpression reports a vector result before an unknown variable', () => {
    expect(validateExpression(CORRELATION_METRICS, 'y3 * 2', 2)).toBe(NOT_SCALAR);
    expect(validateExpression(CORRELATION_METRICS, 'mean(y3)', 2)).toBe(
      'Unknown variable y3: only 2 Y PVs'
    );
  });
});

describe('vars and env', () => {
  it('lists variables in first-use order, without constants or functions', () => {
    expect(compile('corr(x, y2) + mean(y1 * pi - x / e) + mean(y2) + n').vars).toEqual([
      'x',
      'y2',
      'y1',
      'n',
    ]);
    expect(compile('1 + 2').vars).toEqual([]);
  });

  it('does not mutate env arrays', () => {
    const x = vec(1, 2, 3, 4);
    const y = vec(2, 3, 5, 9);
    const before = [Array.from(x), Array.from(y)];
    for (const expr of [
      '-y',
      'y * 2 + x',
      'median(y)',
      'percentile(x, 30)',
      'max(x, y)',
      'abs(-y)',
    ]) {
      run(`sum(${expr})`, { x, y });
    }
    expect([Array.from(x), Array.from(y)]).toEqual(before);
  });

  it('a compiled expression is reusable across envs', () => {
    const c = compile('mean(y) * 2');
    expect(c.evaluate({ y: vec(1, 3) })).toBe(4);
    expect(c.evaluate({ y: vec(10) })).toBe(20);
    expect(c.evaluate({})).toBeNull();
  });
});

describe('compile errors', () => {
  it.each([
    ['', 'Empty expression', 0],
    ['   ', 'Empty expression', 0],
    ['1 +', 'Unexpected end of expression', 3],
    ['mean(', 'Unexpected end of expression', 5],
    ['(1 + 2', "Expected ')'", 6],
    ['(1 2)', "Expected ')'", 3],
    ['mean(y y)', "Expected ')'", 7],
    ['1 + 2)', "Unexpected ')'", 5],
    [')', "Unexpected ')'", 0],
    ['max(y,)', "Unexpected ')'", 6],
    ['1 2', "Unexpected '2'", 2],
    ['+1', "Unexpected '+'", 0],
    ['2 ** 3', "Unexpected '*'", 3],
    ['y $ 2', "Unexpected character '$'", 2],
    ['foo(y)', 'Unknown function foo', 0],
    ['1 + x(2)', 'Unknown function x', 4],
    ['corr(x)', 'corr expects 2 arguments', 0],
    ['percentile(y)', 'percentile expects 2 arguments', 0],
    ['abs(x, y)', 'abs expects 1 argument', 0],
    ['mean()', 'mean expects 1 argument', 0],
    ['max()', 'max expects at least 1 argument', 0],
    ['sqrt + 1', 'sqrt is a function: write sqrt(…)', 0],
  ])('%j → %s', (expr, error, position) => {
    expect(compileExpression(expr)).toEqual({ ok: false, error, position });
  });

  it('unknown variables compile; validateExpression catches them', () => {
    expect(compileExpression('mean(foo)').ok).toBe(true);
  });
});

describe('validateExpression', () => {
  it.each([
    ['corr(x, y)', 2, null],
    ['mean(y1) - mean(y2) + t[0]', 2, "Unexpected character '['"],
    ['mean(y1) - mean(y2) + last(t) + n', 2, null],
    ['mean(y3)', 2, 'Unknown variable y3: only 2 Y PVs'],
    ['mean(y2)', 1, 'Unknown variable y2: only 1 Y PV'],
    ['mean(y1)', 0, 'Unknown variable y1: no Y PVs'],
    ['corr(x, y)', 0, null],
    ['mean(y0)', 4, 'Unknown variable y0'],
    ['mean(foo)', 4, 'Unknown variable foo'],
    ['mean(', 4, 'Unexpected end of expression'],
  ])('%s with %d Ys → %s', (expr, yCount, message) => {
    expect(validateExpression(CORRELATION_METRICS, expr, yCount)).toBe(message);
  });
});

describe('EXPRESSION_REFERENCE', () => {
  it('documents every function the compiler accepts and nothing else', () => {
    for (const f of FUNCTION_REFERENCE) {
      expect(f.signature.startsWith(`${f.name}(`)).toBe(true);
      expect(f.description).not.toBe('');
      const args =
        f.name === 'min' || f.name === 'max' ? 'v' : f.signature.slice(f.name.length + 1, -1);
      const call = `${f.name}(${args.replace(/[ab]/g, 'v').replace(/\bp\b/, '50')})`;
      expect(compileExpression(call).ok, call).toBe(true);
    }
    expect(FUNCTION_REFERENCE.map((f) => f.name)).toHaveLength(35);
  });

  it('documents the variables', () => {
    const names = CORRELATION_METRICS.variables.map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining(['x', 'y', 'y1', 't', 'n', 'pi', 'e']));
  });
});
