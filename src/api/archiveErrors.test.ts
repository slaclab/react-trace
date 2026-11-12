import { describe, expect, it } from 'vitest';
import { NOT_ARCHIVED_CODES, archiveErrorNotice } from './archiveErrors';

// The one table of archive error codes that mean "the archiver does not hold
// this PV", and the text every consumer shows for each.
describe('archiveErrorNotice', () => {
  it.each([
    ['pv_not_found', 'Not archived'],
    ['pv_not_found_in_archiver', 'Not archived'],
    ['archiver_not_configured', 'No archiver'],
  ])('reads %s as not archived, saying %j', (code, text) => {
    expect(NOT_ARCHIVED_CODES.has(code)).toBe(true);
    expect(archiveErrorNotice(code)).toBe(text);
  });

  it.each(['archiver_unavailable', 'archiver_timeout', 'network_error', 'timeout', '', 'toString'])(
    'has no notice for %j',
    (code) => {
      expect(archiveErrorNotice(code)).toBeUndefined();
    }
  );

  it('has no notice for a missing code', () => {
    expect(archiveErrorNotice(undefined)).toBeUndefined();
  });
});
