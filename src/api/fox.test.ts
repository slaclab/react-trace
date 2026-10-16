import { describe, expect, it } from 'vitest';
import { CanopyError, type FormulaSpec } from '@slaclab/canopy-client';
import { createFakeFetch, jsonResponse } from '@slaclab/canopy-client/testing';
import type { FakeRoutes } from '@slaclab/canopy-client/testing';
import { evaluateFormula, validateFormula } from './fox';

const SPEC: FormulaSpec = {
  kind: 'timeseries',
  expression: '{a} - {b}',
  bindings: { a: 'PV:A', b: 'PV:B' },
};

function connection(routes: FakeRoutes) {
  const fetch = createFakeFetch(routes, { baseUrl: '/trace/api/canopy' });
  return { conn: { baseUrl: '/trace/api/canopy', fetch }, fetch };
}

describe('validateFormula', () => {
  it('posts the spec to Fox and returns the validation result', async () => {
    const { conn, fetch } = connection({
      'POST /fox/v1/validate': jsonResponse({ valid: true, tokens: ['a', 'b'], errors: [] }),
    });

    await expect(validateFormula(conn, SPEC)).resolves.toEqual({
      valid: true,
      tokens: ['a', 'b'],
      errors: [],
    });
    expect(fetch.calls[0].url).toBe('/trace/api/canopy/fox/v1/validate');
    expect(fetch.calls[0].headers['Content-Type']).toBe('application/json');
    expect(fetch.calls[0].json).toEqual(SPEC);
  });

  it('reads a FastAPI 422 as a validation_error with a readable detail', async () => {
    const { conn } = connection({
      'POST /fox/v1/validate': jsonResponse(
        { detail: [{ loc: ['body', 'expression'], msg: 'Field required', type: 'missing' }] },
        { status: 422 }
      ),
    });

    const err = await validateFormula(conn, SPEC).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CanopyError);
    // Used to surface in the editor as "[object Object]".
    expect(err).toMatchObject({
      code: 'validation_error',
      detail: 'body.expression: Field required',
    });
  });
});

describe('evaluateFormula', () => {
  it('posts the spec with its window', async () => {
    const result = {
      kind: 'timeseries',
      scalar: null,
      waveform: null,
      timeseries: {
        tsNs: [1_000_000],
        values: [2],
        severity: ['NO_ALARM'],
        inputs: {},
        decimated: false,
      },
    };
    const { conn, fetch } = connection({ 'POST /fox/v1/evaluate': jsonResponse(result) });

    await expect(evaluateFormula(conn, SPEC, 10, 20)).resolves.toEqual(result);
    expect(fetch.calls[0].json).toEqual({ spec: SPEC, t0Ns: 10, t1Ns: 20 });
  });

  it('keeps the Canopy error envelope', async () => {
    const { conn } = connection({
      'POST /fox/v1/evaluate': jsonResponse(
        { code: 'formula_eval_failed', detail: 'division by zero' },
        { status: 400 }
      ),
    });
    await expect(evaluateFormula(conn, SPEC, 0, 0)).rejects.toMatchObject({
      code: 'formula_eval_failed',
      status: 400,
      detail: 'division by zero',
    });
  });
});
