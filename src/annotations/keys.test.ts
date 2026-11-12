// @vitest-environment jsdom
//
// The plot-root keymap: `resolveKey` maps
// letters by physical code, zoom by the produced character on any layout
// (German `+` is `BracketRight`), and never claims a key a
// registered Action shortcut owns. SinglePlot binds it on a
// focusable root: arrows pan 10 %, +/- zoom x1.25 about the centre through
// the wheel router's rAF flush, and a press focuses the root
// without scrolling its container.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';

import type { Axis, Plot } from '../types';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';
import type { FormulaSeriesResult } from '../hooks/useFormulaSeries';
import { msToNs, nsToMs, type TimeWindowNs } from '../api/time';
import { parseShortcut, type KeyEventLike } from '../workbench/useCanvasActions';
import { traceActions, type TraceActionHandlers } from '../tools/trace/actions';
import { traceCapabilities } from '../tools/trace/capabilities';
import { PAN_STEP, ZOOM_STEP, type KeyCommand, toolKeysIn, keyBindingsIn } from './keys';

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  const fakeInstance = {
    getWidth: () => 800,
    getHeight: () => 400,
    isDisposed: () => false,
    getZr: () => ({ setCursorStyle: () => {}, on: () => {}, off: () => {} }),
    getModel: () => null,
    convertToPixel: () => 0,
    convertFromPixel: () => 0,
    getDataURL: () => '',
    getDom: () => document.createElement('div'),
    resize: () => {},
    dispatchAction: () => {},
    on: () => {},
    off: () => {},
  };
  class MockECharts extends React.Component {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

import { SinglePlot } from '../components/PlotArea';
import { BUILTIN_CATALOG } from './catalog';
import { resolveKey } from '../tools/trace/drawing/builtin';

const ev = (over: Partial<KeyEventLike> & { key: string }): KeyEventLike => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

// ------------------------------------------------------------ resolveKey --

describe('resolveKey', () => {
  it.each<[string, KeyEventLike, KeyCommand]>([
    ['ArrowLeft', ev({ key: 'ArrowLeft', code: 'ArrowLeft' }), { kind: 'pan', dir: -1 }],
    ['ArrowRight', ev({ key: 'ArrowRight', code: 'ArrowRight' }), { kind: 'pan', dir: 1 }],
    ['US +', ev({ key: '+', code: 'Equal', shiftKey: true }), { kind: 'zoom', dir: 'in' }],
    ['US =', ev({ key: '=', code: 'Equal' }), { kind: 'zoom', dir: 'in' }],
    ['German +', ev({ key: '+', code: 'BracketRight' }), { kind: 'zoom', dir: 'in' }],
    ['numpad +', ev({ key: '+', code: 'NumpadAdd' }), { kind: 'zoom', dir: 'in' }],
    ['-', ev({ key: '-', code: 'Minus' }), { kind: 'zoom', dir: 'out' }],
    ['_', ev({ key: '_', code: 'Minus', shiftKey: true }), { kind: 'zoom', dir: 'out' }],
    ['German -', ev({ key: '-', code: 'Slash' }), { kind: 'zoom', dir: 'out' }],
    ['numpad -', ev({ key: '-', code: 'NumpadSubtract' }), { kind: 'zoom', dir: 'out' }],
    ['Escape', ev({ key: 'Escape', code: 'Escape' }), { kind: 'cancel' }],
    ['Delete', ev({ key: 'Delete', code: 'Delete' }), { kind: 'delete' }],
    ['Backspace', ev({ key: 'Backspace', code: 'Backspace' }), { kind: 'delete' }],
  ])('%s', (_name, e, cmd) => {
    expect(resolveKey(e, false)).toEqual(cmd);
    expect(resolveKey(e, true)).toEqual(cmd);
  });

  it('arms each tool by physical code, whatever Option produces', () => {
    for (const [letter, tool] of Object.entries(toolKeysIn(BUILTIN_CATALOG))) {
      const code = `Key${letter.toUpperCase()}`;
      // Option+H on macOS produces '˙': the code still names the key.
      expect(resolveKey(ev({ key: '˙', code, altKey: true }), true)).toEqual({ kind: 'arm', tool });
      expect(resolveKey(ev({ key: letter, code, altKey: true }), false)).toEqual({
        kind: 'arm',
        tool,
      });
    }
    expect(Object.values(toolKeysIn(BUILTIN_CATALOG)).sort()).toEqual(
      ['box', 'hline', 'measure', 'note', 'trange', 'trend', 'vline'].sort()
    );
  });

  it('never binds the typographic minus or primary+Z, and leaves modified arrows alone', () => {
    expect(resolveKey(ev({ key: '−' }), false)).toBeNull();
    expect(resolveKey(ev({ key: 'z', code: 'KeyZ', metaKey: true }), true)).toBeNull();
    expect(resolveKey(ev({ key: 'z', code: 'KeyZ', ctrlKey: true }), false)).toBeNull();
    expect(resolveKey(ev({ key: 'ArrowLeft', shiftKey: true }), false)).toBeNull();
    expect(resolveKey(ev({ key: 'ArrowLeft', altKey: true }), false)).toBeNull();
    expect(resolveKey(ev({ key: 'ArrowLeft', metaKey: true }), true)).toBeNull();
    // Browser zoom (primary +/-) stays the browser's.
    expect(resolveKey(ev({ key: '+', ctrlKey: true }), false)).toBeNull();
    expect(resolveKey(ev({ key: '-', metaKey: true }), true)).toBeNull();
    // Unbound letters and Alt+T (the theme) are not plot commands.
    expect(resolveKey(ev({ key: 'h', code: 'KeyH' }), false)).toBeNull();
    expect(resolveKey(ev({ key: 't', code: 'KeyT', altKey: true }), false)).toBeNull();
  });

  it('ignores editable targets and already-handled events', () => {
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    expect(resolveKey({ ...ev({ key: 'ArrowLeft' }), target: input }, false)).toBeNull();
    expect(resolveKey({ ...ev({ key: 'Delete' }), target: area }, false)).toBeNull();
    expect(resolveKey({ ...ev({ key: '+' }), defaultPrevented: true }, false)).toBeNull();
    const div = document.createElement('div');
    expect(resolveKey({ ...ev({ key: 'ArrowLeft' }), target: div }, false)).toEqual({
      kind: 'pan',
      dir: -1,
    });
  });
});

// ------------------------------------------- no duplicate Action shortcut --

function noopHandlers(): TraceActionHandlers {
  const n = () => {};
  return {
    refreshArchive: n,
    dataInsight: n,
    postElog: n,
    save: n,
    print: n,
    import: n,
    exportCsv: n,
    exportPng: n,
  };
}

describe.each([
  ['standalone', false],
  ['embedded', true],
])('no key binding duplicates a %s Action shortcut', (_mode, embedded) => {
  const actions = traceActions({
    handlers: noopHandlers(),
    capabilities: traceCapabilities({ elog: true }),
    embedded,
    theme: embedded ? undefined : { colorMode: 'light', toggle: () => {} },
    bugUrl: 'https://example.test/bug',
    docsUrl: 'https://example.test/docs',
  });
  const shortcuts = actions
    .map((a) => parseShortcut(a.shortcut))
    .filter((s): s is NonNullable<typeof s> => s !== null);

  it('has shortcuts to compare against', () => {
    expect(shortcuts.length).toBeGreaterThanOrEqual(5);
    if (!embedded) expect(shortcuts).toContainEqual({ mod: 'alt', key: 't' });
  });

  it('no keyBindingsIn(BUILTIN_CATALOG) entry equals a parsed shortcut', () => {
    for (const b of keyBindingsIn(BUILTIN_CATALOG)) {
      const clash = shortcuts.find((s) => s.mod === b.mod && s.key === b.key.toLowerCase());
      expect(clash, `${b.mod}+${b.key}`).toBeUndefined();
    }
  });

  it('every Action shortcut resolves to no plot command on either platform', () => {
    for (const s of shortcuts) {
      const code = `Key${s.key.toUpperCase()}`;
      for (const mac of [false, true]) {
        const e = ev({
          key: s.key,
          code,
          altKey: s.mod === 'alt',
          metaKey: s.mod === 'primary' && mac,
          ctrlKey: s.mod === 'primary' && !mac,
        });
        expect(resolveKey(e, mac), `${s.mod}+${s.key}`).toBeNull();
      }
    }
  });
});

// ------------------------------------------------------- SinglePlot root --

const AXIS: Axis = {
  id: 'axis-1',
  name: 'Y-Axis 1',
  orientation: 'left',
  autoScale: true,
  logScale: false,
  visible: true,
};
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const WINDOW: TimeWindowNs = { fromNs: msToNs(T0), toNs: msToNs(T0 + 100_000) };

const PLOT: Plot = {
  id: 'plot-1',
  title: 'Plot 1',
  traces: [],
  axes: [AXIS],
  showLegend: true,
  showXGridlines: true,
  showYGridlines: true,
  showCrosshair: true,
  gridStyle: 'solid',
  gridOpacity: 1,
  tickFontSize: 11,
  xAxis: { timeRange: '-1h' },
};

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
function flushFrames() {
  const pending = [...frames.values()];
  frames.clear();
  act(() => {
    for (const cb of pending) cb(0);
  });
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  frames = new Map();
  nextFrame = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function mount(container?: HTMLElement) {
  const onViewWindowChange = vi.fn<(w: TimeWindowNs) => void>();
  const props = {
    plot: PLOT,
    archiveResults: new Map<string, ArchiveSeriesResult>(),
    liveResults: new Map<string, LiveSeriesResult>(),
    formulaResults: new Map<string, FormulaSeriesResult>(),
    viewWindowNs: WINDOW,
    onViewWindowChange,
  };
  const r = render(createElement(SinglePlot, props), container ? { container } : undefined);
  const root = r.container.querySelector<HTMLElement>('[data-plot-id="plot-1"]');
  expect(root).not.toBeNull();
  return { root: root!, onViewWindowChange };
}

function lastWindowMs(fn: ReturnType<typeof mount>['onViewWindowChange']) {
  expect(fn).toHaveBeenCalledTimes(1);
  const w = fn.mock.calls[0][0];
  return { from: nsToMs(w.fromNs), to: nsToMs(w.toNs) };
}

describe('SinglePlot keymap', () => {
  it('is focusable with no outline ring', () => {
    const { root } = mount();
    expect(root.tabIndex).toBe(0);
    expect(root.style.outline).toMatch(/none/);
  });

  it("zooms in x1.25 about the centre on key '+' with a German layout code", () => {
    const { root, onViewWindowChange } = mount();
    const notPrevented = fireEvent.keyDown(root, { key: '+', code: 'BracketRight' });
    expect(notPrevented).toBe(false);
    expect(onViewWindowChange).not.toHaveBeenCalled();
    flushFrames();
    const w = lastWindowMs(onViewWindowChange);
    const span = 100_000 / ZOOM_STEP;
    expect(w.from).toBeCloseTo(T0 + 50_000 - span / 2, 3);
    expect(w.to).toBeCloseTo(T0 + 50_000 + span / 2, 3);
  });

  it("zooms out x1.25 about the centre on key '-'", () => {
    const { root, onViewWindowChange } = mount();
    expect(fireEvent.keyDown(root, { key: '-', code: 'Minus' })).toBe(false);
    flushFrames();
    const w = lastWindowMs(onViewWindowChange);
    const span = 100_000 * ZOOM_STEP;
    expect(w.from).toBeCloseTo(T0 + 50_000 - span / 2, 3);
    expect(w.to).toBeCloseTo(T0 + 50_000 + span / 2, 3);
  });

  it('pans 10 % on the arrows and sets defaultPrevented', () => {
    const { root, onViewWindowChange } = mount();
    const e = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    root.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    flushFrames();
    const w = lastWindowMs(onViewWindowChange);
    expect(w.from).toBeCloseTo(T0 + PAN_STEP * 100_000, 3);
    expect(w.to).toBeCloseTo(T0 + 100_000 + PAN_STEP * 100_000, 3);
  });

  it('coalesces presses between two frames into one write', () => {
    const { root, onViewWindowChange } = mount();
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    flushFrames();
    const w = lastWindowMs(onViewWindowChange);
    expect(w.from).toBeCloseTo(T0 - 2 * PAN_STEP * 100_000, 3);
  });

  it('ignores keys typed into an editable target inside the root', () => {
    const { root, onViewWindowChange } = mount();
    const input = document.createElement('input');
    root.appendChild(input);
    expect(fireEvent.keyDown(input, { key: 'ArrowLeft' })).toBe(true);
    flushFrames();
    expect(onViewWindowChange).not.toHaveBeenCalled();
  });

  it('leaves Escape unclaimed while the drawing slot is empty', () => {
    const { root, onViewWindowChange } = mount();
    expect(fireEvent.keyDown(root, { key: 'Escape' })).toBe(true);
    expect(fireEvent.keyDown(root, { key: 'Delete' })).toBe(true);
    expect(fireEvent.keyDown(root, { key: 'h', code: 'KeyH', altKey: true })).toBe(true);
    flushFrames();
    expect(onViewWindowChange).not.toHaveBeenCalled();
  });

  it('pointerdown focuses the root without scrolling its container, once', () => {
    const scroller = document.createElement('div');
    scroller.style.overflow = 'auto';
    scroller.style.height = '50px';
    document.body.appendChild(scroller);
    const host = document.createElement('div');
    host.style.height = '400px';
    scroller.appendChild(host);
    const { root } = mount(host);
    scroller.scrollTop = 30;
    const focus = vi.spyOn(root, 'focus');

    fireEvent.pointerDown(root);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(root);
    expect(scroller.scrollTop).toBe(30);

    // Already focused: no second focus call.
    fireEvent.pointerDown(root);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBe(30);
  });
});
