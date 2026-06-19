import { CanopyError } from './client';

// The dev server proxies /elog/* to an elog-plus instance, stripping the /elog
// prefix and injecting the access token (see vite.config.ts). The browser never
// holds the token. In prod a reverse proxy owns the same responsibility.
const BASE = '/elog';

export interface ElogLogbook {
  id: string;
  name: string;
}

export interface PostEntryParams {
  title: string;
  body: string;
  logbooks: string[]; // logbook names (elog-plus v2 NewEntryDTO takes names)
  files: File[];
}

export interface PostEntryResult {
  id: string;
}

// elog-plus wraps successful bodies in an ApiResultResponse envelope:
// { errorCode, payload, ... }. Strip it when present.
function unwrap<T>(body: unknown): T {
  if (body && typeof body === 'object' && 'payload' in body) {
    return (body as { payload: T }).payload;
  }
  return body as T;
}

async function readError(res: Response): Promise<CanopyError> {
  let detail = res.statusText;
  try {
    const body = (await res.json()) as { errorMessage?: string; detail?: string };
    detail = body.errorMessage ?? body.detail ?? detail;
  } catch {
    // non-JSON error body; keep statusText
  }
  return new CanopyError('elog_error', res.status, detail);
}

export async function listLogbooks(signal?: AbortSignal): Promise<ElogLogbook[]> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/v1/logbooks`, {
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw err;
    throw new CanopyError('network_error', 0, (err as Error).message ?? 'network failure');
  }
  if (!res.ok) throw await readError(res);
  const items = unwrap<Array<{ id: string; name: string }>>(await res.json()) ?? [];
  return items.map((it) => ({ id: it.id, name: it.name }));
}

// POST /v2/entries is multipart/form-data: an `entry` JSON part (NewEntryDTO)
// plus optional `files` parts. Mirrors the Python trace elog_client.post_entry.
export async function postEntry(
  params: PostEntryParams,
  signal?: AbortSignal
): Promise<PostEntryResult> {
  const entry = {
    logbooks: params.logbooks,
    title: params.title,
    text: params.body,
  };
  const form = new FormData();
  form.append(
    'entry',
    new Blob([JSON.stringify(entry)], { type: 'application/json' }),
    'entry.json'
  );
  for (const file of params.files) {
    form.append('files', file, file.name);
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}/v2/entries`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: form,
      signal,
    });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw err;
    throw new CanopyError('network_error', 0, (err as Error).message ?? 'network failure');
  }
  if (!res.ok) throw await readError(res);
  const id = unwrap<string>(await res.json());
  return { id: String(id ?? '') };
}
