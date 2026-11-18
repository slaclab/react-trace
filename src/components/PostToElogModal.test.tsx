// @vitest-environment jsdom
//
// Drives the post dialog against a fetch mocked at the HTTP boundary: logbooks
// load by id on open, configured defaults are preselected, files upload to
// /attachments before the entry is created, and failures read as messages.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PostToElogModal } from './PostToElogModal';

// Carbon's TextArea and multiselect observe their size; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// A real Response: the SDK's canopyFetch reads the body as text.
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), { status, statusText: ok ? 'OK' : 'Error' });
}

const LOGBOOKS = [
  { id: 'lb-1', name: 'OPS' },
  { id: 'lb-2', name: 'MCC' },
];

function renderModal(overrides: Partial<Parameters<typeof PostToElogModal>[0]> = {}) {
  const props = {
    open: true,
    captured: [],
    defaultLogbookIds: ['lb-2', 'lb-gone'],
    buildConfigFile: () => new File(['{}'], 'trace_config.json', { type: 'application/json' }),
    onClose: vi.fn(),
    onPosted: vi.fn(),
    onPostFailed: vi.fn(),
    ...overrides,
  };
  const { rerender } = render(<PostToElogModal {...props} />);
  return {
    ...props,
    rerender: (next: Partial<Parameters<typeof PostToElogModal>[0]>) =>
      rerender(<PostToElogModal {...props} {...next} />),
  };
}

async function uploadedBytes(call: { init?: RequestInit }): Promise<number[]> {
  const file = (call.init?.body as FormData).get('file') as File;
  return [...new Uint8Array(await file.arrayBuffer())];
}

function postButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Post' });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PostToElogModal', () => {
  it('posts to the preselected logbooks with uploaded attachment ids', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/logbooks')) return jsonResponse(LOGBOOKS);
      if (String(url).endsWith('/attachments')) return jsonResponse({ id: 'att-1' });
      return jsonResponse({ id: 'entry-1', url: 'https://elog.example/entries/entry-1' });
    });
    const props = renderModal();

    await waitFor(() => expect(calls.map((c) => c.url)).toContain('/elog/v1/apps/trace/logbooks'));
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: '  Beam lost  ' } });
    fireEvent.change(screen.getByLabelText('Body (Markdown)'), {
      target: { value: 'See **plot**' },
    });
    fireEvent.click(screen.getByLabelText(/Attach current configuration/));
    await waitFor(() => expect(postButton().disabled).toBe(false));
    fireEvent.click(postButton());

    await waitFor(() =>
      expect(props.onPosted).toHaveBeenCalledWith({
        id: 'entry-1',
        url: 'https://elog.example/entries/entry-1',
      })
    );
    expect(props.onClose).toHaveBeenCalled();
    expect(calls.map((c) => c.url)).toEqual([
      '/elog/v1/apps/trace/logbooks',
      '/elog/v1/apps/trace/attachments',
      '/elog/v1/apps/trace/entries',
    ]);
    const file = (calls[1].init?.body as FormData).get('file') as File;
    expect(file.name).toBe('trace_config.json');
    // A default id that isn't in the loaded list (gone, or one Trace can't post
    // to) is dropped.
    expect(JSON.parse(calls[2].init?.body as string)).toEqual({
      logbookIds: ['lb-2'],
      title: 'Beam lost',
      bodyMarkdown: 'See **plot**',
      attachmentIds: ['att-1'],
    });
  });

  it('shows why logbooks could not load and keeps Post disabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ code: 'insufficient_module_access', detail: 'elog' }, false, 403)
    );
    renderModal();

    await screen.findByText("Couldn't load logbooks");
    screen.getByText("Trace's e-log API key is not scoped for the e-log module (it needs elog).");
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Beam lost' } });
    expect(postButton().disabled).toBe(true);
  });

  it('says so when there is no logbook Trace can post to', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));
    renderModal();

    await screen.findByText('No logbooks available');
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Beam lost' } });
    expect(postButton().disabled).toBe(true);
    expect(screen.queryByText('At least one logbook is required')).toBeNull();
  });

  it('reports a failed post as a readable message', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/logbooks')) return jsonResponse(LOGBOOKS);
      return jsonResponse({ code: 'elog_upstream_timeout', detail: 'timed out' }, false, 504);
    });
    const props = renderModal();

    await waitFor(() => expect(postButton().disabled).toBe(true));
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Beam lost' } });
    await waitFor(() => expect(postButton().disabled).toBe(false));
    fireEvent.click(postButton());

    await screen.findByText('The e-log service timed out. Try again.');
    expect(props.onPostFailed).toHaveBeenCalledWith('The e-log service timed out. Try again.');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('reuses the uploaded attachments when a failed post is retried', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let uploads = 0;
    let entries = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/logbooks')) return jsonResponse(LOGBOOKS);
      if (String(url).endsWith('/attachments')) return jsonResponse({ id: `att-${++uploads}` });
      if (++entries === 1) {
        return jsonResponse({ code: 'elog_upstream_timeout', detail: 'timed out' }, false, 504);
      }
      return jsonResponse({ id: 'entry-1', url: null });
    });
    const props = renderModal({
      captured: [{ id: 'p1', title: 'Plot 1', dataUrl: 'data:image/png;base64,AQID' }],
    });

    await waitFor(() => expect(calls.map((c) => c.url)).toContain('/elog/v1/apps/trace/logbooks'));
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Beam lost' } });
    fireEvent.click(screen.getByLabelText(/Attach current configuration/));
    await waitFor(() => expect(postButton().disabled).toBe(false));
    fireEvent.click(postButton());
    await screen.findByText('The e-log service timed out. Try again.');

    await waitFor(() => expect(postButton().disabled).toBe(false));
    fireEvent.click(postButton());
    await waitFor(() => expect(props.onPosted).toHaveBeenCalledWith({ id: 'entry-1', url: null }));

    const entryBodies = calls
      .filter((c) => c.url.endsWith('/entries'))
      .map((c) => JSON.parse(c.init?.body as string).attachmentIds);
    expect(uploads).toBe(2);
    expect(entryBodies).toEqual([
      ['att-1', 'att-2'],
      ['att-1', 'att-2'],
    ]);
  });

  // Ctrl/Cmd+E while the dialog is open re-captures the plots without closing it.
  describe('when the plots are re-captured after a failed post', () => {
    function failFirstEntry() {
      const calls: { url: string; init?: RequestInit }[] = [];
      let uploads = 0;
      let entries = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith('/logbooks')) return jsonResponse(LOGBOOKS);
        if (String(url).endsWith('/attachments')) return jsonResponse({ id: `att-${++uploads}` });
        if (++entries === 1) {
          return jsonResponse({ code: 'elog_upstream_timeout', detail: 'timed out' }, false, 504);
        }
        return jsonResponse({ id: 'entry-1', url: null });
      });
      return {
        calls,
        uploadCalls: () => calls.filter((c) => c.url.endsWith('/attachments')),
        entryAttachmentIds: () =>
          calls
            .filter((c) => c.url.endsWith('/entries'))
            .map((c) => JSON.parse(c.init?.body as string).attachmentIds),
      };
    }

    async function postAndFail() {
      fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Beam lost' } });
      await waitFor(() => expect(postButton().disabled).toBe(false));
      fireEvent.click(postButton());
      await screen.findByText('The e-log service timed out. Try again.');
      await waitFor(() => expect(postButton().disabled).toBe(false));
    }

    it('uploads the new image on retry', async () => {
      const http = failFirstEntry();
      const modal = renderModal({
        captured: [{ id: 'p1', title: 'Plot 1', dataUrl: 'data:image/png;base64,AQID' }],
      });
      await waitFor(() =>
        expect(http.calls.map((c) => c.url)).toContain('/elog/v1/apps/trace/logbooks')
      );
      await postAndFail();

      const recaptured = 'data:image/png;base64,BAUG';
      modal.rerender({ captured: [{ id: 'p1', title: 'Plot 1', dataUrl: recaptured }] });
      expect(screen.getByAltText('Preview of Plot 1').getAttribute('src')).toBe(recaptured);
      fireEvent.click(postButton());
      await waitFor(() =>
        expect(modal.onPosted).toHaveBeenCalledWith({ id: 'entry-1', url: null })
      );

      expect(http.uploadCalls()).toHaveLength(2);
      const [first, second] = http.uploadCalls();
      expect(await uploadedBytes(first)).toEqual([1, 2, 3]);
      expect(await uploadedBytes(second)).toEqual([4, 5, 6]);
      expect(http.entryAttachmentIds()).toEqual([['att-1'], ['att-2']]);
    });

    it('reuses the upload when the image is unchanged', async () => {
      const http = failFirstEntry();
      const dataUrl = 'data:image/png;base64,AQID';
      const modal = renderModal({ captured: [{ id: 'p1', title: 'Plot 1', dataUrl }] });
      await waitFor(() =>
        expect(http.calls.map((c) => c.url)).toContain('/elog/v1/apps/trace/logbooks')
      );
      await postAndFail();

      // A new capture object with the same image and title.
      modal.rerender({ captured: [{ id: 'p1', title: 'Plot 1', dataUrl }] });
      fireEvent.click(postButton());
      await waitFor(() =>
        expect(modal.onPosted).toHaveBeenCalledWith({ id: 'entry-1', url: null })
      );

      expect(http.uploadCalls()).toHaveLength(1);
      expect(http.entryAttachmentIds()).toEqual([['att-1'], ['att-1']]);
    });
  });
});
