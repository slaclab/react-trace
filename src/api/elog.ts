import { canopyFetch } from './client';
import { errorInfo, UNKNOWN_ERROR_CODE } from './errorInfo';
import type {
  ElogAttachmentDTO,
  ElogConfigDTO,
  ElogEntryCreatedDTO,
  ElogLogbookDTO,
  ElogNewEntryDTO,
} from './types';

// E-log posting goes through Canopy's shared e-log module, which holds Trace's
// elog-plus application token server-side. Requests use the same Canopy base path
// as Mole/Hare/the Formula Engine; the proxy injects a dedicated e-log key (read+write@elog), so
// neither that key nor the elog-plus token reaches the browser bundle.
const APP_BASE = '/elog/v1/apps/trace';

export function getElogConfig(signal?: AbortSignal): Promise<ElogConfigDTO> {
  return canopyFetch<ElogConfigDTO>(`${APP_BASE}/config`, { signal });
}

export function listLogbooks(signal?: AbortSignal): Promise<ElogLogbookDTO[]> {
  return canopyFetch<ElogLogbookDTO[]>(`${APP_BASE}/logbooks`, { signal });
}

// Multipart upload of a single file (part name `file`). Returns the attachment
// id to reference from createEntry.
export async function uploadAttachment(file: File, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await canopyFetch<ElogAttachmentDTO>(`${APP_BASE}/attachments`, {
    method: 'POST',
    body: form,
    signal,
  });
  return res.id;
}

export function createEntry(
  entry: ElogNewEntryDTO,
  signal?: AbortSignal
): Promise<ElogEntryCreatedDTO> {
  return canopyFetch<ElogEntryCreatedDTO>(`${APP_BASE}/entries`, {
    method: 'POST',
    body: entry,
    signal,
  });
}

export interface PostEntryParams {
  title: string;
  bodyMarkdown: string;
  logbookIds: string[];
  files: File[];
  // Attachment ids already uploaded for these File objects. postEntry skips the
  // files in it and adds each one it uploads, so a retry after a failed post
  // reuses them instead of uploading again (elog-plus only drops unreferenced
  // attachments after two days).
  uploaded?: Map<File, string>;
}

// Raised when uploading one of the entry's files fails, so the message can name
// the file to drop (e.g. one over the attachment size limit).
export class ElogAttachmentError extends Error {
  readonly fileName: string;

  constructor(fileName: string, cause: unknown) {
    super(`Couldn't attach ${fileName}`, { cause });
    this.name = 'ElogAttachmentError';
    this.fileName = fileName;
  }
}

// Uploads each file, then creates the entry referencing the attachment ids.
// Uploads run one at a time so a failure is tied to the file that caused it.
export async function postEntry(
  params: PostEntryParams,
  signal?: AbortSignal
): Promise<ElogEntryCreatedDTO> {
  const uploaded = params.uploaded ?? new Map<File, string>();
  const attachmentIds: string[] = [];
  for (const file of params.files) {
    let id = uploaded.get(file);
    if (id === undefined) {
      try {
        id = await uploadAttachment(file, signal);
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') throw err;
        // A bad key or missing write access fails on the first upload. Report it
        // as the key error, not as a problem with this file.
        const { status } = errorInfo(err);
        if (status === 401 || status === 403) throw err;
        throw new ElogAttachmentError(file.name, err);
      }
      uploaded.set(file, id);
    }
    attachmentIds.push(id);
  }
  return createEntry(
    {
      logbookIds: params.logbookIds,
      title: params.title,
      bodyMarkdown: params.bodyMarkdown,
      attachmentIds,
    },
    signal
  );
}

function withDetail(message: string, detail: string): string {
  return detail ? `${message}: ${detail}` : message;
}

// Turn a failed e-log call into a message for the dialog/toast. Codes are the
// canopy.elog contract plus Canopy's standard auth errors; non-Canopy bodies
// (e.g. an HTML 413 from a proxy, FastAPI's 422) fall back on the status.
export function describeElogError(err: unknown): string {
  if (err instanceof ElogAttachmentError) {
    return `${err.message}. ${describeElogError(err.cause)}`;
  }
  // errorInfo() reads a CanopyError from any copy of canopy-client. Anything
  // else has no status.
  const info = errorInfo(err);
  if (info.status === undefined) {
    return err instanceof Error ? err.message : 'Unexpected error';
  }
  switch (info.code) {
    case 'network_error':
      return withDetail("Couldn't reach Canopy", info.detail);
    case 'invalid_api_key':
      return withDetail("Canopy rejected Trace's e-log API key", info.detail);
    case 'insufficient_module_access':
      return "Trace's e-log API key is not scoped for the e-log module (it needs elog).";
    case 'insufficient_read_access':
      return "Trace's e-log API key lacks read access.";
    case 'insufficient_write_access':
      return "Trace's e-log API key lacks write access, which posting requires.";
    case 'invalid_app_name':
      return "Canopy rejected Trace's e-log app name.";
    case 'elog_app_not_found':
      return 'E-log posting is not set up for Trace in Canopy.';
    case 'elog_not_configured':
      return 'No e-log service is configured in Canopy.';
    case 'elog_upstream_error':
      return withDetail('The e-log service returned an error', info.detail);
    case 'elog_upstream_timeout':
      return 'The e-log service timed out. Try again.';
    case 'elog_not_supported':
      return "The e-log service doesn't support this operation.";
    case 'elog_attachment_too_large':
      return withDetail('The file is larger than the e-log attachment limit', info.detail);
  }
  if (info.status === 413) return 'The file is too large to upload.';
  // unknown_error: the body wasn't Canopy's JSON (e.g. a proxy's HTML error
  // page), and the SDK puts its raw text in `detail`. Not worth showing.
  const detail = info.code === UNKNOWN_ERROR_CODE ? '' : info.detail;
  if (info.status === 422) return withDetail('Canopy rejected the entry', detail);
  return withDetail(`E-log request failed (HTTP ${info.status})`, detail);
}
