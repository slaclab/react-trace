// Record edits shared by the context tools' state writers (Correlation,
// Waveform): per-PV records (labels, colours, markers) are replaced, never
// mutated, and a value given as undefined removes its key.

/** `record` with `pv` set to `value`, or removed when `value` is undefined. */
export function withRecord<T>(
  record: Record<string, T>,
  pv: string,
  value: T | undefined
): Record<string, T> {
  const next = { ...record };
  if (value === undefined) delete next[pv];
  else next[pv] = value;
  return next;
}

/** `base` with `patch` merged in; a key given as undefined is removed. */
export function patchFields<T extends object>(base: T | undefined, patch: T): T {
  const next: T = { ...(base ?? ({} as T)) };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    if (patch[key] === undefined) delete next[key];
    else next[key] = patch[key];
  }
  return next;
}
