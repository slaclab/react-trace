// @vitest-environment jsdom
//
// A `.trc.json` with `plots: []`, imported from a file, is refused: the open
// workspace stays as it was and the import reports the reason. On the stack
// before main's catch-up the same file crashed the app (`activePlot` was
// undefined on the next render). The config-store paths share the refusal in
// `applyWorkspace` (TraceApp.configStore.test.tsx).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { alertMock, currentPlots, loadWorkspace, resetHarness } from '../test/traceAppHarness';
import { WithCanopy } from '../test/canopy';
import { TraceApp } from './TraceApp';

vi.mock('./PlotArea', async (importOriginal) =>
  (await import('../test/traceAppHarness')).mocks.PlotArea(await importOriginal())
);
vi.mock(
  '../hooks/useElogConfig',
  async () => (await import('../test/traceAppHarness')).mocks.useElogConfig
);
vi.mock('../io/download', async () => (await import('../test/traceAppHarness')).mocks.download);

beforeEach(() => resetHarness());
afterEach(() => cleanup());

describe('importing a workspace with no plots', () => {
  it('is refused and leaves the open workspace as it was', async () => {
    render(<TraceApp />, { wrapper: WithCanopy });
    const before = currentPlots();
    expect(before).toHaveLength(1);
    await loadWorkspace(
      JSON.stringify({
        schemaVersion: 1,
        savedAt: '2026-11-01T00:00:00Z',
        theme: 'dark',
        plots: [],
      })
    );
    expect(alertMock).toHaveBeenCalledWith('Failed to import: Workspace contains no plots');
    expect(currentPlots()).toBe(before);
  });
});
