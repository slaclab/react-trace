import { CanopyError, canopyFetch } from '@slaclab/canopy-client';
import { canopyConnection } from './connection';

// ── E-Log DTOs ───────────────────────────────────────────────────────────────
// Source: canopy.elog (camelCase wire), mounted at /elog. Each client app has its
// own elog-plus application token server-side; Trace's app path is
// /elog/v1/apps/trace. Logbooks and tags are referenced by id.

export interface ElogConfigDTO {
  enabled: boolean;
  provider: string | null;
  defaultLogbookIds: string[];
  // Why posting is disabled (no provider configured, or no token for this app).
  reason: string | null;
}

export interface ElogLogbookDTO {
  id: string;
  name: string;
}

export interface ElogAttachmentDTO {
  id: string;
}

export interface ElogNewEntryDTO {
  logbookIds: string[];
  title: string;
  // Canopy renders Markdown to HTML before handing the entry to elog-plus.
  bodyMarkdown: string;
  tagIds?: string[];
  attachmentIds?: string[];
  additionalAuthors?: string[];
  important?: boolean;
  eventAt?: string | null;
  followsUpEntryId?: string | null;
}

export interface ElogEntryCreatedDTO {
  id: string;
  url: string | null;
}

// E-log posting goes through Canopy's shared e-log module, which holds Trace's
// elog-plus application token server-side. Requests use the same Canopy base path
// as Mole/Hare/Formula Engine; the proxy injects a dedicated e-log key (read+write@elog), so
// neither that key nor the elog-plus token reaches the browser bundle.
const APP_BASE = '/elog/v1/apps/trace';

export function getElogConfig(signal?: AbortSignal): Promise<ElogConfigDTO> {
  return canopyFetch<ElogConfigDTO>(canopyConnection, `${APP_BASE}/config`, { signal });
}

export function listLogbooks(signal?: AbortSignal): Promise<ElogLogbookDTO[]> {
  return canopyFetch<ElogLogbookDTO[]>(canopyConnection, `${APP_BASE}/logbooks`, { signal });
}

// Multipart upload of a single file (part name `file`). Returns the attachment
// id to reference from createEntry.
export async function uploadAttachment(file: File, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await canopyFetch<ElogAttachmentDTO>(canopyConnection, `${APP_BASE}/attachments`, {
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
  return canopyFetch<ElogEntryCreatedDTO>(canopyConnection, `${APP_BASE}/entries`, {
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
        if (err instanceof CanopyError && (err.status === 401 || err.status === 403)) throw err;
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
  if (!(err instanceof CanopyError)) {
    return err instanceof Error ? err.message : 'Unexpected error';
  }
  switch (err.code) {
    case 'network_error':
      return withDetail("Couldn't reach Canopy", err.detail);
    case 'invalid_api_key':
      return withDetail("Canopy rejected Trace's e-log API key", err.detail);
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
      return withDetail('The e-log service returned an error', err.detail);
    case 'elog_upstream_timeout':
      return 'The e-log service timed out. Try again.';
    case 'elog_not_supported':
      return "The e-log service doesn't support this operation.";
    case 'elog_attachment_too_large':
      return withDetail('The file is larger than the e-log attachment limit', err.detail);
  }
  if (err.status === 413) return 'The file is too large to upload.';
  if (err.status === 422) return withDetail('Canopy rejected the entry', err.detail);
  return withDetail(`E-log request failed (HTTP ${err.status})`, err.detail);
}
