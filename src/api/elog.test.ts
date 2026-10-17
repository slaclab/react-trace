import { describe, it, expect, vi, afterEach } from 'vitest';

import { listLogbooks, postEntry } from './elog';
import { CanopyError } from './client';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listLogbooks', () => {
  it('unwraps the payload envelope and maps id/name', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        payload: [
          { id: '1', name: 'OPS' },
          { id: '2', name: 'MCC' },
        ],
      })
    );
    const result = await listLogbooks();
    expect(result).toEqual([
      { id: '1', name: 'OPS' },
      { id: '2', name: 'MCC' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith('/elog/v1/logbooks', expect.anything());
  });

  it('handles a bare (un-enveloped) array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([{ id: '9', name: 'TEST' }]));
    expect(await listLogbooks()).toEqual([{ id: '9', name: 'TEST' }]);
  });

  it('throws a CanopyError on a non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ errorMessage: 'nope' }, false, 503)
    );
    await expect(listLogbooks()).rejects.toBeInstanceOf(CanopyError);
    await expect(listLogbooks()).rejects.toMatchObject({ status: 503, detail: 'nope' });
  });
});

describe('postEntry', () => {
  it('posts multipart with an entry JSON part and file parts', async () => {
    let captured: RequestInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      captured = init;
      return jsonResponse({ payload: 'entry-123' });
    });

    const png = new File([new Uint8Array([1, 2, 3])], 'trace_plot_1.png', { type: 'image/png' });
    const result = await postEntry({
      title: 'My entry',
      body: 'hello',
      logbooks: ['OPS', 'MCC'],
      files: [png],
    });

    expect(result).toEqual({ id: 'entry-123' });
    expect(captured?.method).toBe('POST');
    const form = captured?.body as FormData;
    expect(form).toBeInstanceOf(FormData);

    const entryPart = form.get('entry') as Blob;
    expect(entryPart).toBeInstanceOf(Blob);
    const entryJson = JSON.parse(await entryPart.text());
    expect(entryJson).toEqual({ logbooks: ['OPS', 'MCC'], title: 'My entry', text: 'hello' });

    const fileParts = form.getAll('files');
    expect(fileParts).toHaveLength(1);
    expect((fileParts[0] as File).name).toBe('trace_plot_1.png');
  });

  it('coerces the entry id to a string and tolerates no files', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ payload: 42 }));
    const result = await postEntry({ title: 't', body: '', logbooks: ['OPS'], files: [] });
    expect(result).toEqual({ id: '42' });
  });

  it('throws a CanopyError on upstream failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ errorMessage: 'bad logbook' }, false, 400)
    );
    await expect(
      postEntry({ title: 't', body: '', logbooks: ['NOPE'], files: [] })
    ).rejects.toMatchObject({ status: 400, detail: 'bad logbook' });
  });
});
