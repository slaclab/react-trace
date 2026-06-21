// Shared filename helpers for the export paths (CSV, PNG image, …).

// Strip characters illegal in filenames on common OSes and collapse runs of
// whitespace to single dashes. Falls back to a stable default when the input
// sanitizes to nothing (e.g. a title that's all spaces).
export function safeFilename(s: string, fallback = 'plot'): string {
  return s.replace(/[/\\?%*:|"<>]/g, '_').replace(/\s+/g, '-') || fallback;
}

// Local-time stamp as YYYYMMDD_HHMMSS, mirroring the Python app's export naming
// ({username}_trace_YYYYMMDD_HHMMSS). Local rather than UTC so the stamp matches
// the wall clock the user sees. Accepts an explicit date for deterministic tests.
export function timestamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${date}_${time}`;
}
