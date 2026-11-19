import { describe, expect, it } from 'vitest';
import {
  NOT_ARCHIVED_CODES,
  archiveErrorLabel,
  archiveErrorNotice,
  archiveRetry,
} from './archiveErrors';

// The one table of archive error codes: which mean "the archiver does not
// hold this PV" and the text every consumer shows for each, the short names
// the Signals rows and Archive status show, and how the archive store asks
// again.
describe('archiveErrorNotice', () => {
  it.each([
    ['pv_not_found_in_archiver', 'Not archived'],
    ['archiver_not_configured', 'No archiver'],
  ])('reads %s as not archived, saying %j', (code, text) => {
    expect(NOT_ARCHIVED_CODES.has(code)).toBe(true);
    expect(archiveErrorNotice(code)).toBe(text);
  });

  it.each([
    'pv_not_found',
    'archiver_unavailable',
    'archiver_timeout',
    'network_error',
    'timeout',
    '',
    'toString',
  ])('has no notice for %j', (code) => {
    expect(NOT_ARCHIVED_CODES.has(code)).toBe(false);
    expect(archiveErrorNotice(code)).toBeUndefined();
  });

  it('has no notice for a missing code', () => {
    expect(archiveErrorNotice(undefined)).toBeUndefined();
  });
});

describe('archiveErrorLabel', () => {
  it.each([
    ['archiver_unavailable', 'Archiver down'],
    ['archiver_timeout', 'Timeout'],
    ['archiver_bad_response', 'Bad response'],
    ['archiver_not_configured', 'No archiver'],
    ['pv_not_found_in_archiver', 'Not archived'],
    ['invalid_api_key', 'Auth error'],
    ['insufficient_read_access', 'Auth error'],
    ['network_error', 'Offline'],
  ])('calls %s %j', (code, label) => {
    expect(archiveErrorLabel(code)).toBe(label);
  });

  it.each(['pv_not_found', 'timeout', 'HTTP_500', '', 'toString', undefined])(
    'has no label for %j',
    (code) => {
      expect(archiveErrorLabel(code)).toBeUndefined();
    }
  );
});

describe('archiveRetry', () => {
  it('never asks again for archiver_not_configured', () => {
    expect(archiveRetry('archiver_not_configured')).toBe('never');
  });

  it('asks again for pv_not_found_in_archiver only on a change', () => {
    expect(archiveRetry('pv_not_found_in_archiver')).toBe('onChange');
  });

  it.each([
    'pv_not_found',
    'archiver_unavailable',
    'archiver_timeout',
    'archiver_bad_response',
    'invalid_api_key',
    'network_error',
    'unknown_error',
    'toString',
    undefined,
  ])('retries %j on the backoff schedule', (code) => {
    expect(archiveRetry(code)).toBe('backoff');
  });

  it('remembers exactly the codes it does not back off on', () => {
    for (const code of NOT_ARCHIVED_CODES) expect(archiveRetry(code)).not.toBe('backoff');
    expect([...NOT_ARCHIVED_CODES].sort()).toEqual([
      'archiver_not_configured',
      'pv_not_found_in_archiver',
    ]);
  });
});
