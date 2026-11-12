import { describe, expect, it } from 'vitest';
import { CanopyError } from '@slaclab/canopy-client';
import { archiveErrorInfo } from '../state/archiveStore';
import { formulaErrorInfo } from '../state/formulaStore';
import { UNKNOWN_ERROR_CODE, errorInfo } from './errorInfo';

// What a second copy of canopy-client in the bundle would throw: the same
// shape as CanopyError, from a different class.
class OtherCopyCanopyError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string;

  constructor(code: string, status: number, detail: string) {
    super(`${code} (${status}): ${detail}`);
    this.name = 'CanopyError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

describe('errorInfo', () => {
  it("reads a CanopyError's code, detail and status", () => {
    expect(errorInfo(new CanopyError('archiver_unavailable', 503, 'Appliance down'))).toEqual({
      code: 'archiver_unavailable',
      detail: 'Appliance down',
      status: 503,
    });
  });

  it('reads the same shape from another copy of the CanopyError class', () => {
    const err = new OtherCopyCanopyError('pv_not_buffered', 404, 'not buffered');
    expect(err).not.toBeInstanceOf(CanopyError);
    expect(errorInfo(err)).toEqual({
      code: 'pv_not_buffered',
      detail: 'not buffered',
      status: 404,
    });
  });

  it('keeps a code without a string detail, falling back to the message', () => {
    const err = Object.assign(new Error('socket closed'), { code: 'network_error', detail: 42 });
    expect(errorInfo(err)).toEqual({ code: 'network_error', detail: 'socket closed' });
  });

  it('leaves out a status that is not a number', () => {
    const err = { code: 'archiver_unavailable', detail: 'down', status: '503' };
    expect(errorInfo(err).status).toBeUndefined();
  });

  it('reports an error without a string code as unknown_error with its message', () => {
    expect(errorInfo(new TypeError('Failed to fetch'))).toEqual({
      code: UNKNOWN_ERROR_CODE,
      detail: 'Failed to fetch',
    });
    expect(errorInfo(Object.assign(new Error('boom'), { code: 500 }))).toEqual({
      code: UNKNOWN_ERROR_CODE,
      detail: 'boom',
    });
  });

  it('turns a thrown non-error into its string form', () => {
    expect(errorInfo('plain string')).toEqual({ code: UNKNOWN_ERROR_CODE, detail: 'plain string' });
    expect(errorInfo(null)).toEqual({ code: UNKNOWN_ERROR_CODE, detail: 'null' });
    expect(errorInfo(undefined)).toEqual({ code: UNKNOWN_ERROR_CODE, detail: 'undefined' });
  });

  it('is what the archive and formula stores read failures with', () => {
    expect(archiveErrorInfo).toBe(errorInfo);
    expect(formulaErrorInfo).toBe(errorInfo);
  });
});
