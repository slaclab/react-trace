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

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as Response;
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
  render(<PostToElogModal {...props} />);
  return props;
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
    // The stale default id that is not in the loaded list is dropped.
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
});
