// What the app keeps of a failure: the Canopy error code, a detail to show,
// and the HTTP status when the error carries one (the formula store needs it to
// tell a terminal failure from a transient one).
export interface ErrorInfo {
  code: string;
  detail: string;
  status?: number;
}

// The code for anything that doesn't carry its own.
export const UNKNOWN_ERROR_CODE = 'unknown_error';

/**
 * Read `{ code, detail, status }` from anything a request threw. Duck-typed on
 * the `CanopyError` shape rather than `instanceof CanopyError`: a second copy of
 * `@slaclab/canopy-client` in the bundle brings its own CanopyError class, and
 * its errors would fail that check.
 *
 * A string `code` is kept, with `detail` falling back to the error's message
 * when it isn't a string. Anything without one is `unknown_error`, with the
 * message (or the thrown value as a string) as its detail.
 */
export function errorInfo(err: unknown): ErrorInfo {
  const e = err as { code?: unknown; detail?: unknown; status?: unknown; message?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  if (typeof e?.code === 'string') {
    return {
      code: e.code,
      detail: typeof e.detail === 'string' ? e.detail : message,
      status: typeof e.status === 'number' ? e.status : undefined,
    };
  }
  return { code: UNKNOWN_ERROR_CODE, detail: message };
}
