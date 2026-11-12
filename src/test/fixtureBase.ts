// The base-field projection the wire-format v1 fixture tests compare through.
// The fixtures pin wire format v1 (`"format": 1`). `baseOf(actual, expected)`
// keeps only the keys the recorded value has, recursively, so a field added to
// a decoded object later passes: it allows additive fields only. A key the
// fixture has and the decode lost stays missing, and an array keeps its own
// length, so either still fails `toEqual(expected)`.
export function baseOf(actual: unknown, expected: unknown): unknown {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return actual;
    return actual.map((item, i) => (i < expected.length ? baseOf(item, expected[i]) : item));
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return actual;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(expected)) {
      if (Object.prototype.hasOwnProperty.call(actual, key))
        out[key] = baseOf(actual[key], expected[key]);
    }
    return out;
  }
  return actual;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
