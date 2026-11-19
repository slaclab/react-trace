import { describe, it, expect } from 'vitest';
import { codeFragment } from './codeFragment';

describe('codeFragment', () => {
  it('prints an object as indented source with identifier keys bare and others quoted', () => {
    expect(codeFragment({ type: 'line', 'line-width': 2, name: 'TEST:C01' })).toBe(
      ['{', "  type: 'line',", "  name: 'TEST:C01',", "  'line-width': 2", '}'].join('\n')
    );
  });

  it('elides a series data array with its point count', () => {
    const out = codeFragment({ type: 'line', data: [1, 2, 3, 4, 5] });
    expect(out).toContain('data: /* 5 points */');
    expect(out).not.toMatch(/\b5\b(?! points)/);
  });

  it('elides nested data arrays by their outer length, not their element count', () => {
    const out = codeFragment({
      series: [
        {
          type: 'scatter',
          data: [
            [0, 1],
            [2, 3],
            [4, 5],
          ],
        },
        { type: 'line', data: [] },
      ],
    });
    expect(out).toContain('data: /* 3 points */');
    expect(out).toContain('data: /* 0 points */');
    expect(out).not.toContain('[0, 1]');
  });

  it('elides a typed array wherever it appears', () => {
    const out = codeFragment({ extra: new Float64Array(7), deep: { y: new Float32Array(2) } });
    expect(out).toContain('extra: /* 7 points */');
    expect(out).toContain('y: /* 2 points */');
  });

  it('elides a dataset source, whether rows or a record of columns', () => {
    const rows = codeFragment({
      dataset: {
        source: [
          [1, 2],
          [3, 4],
        ],
      },
    });
    expect(rows).toContain('source: /* 2 points */');
    const cols = codeFragment({
      dataset: [{ id: 'live', source: { x: new Float64Array(4), 'TEST:BPM': [1, 2, 3, 4] } }],
    });
    expect(cols).toContain('x: /* 4 points */');
    expect(cols).toContain("'TEST:BPM': /* 4 points */");
    expect(cols).toContain("id: 'live'");
  });

  it('keeps short non-data arrays inline', () => {
    expect(codeFragment({ center: ['50%', '50%'], color: ['#fff'] })).toBe(
      ['{', "  center: ['50%', '50%'],", "  color: ['#fff']", '}'].join('\n')
    );
  });

  it('drops functions and undefined from objects, and prints them as null inside arrays', () => {
    const fragment = {
      type: 'value',
      formatter: (v: number) => `${v}`,
      min: undefined,
      max: 10,
      pair: [undefined, () => 1, 3],
    };
    const out = codeFragment(fragment);
    expect(out).not.toContain('formatter');
    expect(out).not.toContain('min');
    expect(out).not.toContain('undefined');
    expect(out).toContain('pair: [null, null, 3]');
    expect(codeFragment(fragment)).toBe(out);
  });

  it('prints the same source regardless of key insertion order', () => {
    const a = codeFragment({
      type: 'line',
      id: 'a',
      name: 'n',
      smooth: false,
      lineStyle: { width: 2, color: '#f00' },
    });
    const b = codeFragment({
      lineStyle: { color: '#f00', width: 2 },
      smooth: false,
      name: 'n',
      id: 'a',
      type: 'line',
    });
    expect(a).toBe(b);
    // id, type and name lead; the rest follows alphabetically.
    expect(a.split('\n').slice(1, 4)).toEqual(["  id: 'a',", "  type: 'line',", "  name: 'n',"]);
    expect(a.indexOf('lineStyle')).toBeLessThan(a.indexOf('smooth'));
  });

  it('prints special numbers, null, booleans, escaped strings and empty containers', () => {
    const out = codeFragment({ a: NaN, b: -Infinity, c: null, d: true, e: "it's", f: {}, g: [] });
    expect(out).toContain('a: NaN');
    expect(out).toContain('b: -Infinity');
    expect(out).toContain('c: null');
    expect(out).toContain('d: true');
    expect(out).toContain("e: 'it\\'s'");
    expect(out).toContain('f: {}');
    expect(out).toContain('g: []');
  });

  it('prints a top-level primitive or array fragment', () => {
    expect(codeFragment(3)).toBe('3');
    expect(codeFragment([{ type: 'value' }])).toBe(
      ['[', '  {', "    type: 'value'", '  }', ']'].join('\n')
    );
  });

  it('marks a circular reference instead of recursing forever', () => {
    const o: Record<string, unknown> = { type: 'line' };
    o.self = o;
    expect(codeFragment(o)).toContain('self: /* circular */');
  });

  it('does not mutate its input', () => {
    const input = { type: 'line', data: [1, 2], fn: () => 0 };
    codeFragment(input);
    expect(input.data).toEqual([1, 2]);
    expect(typeof input.fn).toBe('function');
  });
});
