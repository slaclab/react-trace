// Workbench chrome hooks, declared once.
//
// The sdk-js probe rows and every e2e select workbench chrome by these exact
// `data-testid` values, so they are a cross-repo contract: `testids.test.ts`
// pins the set so a rename fails here before it fails in the host probes.
//
// Data-testids are chrome hooks; `#id`s are field hooks — never both on one
// control.

export const TESTIDS = Object.freeze({
  /** The PV input of a section's add row. */
  outlineAddInput: 'outline-add-input',
  /** The add row's pending status ("checking…"). */
  outlineAddStatus: 'outline-add-status',
  /** The add row's refusal message (with its optional action). */
  outlineAddRefusal: 'outline-add-refusal',
  /** The tool's actions bar. */
  actionsBar: 'actions-bar',
} as const);

export type TestId = (typeof TESTIDS)[keyof typeof TESTIDS];
