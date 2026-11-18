// @vitest-environment jsdom
//
// Mounts the whole TraceApp and clicks Save to pin the workspace filename
// (issue 112): it must use the shared local-time timestamp() like the PNG
// export, not a sliced toISOString() that ended in a stray "-" and was UTC.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { downloadBlob } from '../io/download';
import { TraceApp } from './TraceApp';
import { WithCanopy } from '../test/canopy';

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);

vi.mock('../io/download', () => ({
  downloadBlob: vi.fn(),
  downloadDataUrl: vi.fn(),
  pickFile: vi.fn(),
}));

describe('Save workspace', () => {
  beforeEach(() => {
    // jsdom lacks the layout APIs react-resizable-panels and Carbon call on mount.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    vi.stubGlobal('matchMedia', (media: string) => ({
      matches: false,
      media,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    // No E-Log backend: the config probe fails and the feature stays off.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline')))
    );
    // Fake only Date so React's scheduling still runs on real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('names the file with the local-time timestamp', () => {
    vi.setSystemTime(new Date(2026, 9, 16, 12, 30, 12)); // 2026-10-16 12:30:12 local
    render(<TraceApp />, { wrapper: WithCanopy });
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(downloadBlob).mock.calls[0][0]).toBe('trace-20261016_123012.trc.json');
  });
});
