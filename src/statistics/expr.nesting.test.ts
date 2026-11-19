import { describe, expect, it } from 'vitest';
import { compileExpression, type ExprLanguage } from './expr';

const LANG: ExprLanguage = { isVector: (name) => name === 'y' };

/** Input that overflows the stack in an unbounded parser. */
const DEEP = 20_000;

function expectCleanFailure(expr: string) {
  let r: ReturnType<typeof compileExpression> | undefined;
  expect(() => {
    r = compileExpression(expr, LANG);
  }).not.toThrow();
  expect(r?.ok).toBe(false);
  if (r !== undefined && !r.ok) expect(r.error).toMatch(/too deeply|too long/i);
}

describe('deeply nested input', () => {
  it('fails with an error for nested parentheses', () => {
    expectCleanFailure(`${'('.repeat(DEEP)}1${')'.repeat(DEEP)}`);
  });

  it('fails with an error for repeated unary minus', () => {
    expectCleanFailure(`${'-'.repeat(DEEP)}1`);
  });

  it('fails with an error for nested calls', () => {
    expectCleanFailure(`${'abs('.repeat(DEEP)}1${')'.repeat(DEEP)}`);
  });

  it('fails with an error for a long chain, which would overflow when evaluated', () => {
    expectCleanFailure(Array.from({ length: DEEP }, () => '1').join('+'));
  });

  it('still compiles and evaluates ordinary nesting', () => {
    const r = compileExpression(`${'('.repeat(30)}mean(y)${')'.repeat(30)} + abs(-abs(-2))`, LANG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.compiled.evaluate({ y: Float64Array.from([1, 3]) })).toBe(4);
  });

  it('evaluates the longest chain and deepest nesting it accepts without overflowing', () => {
    const chain = compileExpression(Array.from({ length: 499 }, () => '1').join('+'), LANG);
    expect(chain.ok).toBe(true);
    if (chain.ok) expect(chain.compiled.evaluate({})).toBe(499);
    const minus = compileExpression(`${'-'.repeat(99)}1`, LANG);
    expect(minus.ok).toBe(true);
    if (minus.ok) expect(minus.compiled.evaluate({})).toBe(-1);
    const parens = compileExpression(`${'('.repeat(49)}1${')'.repeat(49)}`, LANG);
    expect(parens.ok).toBe(true);
  });
});
