// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { CanopyProvider, useCanopyConnection } from '@slaclab/canopy-react';
import { canopyConnection } from './connection';

describe('canopyConnection', () => {
  // usePVSearch, useFormulaSeries and ArchiverPicker key effects and memos on the
  // connection, so the provider (wired as in main.tsx) must hand hooks this same
  // object on every render. A copy per render would read as a new Canopy each
  // time and refetch.
  it('reaches hooks as the same object on every render', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <CanopyProvider connection={canopyConnection}>{children}</CanopyProvider>
    );
    const { result, rerender } = renderHook(() => useCanopyConnection(), { wrapper });
    expect(result.current).toBe(canopyConnection);
    rerender();
    expect(result.current).toBe(canopyConnection);
  });
});
