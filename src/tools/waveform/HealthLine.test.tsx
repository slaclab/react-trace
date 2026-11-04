// @vitest-environment jsdom
//
// The Waveform health line: one status line in every mode. Under the host bar
// (`embedded=true&hostbar=1`) the actions bar is hidden and the host draws the
// verbs; the line is unchanged. The spec table places every action in the
// host's tile bar. Snapshot → reference is disabled with NO_SNAPSHOT_REASON
// until a live curve has data, then sets the reference.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { HareConnectionStatus } from '@slaclab/canopy-client';
import { FakeHare, type FakeValue } from '../shared/fakeHare.test-util';
import { TESTIDS } from '../../workbench/testids';
import { WAVEFORM_ACTION_IDS, WAVEFORM_ACTION_SPECS } from './actions';

vi.mock('../../hooks/useElogConfig', () => ({ useElogConfig: () => null }));

vi.mock('echarts', () => ({
  init: () => ({
    setOption: () => {},
    resize: () => {},
    dispose: () => {},
    getDataURL: () => 'data:image/png;base64,AAAA',
  }),
}));

const { WaveformHealthLine } = await import('./HealthLine');
const { WaveformApp, NO_SNAPSHOT_REASON } = await import('./App');
import type { WaveformTool } from './App';

const A = 'TEST:WF:A';

function wf(...values: number[]): FakeValue {
  return { connected: true, valueKind: 'waveform', value: values };
}

class Hare extends FakeHare {
  status: HareConnectionStatus = 'connected';
}

function barButton(name: RegExp): HTMLElement {
  return within(screen.getByTestId(TESTIDS.actionsBar)).getByRole('button', { name });
}

// Carbon's multiselect (the e-log dialog) measures with ResizeObserver.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('WaveformHealthLine', () => {
  it('standalone: one status line, no verbs', () => {
    render(<WaveformHealthLine status="connected" />);
    const line = screen.getByTestId('waveform-health');
    expect(line.tagName).toBe('P');
    expect(line.className).toBe('waveform-health');
    expect(line.textContent).toBe('Live data connected');
  });

  it('keeps its text and role while the connection is lost', () => {
    render(<WaveformHealthLine status="disconnected" />);
    const line = screen.getByTestId('waveform-health');
    expect(line.getAttribute('role')).toBe('status');
    expect(line.textContent).toBe('Live data connection lost — reconnecting…');
  });
});

describe('Waveform spec table (host placements)', () => {
  it('places every action in the tile bar, in bar order, and none in the ⋯ menu', () => {
    const placed = WAVEFORM_ACTION_IDS.slice().sort(
      (a, b) => WAVEFORM_ACTION_SPECS[a].bar!.order - WAVEFORM_ACTION_SPECS[b].bar!.order
    );
    expect(placed).toEqual(['pause', 'snapshot', 'export-csv', 'export-png', 'post-elog']);
    for (const id of WAVEFORM_ACTION_IDS) {
      expect(WAVEFORM_ACTION_SPECS[id].menu).toBeUndefined();
    }
  });
});

// ------------------------------------------------------------------- App --

interface Mounted {
  hare: Hare;
  tool: WaveformTool;
  flush(): void;
}

function mountApp(search: string): Mounted {
  window.history.replaceState(null, '', `/waveform.html?${search}`);
  const hare = new Hare();
  const pending: Array<() => void> = [];
  let tool: WaveformTool | null = null;
  let t = 1000;
  render(
    <WaveformApp
      hare={hare}
      controllerOptions={{
        now: () => t++,
        requestFrame: (cb) => pending.push(cb),
        cancelFrame: () => {
          pending.length = 0;
        },
        setTimer: () => 0,
        clearTimer: () => {},
      }}
      onTool={(t2) => {
        tool = t2;
      }}
    />
  );
  if (tool === null) throw new Error('no tool handle');
  return {
    hare,
    tool,
    flush() {
      act(() => {
        for (const cb of pending.splice(0)) cb();
      });
    },
  };
}

describe('WaveformApp health line', () => {
  it('standalone: the actions bar carries Pause and Snapshot; Pause toggles pressed', () => {
    mountApp(`pv=${A}`);
    expect(barButton(/^Pause/).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(barButton(/^Pause/));
    expect(barButton(/^Pause/).getAttribute('aria-pressed')).toBe('true');
  });

  it('Snapshot is disabled until a live curve has data, then sets the reference', () => {
    const m = mountApp(`pv=${A}`);
    const snap = () => barButton(/^Snapshot → reference/);
    expect(snap().getAttribute('aria-disabled')).toBe('true');
    expect(barButton(new RegExp(NO_SNAPSHOT_REASON))).toBe(snap());
    fireEvent.click(snap());
    expect(m.tool.getState().reference).toBeFalsy();

    act(() => m.hare.initial([[A, 'mm', wf(1, 2, 3)]]));
    m.flush();
    expect(snap().getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(snap());
    const ref = m.tool.getState().reference;
    expect(ref?.kind).toBe('snapshot');
    if (ref?.kind !== 'snapshot') throw new Error('no snapshot');
    expect(Array.from(ref.frames[A] ?? [])).toEqual([1, 2, 3]);
  });

  it('embedded without hostbar=1: the actions bar stays', () => {
    mountApp(`pv=${A}&embedded=true`);
    expect(screen.getByTestId(TESTIDS.actionsBar)).toBeTruthy();
  });

  it('under the host bar: no actions bar, and the line keeps only its health text', () => {
    mountApp(`pv=${A}&embedded=true&hostbar=1`);
    expect(screen.queryByTestId(TESTIDS.actionsBar)).toBeNull();
    const line = screen.getByTestId('waveform-health');
    expect(line.tagName).toBe('P');
    expect(line.querySelectorAll('button')).toHaveLength(0);
  });
});
