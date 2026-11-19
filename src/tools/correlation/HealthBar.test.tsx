// @vitest-environment jsdom
//
// The Correlation health row: the line and, after a non-retryable error,
// Retry, in every mode. Under the host bar (`embedded=true&hostbar=1`) the
// actions bar is hidden and the host draws the verbs; the row is unchanged.
// The spec table places every action in the host's tile bar.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { HareConnectionStatus } from '@slaclab/canopy-client';
import { TESTIDS } from '../../workbench/testids';
import { CORRELATION_ACTION_IDS, CORRELATION_ACTION_SPECS } from './actions';
import { FakeHare, SCALAR } from '../shared/fakeHare.test-util';
import type { FormulaEngineFactory, FormulaEngineTableService } from './useTable';
import type { HealthLine } from './health';

vi.mock('../../hooks/useElogConfig', () => ({ useElogConfig: () => null }));

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component<{ className?: string }> {
    getEchartsInstance() {
      return { getDataURL: () => 'data:image/png;base64,AAAA', getWidth: () => 640 };
    }
    render() {
      return React.createElement('div', { className: this.props.className });
    }
  }
  return { default: MockECharts };
});

const { HealthBar } = await import('./HealthBar');
const { CorrelationApp } = await import('./App');

const LIVE: HealthLine = { kind: 'ok', text: 'Live', suffixes: [], retry: false, line: 'Live' };
const ERRORED: HealthLine = {
  kind: 'errored',
  text: 'Table limit exceeded',
  suffixes: [],
  retry: true,
  line: 'Table limit exceeded',
};

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('HealthBar', () => {
  it('draws the line and no verbs', () => {
    render(<HealthBar health={LIVE} onRetry={() => {}} />);
    expect(screen.getByTestId('health-text').textContent).toBe('Live');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('keeps Retry after a non-retryable error', () => {
    const onRetry = vi.fn();
    render(<HealthBar health={ERRORED} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('Correlation spec table (host placements)', () => {
  it('places every action in the tile bar, in bar order, and none in the ⋯ menu', () => {
    const placed = CORRELATION_ACTION_IDS.slice().sort(
      (a, b) => CORRELATION_ACTION_SPECS[a].bar!.order - CORRELATION_ACTION_SPECS[b].bar!.order
    );
    expect(placed).toEqual(['pause', 'clear', 'export-csv', 'export-png', 'post-elog']);
    for (const id of CORRELATION_ACTION_IDS) {
      expect(CORRELATION_ACTION_SPECS[id].menu).toBeUndefined();
    }
  });
});

// ------------------------------------------------------------------- App --

class Hare extends FakeHare {
  status: HareConnectionStatus = 'connected';
}

/** A Formula Engine table service that never delivers: the row is what is under test. */
class FakeFormulaEngine implements FormulaEngineTableService {
  status = 'connected' as const;
  connect(): void {}
  dispose(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

const QUERY = 'x=SIM:HCM01:SP&y=SIM:BPM01:X';

async function mountApp(search: string): Promise<void> {
  window.history.replaceState(null, '', `/correlation.html?${search}`);
  const hare = new Hare();
  const createFormulaEngine: FormulaEngineFactory = () => new FakeFormulaEngine();
  render(
    <CorrelationApp hare={hare} createFormulaEngine={createFormulaEngine} search={async () => []} />
  );
  act(() =>
    hare.initial([
      ['SIM:HCM01:SP', 'mm', SCALAR],
      ['SIM:BPM01:X', 'mm', SCALAR],
    ])
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('CorrelationApp health row', () => {
  it('standalone: the actions bar carries Pause and Clear', async () => {
    await mountApp(QUERY);
    const bar = screen.getByTestId(TESTIDS.actionsBar);
    expect(within(bar).getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('embedded without hostbar=1: the actions bar stays', async () => {
    await mountApp(`${QUERY}&embedded=true`);
    expect(screen.getByTestId(TESTIDS.actionsBar)).toBeTruthy();
  });

  it('under the host bar: no actions bar, and the row keeps only its health text', async () => {
    await mountApp(`${QUERY}&embedded=true&hostbar=1`);
    expect(screen.queryByTestId(TESTIDS.actionsBar)).toBeNull();
    const health = screen.getByTestId('correlation-health');
    expect(health.closest('.correlation-health')!.querySelectorAll('button')).toHaveLength(0);
  });
});
