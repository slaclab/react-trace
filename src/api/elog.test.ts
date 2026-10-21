import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  createEntry,
  describeElogError,
  ElogAttachmentError,
  getElogConfig,
  listLogbooks,
  postEntry,
  uploadAttachment,
} from './elog';
import { CanopyError } from './client';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as Response;
}

// A proxy-generated error page (e.g. nginx's own 413): not JSON at all.
function htmlResponse(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
  } as unknown as Response;
}

function png(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getElogConfig', () => {
  it("reads Trace's app config from Canopy", async () => {
    const config = {
      enabled: true,
      provider: 'elog_plus',
      defaultLogbookIds: ['lb-1'],
      reason: null,
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(config));
    expect(await getElogConfig()).toEqual(config);
    expect(fetchMock).toHaveBeenCalledWith(
      '/elog/v1/apps/trace/config',
      expect.objectContaining({ method: 'GET' })
    );
  });
});

describe('listLogbooks', () => {
  it('returns logbooks by id and name', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse([
        { id: 'lb-1', name: 'OPS' },
        { id: 'lb-2', name: 'MCC' },
      ])
    );
    expect(await listLogbooks()).toEqual([
      { id: 'lb-1', name: 'OPS' },
      { id: 'lb-2', name: 'MCC' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith('/elog/v1/apps/trace/logbooks', expect.anything());
  });

  it('throws a CanopyError carrying the envelope code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ code: 'elog_upstream_timeout', detail: 'timed out' }, false, 504)
    );
    await expect(listLogbooks()).rejects.toBeInstanceOf(CanopyError);
    await expect(listLogbooks()).rejects.toMatchObject({
      code: 'elog_upstream_timeout',
      status: 504,
      detail: 'timed out',
    });
  });
});

describe('uploadAttachment', () => {
  it('posts one multipart `file` part and lets the browser set the content type', async () => {
    let capturedUrl: unknown;
    let captured: RequestInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url;
      captured = init;
      return jsonResponse({ id: 'att-1' });
    });

    expect(await uploadAttachment(png('trace_plot_1.png'))).toBe('att-1');
    expect(capturedUrl).toBe('/elog/v1/apps/trace/attachments');
    expect(captured?.method).toBe('POST');
    const headers = captured?.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/json');
    // A manual Content-Type would drop the multipart boundary.
    expect(headers['Content-Type']).toBeUndefined();
    const form = captured?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect([...form.keys()]).toEqual(['file']);
    expect((form.get('file') as File).name).toBe('trace_plot_1.png');
  });
});

describe('createEntry', () => {
  it('posts the entry as JSON', async () => {
    let captured: RequestInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      captured = init;
      return jsonResponse({ id: 'entry-1', url: null });
    });
    const entry = { logbookIds: ['lb-1'], title: 't', bodyMarkdown: '**hi**' };
    expect(await createEntry(entry)).toEqual({ id: 'entry-1', url: null });
    expect((captured?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(captured?.body as string)).toEqual(entry);
  });
});

describe('postEntry', () => {
  it('uploads each file in order, then creates the entry with their attachment ids', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/attachments')) {
        const file = (init?.body as FormData).get('file') as File;
        return jsonResponse({ id: `att-${file.name}` });
      }
      return jsonResponse({ id: 'entry-123', url: 'https://elog.example/entries/entry-123' });
    });

    const config = new File(['{}'], 'trace_config.json', { type: 'application/json' });
    const result = await postEntry({
      title: 'My entry',
      bodyMarkdown: 'hello',
      logbookIds: ['lb-1', 'lb-2'],
      files: [png('trace_plot_1.png'), config],
    });

    expect(result).toEqual({ id: 'entry-123', url: 'https://elog.example/entries/entry-123' });
    expect(calls.map((c) => c.url)).toEqual([
      '/elog/v1/apps/trace/attachments',
      '/elog/v1/apps/trace/attachments',
      '/elog/v1/apps/trace/entries',
    ]);
    expect(JSON.parse(calls[2].init?.body as string)).toEqual({
      logbookIds: ['lb-1', 'lb-2'],
      title: 'My entry',
      bodyMarkdown: 'hello',
      attachmentIds: ['att-trace_plot_1.png', 'att-trace_config.json'],
    });
  });

  it('creates the entry without uploads when there are no files', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ id: 'entry-1', url: null }));
    await postEntry({ title: 't', bodyMarkdown: '', logbookIds: ['lb-1'], files: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/elog/v1/apps/trace/entries', expect.anything());
  });

  it('stops at a failed upload and names the file', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'att-1' }))
      .mockResolvedValueOnce(
        jsonResponse({ code: 'elog_attachment_too_large', detail: 'limit is 20 MiB' }, false, 413)
      );

    const err = await postEntry({
      title: 't',
      bodyMarkdown: '',
      logbookIds: ['lb-1'],
      files: [png('trace_plot_1.png'), png('trace_plot_2_big.png')],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ElogAttachmentError);
    expect((err as ElogAttachmentError).fileName).toBe('trace_plot_2_big.png');
    expect((err as ElogAttachmentError).cause).toMatchObject({
      code: 'elog_attachment_too_large',
      status: 413,
    });
    expect(describeElogError(err)).toBe(
      "Couldn't attach trace_plot_2_big.png. The file is larger than the e-log attachment limit: limit is 20 MiB"
    );
    // No entry is created after a failed upload.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("names the file when a proxy's non-JSON 413 rejects the upload", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse(413, 'Request Entity Too Large'));
    const err = await postEntry({
      title: 't',
      bodyMarkdown: '',
      logbookIds: ['lb-1'],
      files: [png('trace_plot_1.png')],
    }).catch((e: unknown) => e);
    expect((err as ElogAttachmentError).cause).toMatchObject({
      code: 'unknown_error',
      status: 413,
    });
    expect(describeElogError(err)).toBe(
      "Couldn't attach trace_plot_1.png. The file is too large to upload."
    );
  });

  it("joins FastAPI's 422 validation messages into the error detail", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        {
          detail: [
            { loc: ['body', 'title'], msg: 'String should have at most 255 characters' },
            { loc: ['body', 'logbookIds'], msg: 'List should have at least 1 item' },
          ],
        },
        false,
        422
      )
    );
    const err = await postEntry({
      title: 't',
      bodyMarkdown: '',
      logbookIds: [],
      files: [],
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'unknown_error',
      status: 422,
      detail: 'String should have at most 255 characters; List should have at least 1 item',
    });
    expect(describeElogError(err)).toBe(
      'Canopy rejected the entry: String should have at most 255 characters; List should have at least 1 item'
    );
  });
});

describe('describeElogError', () => {
  it.each([
    ['invalid_api_key', 401, "Canopy rejected Trace's API key."],
    [
      'insufficient_module_access',
      403,
      "Trace's Canopy API key is not scoped for the e-log module (it needs elog).",
    ],
    ['insufficient_read_access', 403, "Trace's Canopy API key lacks read access."],
    [
      'insufficient_write_access',
      403,
      "Trace's Canopy API key lacks write access, which posting requires.",
    ],
    ['invalid_app_name', 400, "Canopy rejected Trace's e-log app name."],
    ['elog_app_not_found', 404, 'E-log posting is not set up for Trace in Canopy.'],
    ['elog_not_configured', 503, 'No e-log service is configured in Canopy.'],
    ['elog_upstream_error', 502, 'The e-log service returned an error: boom'],
    ['elog_upstream_timeout', 504, 'The e-log service timed out. Try again.'],
    ['elog_not_supported', 501, "The e-log service doesn't support this operation."],
    ['elog_attachment_too_large', 413, 'The file is larger than the e-log attachment limit: boom'],
    ['network_error', 0, "Couldn't reach Canopy: boom"],
    ['unhandled_exception', 500, 'E-log request failed (HTTP 500): boom'],
  ])('maps %s (%i) to a readable message', (code, status, message) => {
    expect(describeElogError(new CanopyError(code, status, 'boom'))).toBe(message);
  });

  it('falls back to the message of other errors', () => {
    expect(describeElogError(new Error('nope'))).toBe('nope');
    expect(describeElogError('nope')).toBe('Unexpected error');
  });
});
