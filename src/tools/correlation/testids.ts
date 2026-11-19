// Correlation's own test hooks. The sdk-js probe rows and the e2e specs select
// these exact `data-testid` values, so they are a cross-repo contract, like the
// workbench's chrome hooks (src/workbench/testids.ts).

export const CORRELATION_TESTIDS = Object.freeze({
  /**
   * The Trigger's Source control: the Trigger section's inline header field,
   * the one place the Source shows. A header field's id is its `data-testid`.
   */
  triggerSource: 'trigger-source',
} as const);
