import { describe, it, expect } from 'vitest';
import { TESTIDS } from './testids';

// These names are a contract with the sdk-js probe rows and every e2e. If this
// test fails, a rename is about to break the host probes: change them in the
// same release, never here alone.
describe('workbench chrome testids', () => {
  it('pins the exact set of fixed chrome hooks', () => {
    expect(TESTIDS).toEqual({
      outlineAddInput: 'outline-add-input',
      outlineAddStatus: 'outline-add-status',
      outlineAddRefusal: 'outline-add-refusal',
      actionsBar: 'actions-bar',
    });
  });

  it('declares every hook once, with no duplicate values', () => {
    const values = Object.values(TESTIDS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('is frozen so no caller can rename a hook at runtime', () => {
    expect(Object.isFrozen(TESTIDS)).toBe(true);
  });
});
