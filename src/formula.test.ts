import { describe, it, expect } from 'vitest';
import { extractFormulaVars, resolveBindings, resolveFormulaSpec } from './formula';
import type { PVTrace } from './types';

function pvTrace(id: string, pvName: string): PVTrace {
  return {
    id,
    kind: 'pv',
    pvName,
    displayName: pvName,
    color: '#000',
    visible: true,
    axisId: 'y',
    useLive: false,
    updateRate: 'monitor',
    useArchive: true,
    lineWidth: 2,
    lineType: 'step',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'circle',
    symbolSize: 10,
    data: [],
  };
}

function formulaTrace(id: string, expression: string, bindings: Record<string, string>): PVTrace {
  return { ...pvTrace(id, ''), kind: 'formula', expression, bindings };
}

describe('extractFormulaVars', () => {
  it('extracts unique variables in first-seen order', () => {
    expect(extractFormulaVars('{x1} + {x2} - {x1}')).toEqual(['x1', 'x2']);
  });

  it('ignores plain text and operators', () => {
    expect(extractFormulaVars('mean({a}) * 2 + ln({b})')).toEqual(['a', 'b']);
  });

  it('returns nothing for an expression with no variables', () => {
    expect(extractFormulaVars('1 + 2')).toEqual([]);
  });
});

describe('resolveBindings', () => {
  it('maps bound variables to their target PV names', () => {
    const a = pvTrace('t-a', 'PV:A');
    const b = pvTrace('t-b', 'PV:B');
    const f = formulaTrace('f-1', '{x1} + {x2}', { x1: 't-a', x2: 't-b' });
    expect(resolveBindings(f, [a, b])).toEqual({ x1: 'PV:A', x2: 'PV:B' });
  });

  it('omits unbound and formula-target bindings', () => {
    const a = pvTrace('t-a', 'PV:A');
    const otherFormula = formulaTrace('f-2', '{x1}', { x1: 't-a' });
    const f = formulaTrace('f-1', '{x1} + {x2}', { x1: 't-a', x2: 'f-2' });
    // x2 points at a formula trace -> skipped (formula refs deferred).
    expect(resolveBindings(f, [a, otherFormula])).toEqual({ x1: 'PV:A' });
  });
});

describe('resolveFormulaSpec', () => {
  const a = pvTrace('t-a', 'PV:A');
  const b = pvTrace('t-b', 'PV:B');

  it('builds a timeseries spec when every variable is bound to a PV', () => {
    const f = formulaTrace('f-1', '{x1} + {x2}', { x1: 't-a', x2: 't-b' });
    expect(resolveFormulaSpec(f, [a, b])).toEqual({
      kind: 'timeseries',
      expression: '{x1} + {x2}',
      bindings: { x1: 'PV:A', x2: 'PV:B' },
    });
  });

  it('returns null when a variable is unbound', () => {
    const f = formulaTrace('f-1', '{x1} + {x2}', { x1: 't-a' });
    expect(resolveFormulaSpec(f, [a, b])).toBeNull();
  });

  it('returns null for an empty expression or one with no variables', () => {
    expect(resolveFormulaSpec(formulaTrace('f', '   ', {}), [a])).toBeNull();
    expect(resolveFormulaSpec(formulaTrace('f', '1 + 2', {}), [a])).toBeNull();
  });
});
