// @vitest-environment jsdom
//
// The keymap's drawing slot: on a focused SinglePlot root Alt+H/V/L/R/B/N/M
// arm their tool, Delete/Backspace remove the selected drawing with one
// commit, and Esc goes through the overlay handle — claimed (defaultPrevented)
// only when it cancels a pending draw or disarms, never for a plain deselect,
// which the workbench Escape reset owns. Keys typed into an editable target
// inside the root are ignored.
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Annotation, AnnotationKind } from './model';
import { DEFAULT_TOOL_PREFS, type AnnotationToolPrefs } from './tools';
import { firePointer } from '../plot/testUtils';
import { SinglePlot } from '../components/PlotArea';
import type { Axis, Plot } from '../types';
import { msToNs, type TimeWindowNs } from '../api/time';
import { BUILTIN_CATALOG } from './catalog';
import { toolKeysIn } from './keys';

// 800x400 canvas, one left manual axis; x maps WIN linearly, y maps [0, 100]
// over px 340..40 (the AnnotationLayer.input fixture).
const { fakeInstance, WIN } = vi.hoisted(() => {
  const WIN = { from: 1_800_000_000_000 - 4_200_000, to: 1_800_000_000_000 - 3_600_000 };
  const span = WIN.to - WIN.from;
  const isX = (f: unknown) => typeof f === 'object' && f !== null && 'xAxisIndex' in f;
  const fakeInstance = {
    getWidth: () => 800,
    getHeight: () => 400,
    isDisposed: () => false,
    getDom: () => null,
    getZr: () => ({ setCursorStyle: () => {} }),
    getModel: () => ({
      getComponent: () => ({ axis: { scale: { getExtent: (): [number, number] => [0, 100] } } }),
    }),
    convertToPixel: (f: unknown, v: number) =>
      isX(f) ? 70 + ((v - WIN.from) / span) * 660 : 340 - (v / 100) * 300,
    convertFromPixel: (f: unknown, px: number) =>
      isX(f) ? WIN.from + ((px - 70) / 660) * span : ((340 - px) / 300) * 100,
    dispatchAction: vi.fn(),
  };
  return { fakeInstance, WIN };
});

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
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
  vi.clearAllMocks();
  frames = new Map();
  nextFrame = 1;
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
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
});

const AXIS: Axis = {
  id: 'manual',
  name: 'manual',
  orientation: 'left',
  autoScale: false,
  logScale: false,
  min: 0,
  max: 100,
  visible: true,
};

function makePlot(annotations: Annotation[]): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [],
    axes: [AXIS],
    backgroundColor: 'default',
    showLegend: false,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '10m' },
    annotations,
  };
}

const VIEW: TimeWindowNs = { fromNs: msToNs(WIN.from), toNs: msToNs(WIN.to) };

const HLINE: Annotation = {
  id: 'ann-1',
  kind: 'hline',
  points: [{ t: 0, v: 50 }],
  axisId: 'manual',
  color: '#4589ff',
  width: 2,
  text: '',
};

interface Opts {
  annotations?: Annotation[];
  prefs?: Partial<AnnotationToolPrefs>;
  selectedId?: string | null;
}

/** SinglePlot under a stateful parent that applies prefs, commits and selection. */
function mountPlot(opts: Opts = {}) {
  const onPrefs = vi.fn<(patch: Partial<AnnotationToolPrefs>) => void>();
  const onCommit = vi.fn<(fn: (l: Annotation[]) => Annotation[], label: string) => void>();
  const onSelect = vi.fn<(id: string | null) => void>();
  const state = {
    annotations: opts.annotations ?? [],
    prefs: { ...DEFAULT_TOOL_PREFS, ...opts.prefs },
  };
  function Harness() {
    const [list, setList] = useState<Annotation[]>(state.annotations);
    const [prefs, setPrefs] = useState<AnnotationToolPrefs>(state.prefs);
    const [sel, setSel] = useState<string | null>(opts.selectedId ?? null);
    state.annotations = list;
    state.prefs = prefs;
    return (
      <SinglePlot
        plot={makePlot(list)}
        archiveResults={new Map()}
        liveResults={new Map()}
        formulaResults={new Map()}
        viewWindowNs={VIEW}
        onViewWindowChange={() => {}}
        annotationPrefs={prefs}
        onAnnotationPrefs={(patch) => {
          onPrefs(patch);
          setPrefs((p) => ({ ...p, ...patch }));
        }}
        selectedAnnotationId={sel}
        onSelectAnnotation={(id) => {
          onSelect(id);
          setSel(id);
        }}
        onCommitAnnotations={(fn, label) => {
          onCommit(fn, label);
          setList((l) => fn(l));
        }}
      />
    );
  }
  const { container } = render(<Harness />);
  flushFrames();
  const root = container.querySelector<HTMLElement>('[data-plot-id="p1"]')!;
  expect(root).not.toBeNull();
  const layer = () => container.querySelector('svg[data-annotation-layer]') as SVGSVGElement;
  /** Dispatches a keydown at `target` (default: the root); returns the event. */
  const key = (init: KeyboardEventInit, target: EventTarget = root) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(e);
    });
    return e;
  };
  return { container, root, layer, key, state, onPrefs, onCommit, onSelect };
}

describe('drawing keys: Alt+letter arms a tool', () => {
  const cases = Object.entries(toolKeysIn(BUILTIN_CATALOG)) as [string, AnnotationKind][];
  it.each(cases)('Alt+%s arms %s and is claimed', (letter, tool) => {
    const p = mountPlot();
    const e = p.key({ key: letter, code: `Key${letter.toUpperCase()}`, altKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(p.onPrefs).toHaveBeenCalledTimes(1);
    expect(p.onPrefs).toHaveBeenCalledWith({ tool });
    expect(p.state.prefs.tool).toBe(tool);
  });

  it('matches the physical key, not the macOS Option character', () => {
    const p = mountPlot();
    const e = p.key({ key: '˙', code: 'KeyH', altKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(p.onPrefs).toHaveBeenCalledWith({ tool: 'hline' });
  });

  it('the armed tool claims the pointer over the grid', () => {
    const p = mountPlot();
    expect(p.layer().style.pointerEvents).toBe('none');
    p.key({ key: 'b', code: 'KeyB', altKey: true });
    expect(p.layer().style.pointerEvents).toBe('all');
  });
});

describe('drawing keys: Escape', () => {
  it('with nothing to consume leaves defaultPrevented false', () => {
    const p = mountPlot();
    const e = p.key({ key: 'Escape' });
    expect(e.defaultPrevented).toBe(false);
    expect(p.onPrefs).not.toHaveBeenCalled();
    expect(p.onCommit).not.toHaveBeenCalled();
  });

  it('never deselects: a selected drawing alone leaves Esc to the workbench', () => {
    const p = mountPlot({ annotations: [HLINE], selectedId: HLINE.id });
    const e = p.key({ key: 'Escape' });
    expect(e.defaultPrevented).toBe(false);
    expect(p.onSelect).not.toHaveBeenCalled();
    expect(p.onCommit).not.toHaveBeenCalled();
  });

  it('with a pending draw cancels it and sets defaultPrevented', () => {
    const p = mountPlot({ prefs: { tool: 'trend', stay: true } });
    act(() => {
      firePointer(p.layer(), 'pointerdown', { x: 300, y: 200 });
      firePointer(p.layer(), 'pointerup', { x: 300, y: 200 });
      firePointer(p.layer(), 'pointermove', { x: 400, y: 150, buttons: 0 });
    });
    expect(p.container.querySelector('[data-annotation-draft="true"]')).not.toBeNull();
    const e = p.key({ key: 'Escape' });
    expect(e.defaultPrevented).toBe(true);
    expect(p.container.querySelector('[data-annotation-draft="true"]')).toBeNull();
    expect(p.onCommit).not.toHaveBeenCalled();
  });

  it('with an armed tool disarms it and sets defaultPrevented', () => {
    const p = mountPlot({ prefs: { tool: 'box' } });
    const e = p.key({ key: 'Escape' });
    expect(e.defaultPrevented).toBe(true);
    expect(p.state.prefs.tool).toBe('cursor');
    // A second Esc has nothing left to consume.
    expect(p.key({ key: 'Escape' }).defaultPrevented).toBe(false);
  });
});

describe('drawing keys: Delete / Backspace', () => {
  it.each(['Delete', 'Backspace'])('%s removes the selected drawing with one commit', (k) => {
    const p = mountPlot({ annotations: [HLINE], selectedId: HLINE.id });
    const e = p.key({ key: k });
    expect(e.defaultPrevented).toBe(true);
    expect(p.onCommit).toHaveBeenCalledTimes(1);
    expect(p.state.annotations).toEqual([]);
  });

  it('with no selection commits nothing and is not claimed', () => {
    const p = mountPlot({ annotations: [HLINE] });
    const e = p.key({ key: 'Delete' });
    expect(e.defaultPrevented).toBe(false);
    expect(p.onCommit).not.toHaveBeenCalled();
    expect(p.state.annotations).toHaveLength(1);
  });

  it('refuses a locked drawing', () => {
    const locked = { ...HLINE, locked: true as const };
    const p = mountPlot({ annotations: [locked], selectedId: locked.id });
    expect(p.key({ key: 'Delete' }).defaultPrevented).toBe(false);
    expect(p.onCommit).not.toHaveBeenCalled();
  });
});

describe('drawing keys: editable targets', () => {
  it('ignores Alt+tool, Esc and Delete typed into an input inside the root', () => {
    const p = mountPlot({ annotations: [HLINE], selectedId: HLINE.id, prefs: { tool: 'box' } });
    const input = document.createElement('input');
    p.root.appendChild(input);
    expect(p.key({ key: 'h', code: 'KeyH', altKey: true }, input).defaultPrevented).toBe(false);
    expect(p.key({ key: 'Escape' }, input).defaultPrevented).toBe(false);
    expect(p.key({ key: 'Delete' }, input).defaultPrevented).toBe(false);
    expect(p.onPrefs).not.toHaveBeenCalled();
    expect(p.onCommit).not.toHaveBeenCalled();
    expect(p.state.prefs.tool).toBe('box');
    input.remove();
  });
});
