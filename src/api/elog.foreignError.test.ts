// A second copy of @slaclab/canopy-client in the bundle brings its own
// CanopyError class. Its errors have the same shape but fail `instanceof`
// against this copy's class, so the e-log client reads them through errorInfo().
import { describe, expect, it, vi } from 'vitest';

import { canopyFetch } from './client';
import { describeElogError, ElogAttachmentError, postEntry } from './elog';

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  canopyFetch: vi.fn(),
}));

// What a duplicate canopy-client would throw: same fields, different class.
function foreignCanopyError(code: string, status: number, detail: string): Error {
  return Object.assign(new Error(`${code} (${status}): ${detail}`), {
    name: 'CanopyError',
    code,
    status,
    detail,
  });
}

describe("e-log errors from another copy of the SDK's CanopyError", () => {
  it('reports a 401 on the first upload as the key error, not the file', async () => {
    const keyError = foreignCanopyError('invalid_api_key', 401, 'boom');
    vi.mocked(canopyFetch).mockRejectedValueOnce(keyError);
    const err = await postEntry({
      title: 't',
      bodyMarkdown: '',
      logbookIds: ['lb-1'],
      files: [new File([new Uint8Array([1])], 'trace_plot_1.png', { type: 'image/png' })],
    }).catch((e: unknown) => e);
    expect(err).toBe(keyError);
    expect(err).not.toBeInstanceOf(ElogAttachmentError);
  });

  it.each([
    ['invalid_api_key', 401, "Canopy rejected Trace's e-log API key: boom"],
    ['elog_app_not_found', 404, 'E-log posting is not set up for Trace in Canopy.'],
    ['unknown_error', 502, 'E-log request failed (HTTP 502)'],
  ])('maps %s (%i) like one from this copy', (code, status, message) => {
    expect(describeElogError(foreignCanopyError(code, status, 'boom'))).toBe(message);
  });
});
