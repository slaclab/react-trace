// VITE_CANOPY_BASE_PATH as both the bundle (connection.ts) and the Vite dev
// proxy (vite.config.ts) read it: trimmed, without trailing slashes. '' (unset,
// empty or '/') means the per-module paths. This file has no imports and doesn't
// read import.meta.env, so vite.config.ts can load it too.
export function normalizeBasePath(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/\/+$/, '');
}
