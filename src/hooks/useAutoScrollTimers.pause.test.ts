// @vitest-environment jsdom
//
// useAutoScrollTimers pauses while the embedding host reports Trace hidden:
// no plot's anchor advances, so its windows hold still. A detached plot or
// Data Insight window keeps the clock running, because that window is still
// on screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Plot } from '../types';
import type { TimeWindowNs } from '../api/time';

type Hook = typeof import('./useAutoScrollTimers');
type Bridge = typeof import('../embed/bridge');

// The bridge keeps module-level state, so every test imports fresh copies.
async function load(search = '/?embedded=true'): Promise<{ hook: Hook; bridge: Bridge }> {
  window.history.replaceState(null, '', search);
  vi.resetModules();
  const bridge = await import('../embed/bridge');
  const hook = await import('./useAutoScrollTimers');
  return { hook, bridge };
}

function fromParent(data: unknown): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', { data, origin: location.origin, source: window.parent })
    );
  });
}

const hide = () => fromParent({ type: 'canopy:trace-visibility', visible: false });
const show = () => fromParent({ type: 'canopy:trace-visibility', visible: true });

function makePlot(overrides: Partial<Plot> = {}): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [],
    axes: [],
    backgroundColor: 'default',
    showLegend: true,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
    refreshIntervalS: 1,
    ...overrides,
  };
}

const NO_VIEW = new Map<string, TimeWindowNs>();
const T0 = new Date('2026-06-05T12:00:00Z').getTime();

let uninstall: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanup();
  uninstall?.();
  uninstall = undefined;
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

function mount(hook: Hook, plots: Plot[], anyDetached = false) {
  return renderHook(
    ({ detached }: { detached: boolean }) => hook.useAutoScrollTimers(plots, NO_VIEW, detached),
    { initialProps: { detached: anyDetached } }
  );
}

// One act per second, so each tick commits before the next is due.
function advance(ms: number): void {
  for (let t = 0; t < ms; t += 1000) {
    act(() => {
      vi.advanceTimersByTime(1000);
    });
  }
}

describe('useAutoScrollTimers visibility pause', () => {
  it('advances the anchor while visible', async () => {
    const { hook, bridge } = await load();
    uninstall = bridge.installBridge();
    const h = mount(hook, [makePlot()]);
    advance(5000);
    expect(h.result.current.nowFor('p1')).toBe(T0 + 5000);
  });

  it('holds the anchor while hidden', async () => {
    const { hook, bridge } = await load();
    uninstall = bridge.installBridge();
    const h = mount(hook, [makePlot()]);
    advance(2000);
    hide();
    advance(60_000);
    expect(h.result.current.nowFor('p1')).toBe(T0 + 2000);
  });

  it('re-anchors at once and resumes when visible again', async () => {
    const { hook, bridge } = await load();
    uninstall = bridge.installBridge();
    const h = mount(hook, [makePlot()]);
    hide();
    advance(60_000);
    show();
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(h.result.current.nowFor('p1')).toBe(T0 + 60_000);
    advance(3000);
    expect(h.result.current.nowFor('p1')).toBe(T0 + 63_000);
  });

  it('keeps advancing while hidden when a plot or the DIT is detached', async () => {
    const { hook, bridge } = await load();
    uninstall = bridge.installBridge();
    const h = mount(hook, [makePlot()], true);
    hide();
    advance(10_000);
    expect(h.result.current.nowFor('p1')).toBe(T0 + 10_000);
  });

  it('holds once the last detached window reattaches while hidden', async () => {
    const { hook, bridge } = await load();
    uninstall = bridge.installBridge();
    const h = mount(hook, [makePlot()], true);
    hide();
    advance(5000);
    h.rerender({ detached: false });
    advance(10_000);
    expect(h.result.current.nowFor('p1')).toBe(T0 + 5000);
  });

  it('never pauses when not embedded', async () => {
    const { hook, bridge } = await load('/');
    uninstall = bridge.installBridge();
    const h = mount(hook, [makePlot()]);
    hide();
    advance(2000);
    expect(h.result.current.nowFor('p1')).toBe(T0 + 2000);
  });
});
