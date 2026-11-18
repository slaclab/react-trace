import { canopyFetch } from './client';
import type { ConfigDTO, PagedResult } from './types';

// The magpie config store is app-scoped: every path carries the consuming app,
// and magpie 404s a slug that belongs to another app. Hardcoding "trace" here is
// that handshake — trace can only ever read/write trace configs.
const APP = 'trace';
const BASE = `/magpie/v1/configs/${APP}`;

export interface SaveConfigMeta {
  name?: string;
  description?: string;
  createdBy?: string;
}

export interface ListConfigsOptions {
  search?: string;
  pageSize?: number;
  continuationToken?: string;
}

/** Create a new config holding `data` (a serialized workspace). Returns the row incl. its slug. */
export async function saveConfig(data: unknown, meta: SaveConfigMeta = {}): Promise<ConfigDTO> {
  return canopyFetch<ConfigDTO>(BASE, {
    method: 'POST',
    body: { name: meta.name, description: meta.description, createdBy: meta.createdBy, data },
  });
}

/** Resolve a config by slug (the shareable-link endpoint). Throws CanopyError('config_not_found') on 404. */
export async function getConfig(slug: string, signal?: AbortSignal): Promise<ConfigDTO> {
  return canopyFetch<ConfigDTO>(`${BASE}/${encodeURIComponent(slug)}`, { signal });
}

/** List this app's saved configs (keyset-paginated). */
export async function listConfigs(
  options: ListConfigsOptions = {},
  signal?: AbortSignal
): Promise<PagedResult<ConfigDTO>> {
  return canopyFetch<PagedResult<ConfigDTO>>(BASE, {
    query: {
      search: options.search,
      pageSize: options.pageSize,
      continuationToken: options.continuationToken,
    },
    signal,
  });
}

/** Update a config's name/description and/or data. */
export async function updateConfig(
  slug: string,
  patch: { name?: string; description?: string; data?: unknown }
): Promise<ConfigDTO> {
  return canopyFetch<ConfigDTO>(`${BASE}/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    body: patch,
  });
}

/** Delete a config. Magpie returns a bare `true` on success. */
export async function deleteConfig(slug: string): Promise<void> {
  await canopyFetch<boolean>(`${BASE}/${encodeURIComponent(slug)}`, { method: 'DELETE' });
}
