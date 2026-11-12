// @vitest-environment jsdom
// Drawing rail: one toggle per
// tool arming that plot only, magnet/stay/hide-all toggles, presses that never
// reach the wrapper's axis gestures, hide-all through the per-plot channel, and
// the plot root taking focus on arming.
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { DrawingRail, TIP_DELAY } from './DrawingRail';
import { PLOT_TOGGLES } from '../plot/plotToggles';
import { isPlotChrome } from '../plot/geometry';
import type { Annotation, AnnotationKind } from './model';
import { DEFAULT_TOOL_PREFS, type AnnotationToolPrefs } from './tools';
import { fireMouse, firePointer } from '../plot/testUtils';
import { PlotArea, SinglePlot } from '../components/PlotArea';
import type { Axis, Plot } from '../types';
import { msToNs, type TimeWindowNs } from '../api/time';
import { BUILTIN_CATALOG } from './catalog';

// SinglePlot fixture (as AnnotationLayer.input.test): 800x400 canvas, grid
// x 70..730, y 40..340; x maps WIN linearly, every y axis maps [0, 100].
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const leftAuto: Axis = {
  id: 'left',
  name: 'left',
  orientation: 'left',
  autoScale: true,
  logScale: false,
  visible: true,
};

function makePlot(id: string, annotations?: Annotation[]): Plot {
  const plot: Plot = {
    id,
    title: id,
    traces: [],
    axes: [leftAuto],
    backgroundColor: 'default',
    showLegend: false,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '10m' },
  };
  if (annotations) plot.annotations = annotations;
  return plot;
}

const ns = (w: { from: number; to: number }): TimeWindowNs => ({
  fromNs: msToNs(w.from),
  toNs: msToNs(w.to),
});

const hline = (id: string, v: number): Annotation => ({
  id,
  kind: 'hline',
  axisId: 'left',
  points: [{ t: 0, v }],
  color: '#4589ff',
  width: 2,
  text: '',
});

/** A full click on `el` at wrapper-local (x, y): press, release, click. */
function clickAt(el: Element, x = 12, y = 200) {
  act(() => {
    firePointer(el, 'pointerdown', { x, y });
    fireMouse(el, 'mousedown', { x, y });
    firePointer(el, 'pointerup', { x, y });
    fireMouse(el, 'mouseup', { x, y });
    fireMouse(window, 'mouseup', { x, y });
    fireMouse(el, 'click', { x, y });
  });
}

const toolButton = (scope: ParentNode, kind: AnnotationKind) =>
  scope.querySelector(`[data-drawing-rail] [data-drawing-tool="${kind}"]`) as HTMLButtonElement;
const toggle = (scope: ParentNode, name: string) =>
  scope.querySelector(`[data-drawing-rail] [data-drawing-toggle="${name}"]`) as HTMLButtonElement;

/** The rail's tooltip, or null while none shows. */
const railTip = (scope: ParentNode) =>
  scope.querySelector('[data-drawing-rail] [data-rail-tip]') as HTMLElement | null;

/** SinglePlot with stateful prefs/hide-all, as TraceApp's channel would hold them. */
function mountPlot(
  opts: { annotations?: Annotation[]; prefs?: Partial<AnnotationToolPrefs> } = {}
) {
  const onUpdateAxis = vi.fn();
  const onViewWindowChange = vi.fn();
  const onPrefs = vi.fn();
  const onHidden = vi.fn();
  function Harness() {
    const [prefs, setPrefs] = useState<AnnotationToolPrefs>({
      ...DEFAULT_TOOL_PREFS,
      ...opts.prefs,
    });
    const [hidden, setHidden] = useState(false);
    return (
      <SinglePlot
        plot={makePlot('p1', opts.annotations)}
        archiveResults={new Map()}
        liveResults={new Map()}
        formulaResults={new Map()}
        onUpdateAxis={onUpdateAxis}
        viewWindowNs={ns(WIN)}
        onViewWindowChange={onViewWindowChange}
        annotationPrefs={prefs}
        onAnnotationPrefs={(patch) => {
          onPrefs(patch);
          setPrefs((p) => ({ ...p, ...patch }));
        }}
        annotationsHidden={hidden}
        onAnnotationsHidden={(on) => {
          onHidden(on);
          setHidden(on);
        }}
      />
    );
  }
  const { container } = render(<Harness />);
  const wrap = container.querySelector('[data-plot-id="p1"]') as HTMLElement;
  return { container, wrap, onUpdateAxis, onViewWindowChange, onPrefs, onHidden };
}

describe('DrawingRail', () => {
  it('tags its root as plot chrome and names each tool key in its tooltip', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { container } = render(
        <DrawingRail catalog={BUILTIN_CATALOG} prefs={DEFAULT_TOOL_PREFS} onPrefs={() => {}} />
      );
      const rail = container.querySelector('[data-drawing-rail]')!;
      expect(rail).not.toBeNull();
      expect(isPlotChrome(toolButton(container, 'hline'))).toBe(true);
      const tools: [AnnotationKind, string, string][] = [
        ['hline', 'Horizontal line', 'Alt+H'],
        ['vline', 'Vertical line', 'Alt+V'],
        ['trend', 'Trend line', 'Alt+L'],
        ['trange', 'Time range', 'Alt+R'],
        ['box', 'Box', 'Alt+B'],
        ['note', 'Note', 'Alt+N'],
        ['measure', 'Measure', 'Alt+M'],
      ];
      for (const [kind, label, key] of tools) {
        const button = toolButton(container, kind);
        // No native title: the rail's own tooltip names the tool and its key.
        expect(button.hasAttribute('title')).toBe(false);
        act(() => {
          fireEvent.pointerEnter(button);
          vi.advanceTimersByTime(TIP_DELAY);
        });
        const tip = railTip(container)!;
        expect(tip.getAttribute('role')).toBe('tooltip');
        expect(tip.querySelector('span')!.textContent).toBe(label);
        expect(tip.querySelector('kbd')!.textContent).toBe(key);
        expect(button.getAttribute('aria-describedby')).toBe(tip.id);
        act(() => {
          fireEvent.pointerLeave(button);
        });
        expect(railTip(container)).toBeNull();
        expect(button.hasAttribute('aria-describedby')).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('stands the tools and toggles in their groups, a separator between groups', () => {
    const { container } = render(
      <DrawingRail
        catalog={BUILTIN_CATALOG}
        prefs={DEFAULT_TOOL_PREFS}
        onPrefs={() => {}}
        onHiddenChange={() => {}}
        view={{ tooltip: true, drag: 'pan' }}
        onView={() => {}}
      />
    );
    const rail = container.querySelector('[data-drawing-rail]')!;
    const seq = [...rail.children]
      .filter((el) => !el.hasAttribute('data-rail-tip'))
      .map(
        (el) =>
          el.getAttribute('data-drawing-tool') ?? el.getAttribute('data-drawing-toggle') ?? '|'
      );
    expect(seq).toEqual([
      'hline',
      'vline',
      'trend',
      '|',
      'trange',
      'box',
      '|',
      'note',
      'measure',
      '|',
      'magnet',
      'stay',
      '|',
      'tooltip',
      'drag',
      '|',
      'hide',
    ]);
  });

  it('shows a tooltip after a short rest, and at once when moving along the rail', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { container } = render(
        <DrawingRail catalog={BUILTIN_CATALOG} prefs={DEFAULT_TOOL_PREFS} onPrefs={() => {}} />
      );
      act(() => {
        fireEvent.pointerEnter(toolButton(container, 'box'));
        vi.advanceTimersByTime(TIP_DELAY - 1);
      });
      expect(railTip(container)).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(railTip(container)!.textContent).toBe('BoxAlt+B');
      act(() => {
        fireEvent.pointerLeave(toolButton(container, 'box'));
        fireEvent.pointerEnter(toolButton(container, 'note'));
      });
      expect(railTip(container)!.textContent).toBe('NoteAlt+N');
      // A strip toggle's tooltip is its title, with no key.
      act(() => {
        fireEvent.pointerLeave(toolButton(container, 'note'));
        fireEvent.pointerEnter(toggle(container, 'stay'));
      });
      expect(railTip(container)!.textContent).toBe('Keep drawing: the tool stays armed');
      expect(railTip(container)!.querySelector('kbd')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops native pointerdown/mousedown at the rail', () => {
    const outer = vi.fn();
    const { container } = render(
      <div ref={(el) => el?.addEventListener('pointerdown', outer)}>
        <div ref={(el) => el?.addEventListener('mousedown', outer)}>
          <DrawingRail catalog={BUILTIN_CATALOG} prefs={DEFAULT_TOOL_PREFS} onPrefs={() => {}} />
        </div>
      </div>
    );
    firePointer(toolButton(container, 'box'), 'pointerdown');
    fireMouse(toolButton(container, 'box'), 'mousedown');
    expect(outer).not.toHaveBeenCalled();
  });

  it('pressed reflects the armed tool; clicking it again disarms to the cursor', () => {
    const onPrefs = vi.fn();
    const focusRoot = vi.fn();
    const { container } = render(
      <DrawingRail
        catalog={BUILTIN_CATALOG}
        prefs={{ ...DEFAULT_TOOL_PREFS, tool: 'trend' }}
        onPrefs={onPrefs}
        focusRoot={focusRoot}
      />
    );
    expect(toolButton(container, 'trend').getAttribute('aria-pressed')).toBe('true');
    expect(toolButton(container, 'hline').getAttribute('aria-pressed')).toBe('false');
    clickAt(toolButton(container, 'trend'));
    expect(onPrefs).toHaveBeenLastCalledWith({ tool: 'cursor' });
    clickAt(toolButton(container, 'hline'));
    expect(onPrefs).toHaveBeenLastCalledWith({ tool: 'hline' });
    expect(focusRoot).toHaveBeenCalled();
  });

  it('magnet and stay toggle the plot prefs', () => {
    const onPrefs = vi.fn();
    const { container, rerender } = render(
      <DrawingRail catalog={BUILTIN_CATALOG} prefs={DEFAULT_TOOL_PREFS} onPrefs={onPrefs} />
    );
    clickAt(toggle(container, 'magnet'));
    expect(onPrefs).toHaveBeenLastCalledWith({ magnet: true });
    clickAt(toggle(container, 'stay'));
    expect(onPrefs).toHaveBeenLastCalledWith({ stay: true });
    rerender(
      <DrawingRail
        catalog={BUILTIN_CATALOG}
        prefs={{ ...DEFAULT_TOOL_PREFS, magnet: true, stay: true }}
        onPrefs={onPrefs}
      />
    );
    expect(toggle(container, 'magnet').getAttribute('aria-pressed')).toBe('true');
    expect(toggle(container, 'stay').getAttribute('aria-pressed')).toBe('true');
    clickAt(toggle(container, 'magnet'));
    expect(onPrefs).toHaveBeenLastCalledWith({ magnet: false });
  });
});

describe('DrawingRail strip registry', () => {
  const allToggles = (scope: ParentNode) =>
    [...scope.querySelectorAll('[data-drawing-rail] [data-drawing-toggle]')].map((b) =>
      b.getAttribute('data-drawing-toggle')
    );

  it('renders every registry toggle, in registry order, when every writer is wired', () => {
    const { container } = render(
      <DrawingRail
        catalog={BUILTIN_CATALOG}
        prefs={DEFAULT_TOOL_PREFS}
        onPrefs={() => {}}
        onHiddenChange={() => {}}
        view={{ tooltip: true, drag: 'zoom' }}
        onView={() => {}}
      />
    );
    expect(allToggles(container)).toEqual(PLOT_TOGGLES.map((t) => t.toggle));
    expect(allToggles(container)).toEqual(['magnet', 'stay', 'tooltip', 'drag', 'hide']);
    expect(PLOT_TOGGLES.map((t) => [t.toggle, t.group, t.label])).toEqual([
      ['magnet', 'assist', 'Magnet'],
      ['stay', 'assist', 'Keep drawing'],
      ['tooltip', 'view', 'Data tooltip'],
      ['drag', 'view', 'Zoom box'],
      ['hide', 'drawings', 'Hide all drawings'],
    ]);
  });

  it('leaves the view toggles out without a view writer', () => {
    const { container } = render(
      <DrawingRail catalog={BUILTIN_CATALOG} prefs={DEFAULT_TOOL_PREFS} onPrefs={() => {}} />
    );
    expect(allToggles(container)).toEqual(['magnet', 'stay']);
  });

  it('the data tooltip toggle opens the view group and shows its state as pressed', () => {
    const onView = vi.fn();
    const { container, rerender } = render(
      <DrawingRail
        catalog={BUILTIN_CATALOG}
        prefs={DEFAULT_TOOL_PREFS}
        onPrefs={() => {}}
        view={{ tooltip: true, drag: 'pan' }}
        onView={onView}
      />
    );
    const order = allToggles(container);
    expect(order.indexOf('tooltip')).toBe(order.indexOf('stay') + 1);
    expect(order.indexOf('drag')).toBe(order.indexOf('tooltip') + 1);
    const tip = toggle(container, 'tooltip');
    expect(tip.getAttribute('aria-pressed')).toBe('true');
    // Pressed reads at a glance: an inset ring, not only a background.
    expect(tip.style.boxShadow).toContain('inset');
    clickAt(tip);
    expect(onView).toHaveBeenLastCalledWith({ tooltip: false });
    rerender(
      <DrawingRail
        catalog={BUILTIN_CATALOG}
        prefs={DEFAULT_TOOL_PREFS}
        onPrefs={() => {}}
        view={{ tooltip: false, drag: 'pan' }}
        onView={onView}
      />
    );
    expect(toggle(container, 'tooltip').getAttribute('aria-pressed')).toBe('false');
    expect(toggle(container, 'tooltip').style.boxShadow).toBe('none');
  });

  it('the drag toggle flips between zoom box and pan', () => {
    const onView = vi.fn();
    const { container, rerender } = render(
      <DrawingRail
        catalog={BUILTIN_CATALOG}
        prefs={DEFAULT_TOOL_PREFS}
        view={{ tooltip: true, drag: 'pan' }}
        onView={onView}
      />
    );
    expect(toggle(container, 'drag').getAttribute('aria-pressed')).toBe('false');
    clickAt(toggle(container, 'drag'));
    expect(onView).toHaveBeenLastCalledWith({ drag: 'zoom' });
    rerender(
      <DrawingRail
        catalog={BUILTIN_CATALOG}
        prefs={DEFAULT_TOOL_PREFS}
        view={{ tooltip: true, drag: 'zoom' }}
        onView={onView}
      />
    );
    expect(toggle(container, 'drag').getAttribute('aria-pressed')).toBe('true');
    clickAt(toggle(container, 'drag'));
    expect(onView).toHaveBeenLastCalledWith({ drag: 'pan' });
  });
});

describe('DrawingRail in SinglePlot', () => {
  it('offers the tooltip (on) and drag (zoom) toggles by default', () => {
    const onPlotView = vi.fn();
    const { container } = render(
      <SinglePlot
        plot={makePlot('p1')}
        archiveResults={new Map()}
        liveResults={new Map()}
        formulaResults={new Map()}
        viewWindowNs={ns(WIN)}
        annotationPrefs={DEFAULT_TOOL_PREFS}
        onAnnotationPrefs={() => {}}
        onAnnotationsHidden={() => {}}
        onPlotView={onPlotView}
      />
    );
    expect(toggle(container, 'tooltip').getAttribute('aria-pressed')).toBe('true');
    expect(toggle(container, 'drag').getAttribute('aria-pressed')).toBe('true');
    clickAt(toggle(container, 'tooltip'));
    expect(onPlotView).toHaveBeenLastCalledWith({ tooltip: false });
  });

  it('mounts inside the plot root', () => {
    const p = mountPlot();
    expect(p.wrap.querySelector('[data-drawing-rail]')).not.toBeNull();
  });

  it('clicking a rail tool over an auto-scaled left axis never writes the axis', () => {
    const p = mountPlot();
    // x = 12 lies in the left Y-axis band (grid starts at 70).
    clickAt(toolButton(p.wrap, 'hline'), 12, 200);
    act(() => {
      fireMouse(toolButton(p.wrap, 'hline'), 'dblclick', { x: 12, y: 200 });
    });
    clickAt(toggle(p.wrap, 'magnet'), 12, 220);
    // A press on the rail dragged down the axis band: still no axis write.
    act(() => {
      const btn = toolButton(p.wrap, 'box');
      firePointer(btn, 'pointerdown', { x: 12, y: 150 });
      fireMouse(btn, 'mousedown', { x: 12, y: 150 });
      fireMouse(window, 'mousemove', { x: 12, y: 200, buttons: 1 });
      fireMouse(window, 'mousemove', { x: 12, y: 260, buttons: 1 });
      fireMouse(window, 'mouseup', { x: 12, y: 260 });
    });
    expect(p.onUpdateAxis).toHaveBeenCalledTimes(0);
    expect(p.onViewWindowChange).not.toHaveBeenCalled();
    expect(p.onPrefs).toHaveBeenCalledWith({ tool: 'hline' });
    expect(toolButton(p.wrap, 'hline').getAttribute('aria-pressed')).toBe('true');
  });

  it('arming focuses the plot root with preventScroll', () => {
    const p = mountPlot();
    const focus = vi.spyOn(p.wrap, 'focus');
    clickAt(toolButton(p.wrap, 'box'));
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(p.wrap);
  });

  it('hide-all writes the hidden flag and removes every drawing from the overlay', () => {
    const p = mountPlot({ annotations: [hline('a1', 20), hline('a2', 60)] });
    expect(p.wrap.querySelectorAll('[data-annotation-id]').length).toBe(2);
    clickAt(toggle(p.wrap, 'hide'));
    expect(p.onHidden).toHaveBeenCalledWith(true);
    expect(toggle(p.wrap, 'hide').getAttribute('aria-pressed')).toBe('true');
    expect(p.wrap.querySelectorAll('[data-annotation-id]').length).toBe(0);
    clickAt(toggle(p.wrap, 'hide'));
    expect(p.onHidden).toHaveBeenLastCalledWith(false);
    expect(p.wrap.querySelectorAll('[data-annotation-id]').length).toBe(2);
  });
});

describe('DrawingRail in the grid', () => {
  it('a rail tool arms only its own plot; hide-all goes through the channel per plot', () => {
    const onAnnotationPrefs = vi.fn();
    const onAnnotationsHidden = vi.fn();
    const { container } = render(
      <PlotArea
        plots={[makePlot('p1'), makePlot('p2')]}
        activePlotId="p1"
        viewMode="grid"
        archiveResultsByPlot={new Map()}
        liveResultsByPlot={new Map()}
        formulaResultsByPlot={new Map()}
        onSetActivePlot={() => {}}
        onAddPlot={() => {}}
        onRemovePlot={() => {}}
        onSetViewMode={() => {}}
        onPopOutPlot={() => {}}
        detachedPlotIds={[]}
        onDetachPlot={() => {}}
        onReattachPlot={() => {}}
        displayWindowByPlotId={
          new Map([
            ['p1', ns(WIN)],
            ['p2', ns(WIN)],
          ])
        }
        annotationPrefsByPlot={new Map()}
        onAnnotationPrefs={onAnnotationPrefs}
        annotationsHiddenPlotIds={new Set()}
        onAnnotationsHidden={onAnnotationsHidden}
      />
    );
    const p2 = container.querySelector('[data-plot-id="p2"]')!;
    clickAt(toolButton(p2, 'vline'));
    expect(onAnnotationPrefs).toHaveBeenCalledTimes(1);
    expect(onAnnotationPrefs).toHaveBeenCalledWith('p2', { tool: 'vline' });
    clickAt(toggle(p2, 'hide'));
    expect(onAnnotationsHidden).toHaveBeenCalledTimes(1);
    expect(onAnnotationsHidden).toHaveBeenCalledWith('p2', true);
  });
});
