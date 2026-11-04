// @vitest-environment jsdom
// Annotation layer, input half: pointer gestures through reduceToolsIn, one commit per
// gesture forwarded from the handler, the root claiming the pointer only while
// armed or live, the OverlayHandle answering from the ref mirror, and the
// SinglePlot wiring (shift-measure claim before the interior pan, showTip).
import { createRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { drawingThemeFor } from '../annotationTheme';
import { createProjectionStore, type Projection } from '../plot/geometry';
import type { Annotation } from './model';
import { AnnotationLayer, type OverlayHandle } from './AnnotationLayer';
import { DEFAULT_TOOL_PREFS, type AnnotationToolPrefs } from './tools';
import { fireMouse, firePointer, projectionOf } from '../plot/testUtils';
import { PlotArea, SinglePlot } from '../components/PlotArea';
import type { Axis, Plot } from '../types';
import { msToNs, type TimeWindowNs } from '../api/time';
import { BUILTIN_CATALOG } from './catalog';
import { TIME_X_AXIS } from './catalog/xAxis';

const TRACE_LAYER = { catalog: BUILTIN_CATALOG, xAxis: TIME_X_AXIS };

// ---------------------------------------------------------------------------
// SinglePlot fixture: 800x400 canvas, left manual + right auto axis -> grid
// x 70..730 (660 px), y 40..340 (300 px). x maps WINDOW linearly; every y axis
// maps [0, 100] over px 340..40.
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
  for (const cb of pending) cb(0);
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

// ---------------------------------------------------------------------------
// Overlay-only fixture: grid at (60, 20), 400 x 200; x = 60 + t/10; y on 'a' = 220 - v.
const GRID = { left: 60, top: 20, width: 400, height: 200 };
function fakeProjection(): Projection {
  return projectionOf({
    tToX: (t) => GRID.left + t / 10,
    xToT: (x) => (x - GRID.left) * 10,
    vToY: (v, axisId) => (axisId === 'a' ? 220 - v : NaN),
    yToV: (y, axisId) => (axisId === 'a' ? 220 - y : NaN),
    gridRect: GRID,
    axisIds: ['a'],
  });
}

function ann(over: Partial<Annotation> & Pick<Annotation, 'id' | 'kind' | 'points'>): Annotation {
  return { axisId: 'a', color: '#4589ff', width: 2, text: '', ...over };
}

interface HarnessOpts {
  annotations?: Annotation[];
  prefs?: Partial<AnnotationToolPrefs>;
  selectedId?: string | null;
  annotationsHidden?: boolean;
}

/** AnnotationLayer under a stateful parent that applies commits, prefs and selection. */
function mountLayer(opts: HarnessOpts = {}) {
  const store = createProjectionStore(fakeProjection);
  const onCommit = vi.fn();
  const onPrefs = vi.fn();
  const onSelect = vi.fn();
  const showTip = vi.fn();
  const overlayRef = createRef<OverlayHandle>();
  const state = { annotations: opts.annotations ?? [] };
  function Harness() {
    const [list, setList] = useState<Annotation[]>(opts.annotations ?? []);
    const [prefs, setPrefs] = useState<AnnotationToolPrefs>({
      ...DEFAULT_TOOL_PREFS,
      ...opts.prefs,
    });
    const [sel, setSel] = useState<string | null>(opts.selectedId ?? null);
    state.annotations = list;
    return (
      <div style={{ position: 'relative' }}>
        <AnnotationLayer
          config={TRACE_LAYER}
          projectionStore={store}
          annotations={list}
          axes={[{ id: 'a' }]}
          theme={drawingThemeFor('dark')}
          annotationsHidden={opts.annotationsHidden}
          selectedId={sel}
          prefs={prefs}
          overlayRef={overlayRef}
          showTip={showTip}
          onCommit={(fn, label) => {
            onCommit(fn, label);
            setList((l) => fn(l));
          }}
          onPrefs={(patch) => {
            onPrefs(patch);
            setPrefs((p) => ({ ...p, ...patch }));
          }}
          onSelectAnnotation={(id) => {
            onSelect(id);
            setSel(id);
          }}
        />
      </div>
    );
  }
  const utils = render(<Harness />);
  act(() => store.bump());
  const root = () => utils.container.querySelector('svg[data-annotation-layer]') as SVGSVGElement;
  const q = (sel: string) => utils.container.querySelector(sel);
  const fire = (el: EventTarget, type: string, x: number, y: number, extra = {}) =>
    act(() => {
      firePointer(el, type, { x, y, ...extra });
    });
  return {
    ...utils,
    store,
    root,
    q,
    fire,
    onCommit,
    onPrefs,
    onSelect,
    showTip,
    overlayRef,
    state,
  };
}

const hitOf = (q: (s: string) => Element | null, id: string) =>
  q(`[data-annotation-id="${id}"] [data-annotation-hit]`) as Element;

describe('AnnotationLayer input: placing', () => {
  it('places an hline with one commit and re-arms the cursor', () => {
    const h = mountLayer({ prefs: { tool: 'hline' } });
    expect(h.root().style.pointerEvents).toBe('all');
    h.fire(h.root(), 'pointerdown', 200, 100);
    expect(h.onCommit).not.toHaveBeenCalled();
    h.fire(h.root(), 'pointerup', 200, 100);

    expect(h.onCommit).toHaveBeenCalledTimes(1);
    expect(h.onCommit.mock.calls[0][1]).toBe('Draw H-line');
    expect(h.state.annotations).toHaveLength(1);
    const [line] = h.state.annotations;
    expect(line.kind).toBe('hline');
    expect(line.axisId).toBe('a');
    expect(line.points[0].v).toBeCloseTo(120, 6);
    expect(h.onPrefs).toHaveBeenCalledTimes(1);
    expect(h.onPrefs).toHaveBeenCalledWith({ tool: 'cursor' });
    expect(h.onSelect).toHaveBeenCalledWith(line.id);
    // Back to cursor: the root no longer covers the chart; the drawing renders.
    expect(h.root().style.pointerEvents).toBe('none');
    expect(h.q(`[data-annotation-id="${line.id}"]`)).not.toBeNull();
  });

  it('with stay the tool stays armed and the next click places another', () => {
    const h = mountLayer({ prefs: { tool: 'hline', stay: true } });
    h.fire(h.root(), 'pointerdown', 200, 100);
    h.fire(h.root(), 'pointerup', 200, 100);
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    expect(h.onPrefs).not.toHaveBeenCalled();
    expect(h.root().style.pointerEvents).toBe('all');
    h.fire(h.root(), 'pointerdown', 200, 150);
    h.fire(h.root(), 'pointerup', 200, 150);
    expect(h.onCommit).toHaveBeenCalledTimes(2);
    expect(h.state.annotations.map((a) => a.points[0].v)).toEqual([120, 70]);
  });

  it('a 3-move box drag commits once and writes nothing upstream before pointerup', () => {
    const h = mountLayer({ prefs: { tool: 'box' } });
    h.fire(h.root(), 'pointerdown', 100, 50);
    h.fire(h.root(), 'pointermove', 120, 70);
    h.fire(h.root(), 'pointermove', 150, 90);
    h.fire(h.root(), 'pointermove', 180, 120);
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.onPrefs).not.toHaveBeenCalled();
    expect(h.onSelect).not.toHaveBeenCalled();
    // The draft renders locally.
    const draft = h.q('[data-annotation-draft="true"]');
    expect(draft?.getAttribute('data-annotation-kind')).toBe('box');

    h.fire(h.root(), 'pointerup', 180, 120);
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    expect(h.onSelect).toHaveBeenCalledTimes(1);
    expect(h.onPrefs).toHaveBeenCalledTimes(1);
    const [box] = h.state.annotations;
    expect(box.points[0].t).toBeCloseTo(400, 6);
    expect(box.points[0].v).toBeCloseTo(170, 6);
    expect(box.points[1].t).toBeCloseTo(1200, 6);
    expect(box.points[1].v).toBeCloseTo(100, 6);
    expect(h.q('[data-annotation-draft="true"]')).toBeNull();
  });

  it('a 2-point tool also places by two clicks', () => {
    const h = mountLayer({ prefs: { tool: 'trend' } });
    // Replay the browser's order: every pointerup (and the explicit release)
    // is followed by lostpointercapture, which jsdom never fires itself.
    h.fire(h.root(), 'pointerdown', 100, 50);
    h.fire(h.root(), 'pointerup', 100, 50);
    h.fire(h.root(), 'lostpointercapture', 100, 50);
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.q('[data-annotation-draft="true"]')).not.toBeNull();
    h.fire(h.root(), 'pointermove', 200, 100, { buttons: 0 });
    expect(h.q('[data-annotation-draft="true"]')).not.toBeNull();
    h.fire(h.root(), 'pointerdown', 300, 150);
    h.fire(h.root(), 'pointerup', 300, 150);
    h.fire(h.root(), 'lostpointercapture', 300, 150);
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    expect(h.state.annotations[0].points.map((p) => p.t)).toEqual([400, 2400]);
  });
});

describe('AnnotationLayer input: editing', () => {
  it('a click on a drawing selects it and commits nothing', () => {
    const h = mountLayer({
      annotations: [ann({ id: 'h', kind: 'hline', points: [{ t: 0, v: 100 }] })],
    });
    const hit = hitOf(h.q, 'h');
    h.fire(hit, 'pointerdown', 200, 120);
    h.fire(h.root(), 'pointerup', 200, 120);
    expect(h.onSelect).toHaveBeenCalledWith('h');
    expect(h.onCommit).not.toHaveBeenCalled();
  });

  it('moving an hline commits once on pointerup, the original hidden behind its draft', () => {
    const h = mountLayer({
      annotations: [ann({ id: 'h', kind: 'hline', points: [{ t: 0, v: 100 }] })],
    });
    h.fire(hitOf(h.q, 'h'), 'pointerdown', 200, 120);
    expect(h.root().style.pointerEvents).toBe('all');
    h.fire(h.root(), 'pointermove', 200, 110);
    h.fire(h.root(), 'pointermove', 200, 100);
    h.fire(h.root(), 'pointermove', 200, 90);
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.q('[data-annotation-id="h"]:not([data-annotation-draft])')).toBeNull();
    expect(h.q('[data-annotation-draft="true"]')).not.toBeNull();
    h.fire(h.root(), 'pointerup', 200, 90);
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    expect(h.state.annotations[0].points[0].v).toBeCloseTo(130, 6);
    expect(h.root().style.pointerEvents).toBe('none');
  });

  it('dragging a handle reshapes only that point', () => {
    const h = mountLayer({
      annotations: [
        ann({
          id: 'tr',
          kind: 'trend',
          points: [
            { t: 0, v: 100 },
            { t: 1000, v: 150 },
          ],
        }),
      ],
      selectedId: 'tr',
    });
    const handle = h.q('[data-annotation-id="tr"] [data-handle="1"]') as Element;
    expect(handle).not.toBeNull();
    h.fire(handle, 'pointerdown', 160, 70);
    h.fire(h.root(), 'pointermove', 200, 60);
    h.fire(h.root(), 'pointerup', 260, 20);
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    const [p0, p1] = h.state.annotations[0].points;
    expect(p0).toEqual({ t: 0, v: 100 });
    expect(p1.t).toBeCloseTo(2000, 6);
    expect(p1.v).toBeCloseTo(200, 6);
  });

  it('a locked drawing offers no handle and a drag leaves its points unchanged', () => {
    const locked = ann({
      id: 'L',
      kind: 'trend',
      locked: true,
      points: [
        { t: 0, v: 100 },
        { t: 1000, v: 150 },
      ],
    });
    const h = mountLayer({ annotations: [locked], selectedId: 'L' });
    expect(h.q('[data-annotation-id="L"] [data-handle]')).toBeNull();
    h.fire(hitOf(h.q, 'L'), 'pointerdown', 110, 95);
    h.fire(h.root(), 'pointermove', 150, 60);
    h.fire(h.root(), 'pointermove', 200, 40);
    h.fire(h.root(), 'pointerup', 200, 40);
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.state.annotations[0].points).toEqual(locked.points);
    expect(h.onSelect).toHaveBeenCalledWith('L');
  });
});

describe('AnnotationLayer input: note text in place', () => {
  const editor = (h: ReturnType<typeof mountLayer>) =>
    h.q('input[data-annotation-editor]') as HTMLInputElement | null;

  it('placing a note opens a focused editor; Enter saves the text as one commit', () => {
    const h = mountLayer({ prefs: { tool: 'note' } });
    h.fire(h.root(), 'pointerdown', 200, 100);
    h.fire(h.root(), 'pointerup', 200, 100);
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    const input = editor(h)!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '  beam lost  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(h.onCommit).toHaveBeenCalledTimes(2);
    expect(h.onCommit.mock.calls[1][1]).toBe('Edit Note');
    expect(h.state.annotations[0].text).toBe('beam lost');
    expect(editor(h)).toBeNull();
  });

  it('Escape closes the editor without a commit', () => {
    const h = mountLayer({ prefs: { tool: 'note' } });
    h.fire(h.root(), 'pointerdown', 200, 100);
    h.fire(h.root(), 'pointerup', 200, 100);
    const input = editor(h)!;
    fireEvent.change(input, { target: { value: 'draft' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(editor(h)).toBeNull();
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    expect(h.state.annotations[0].text).toBe('');
  });

  it('leaving the field saves; typed keys never reach the drawing shortcuts', () => {
    const h = mountLayer({ prefs: { tool: 'note' } });
    h.fire(h.root(), 'pointerdown', 200, 100);
    h.fire(h.root(), 'pointerup', 200, 100);
    const input = editor(h)!;
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    fireEvent.keyDown(input, { key: 'Delete' });
    window.removeEventListener('keydown', outer);
    expect(outer).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'ok' } });
    fireEvent.blur(input);
    expect(h.state.annotations[0].text).toBe('ok');
    expect(h.state.annotations).toHaveLength(1);
  });

  it('double-click on a note reopens its text; a locked note or another kind does not', () => {
    const note = ann({ id: 'n1', kind: 'note', points: [{ t: 1000, v: 100 }], text: 'old' });
    const locked = ann({
      id: 'n2',
      kind: 'note',
      points: [{ t: 2000, v: 100 }],
      text: 'x',
      locked: true,
    });
    const line = ann({ id: 'h1', kind: 'hline', points: [{ t: 0, v: 50 }] });
    const h = mountLayer({ annotations: [note, locked, line] });
    fireEvent.doubleClick(hitOf(h.q, 'n2'));
    expect(editor(h)).toBeNull();
    fireEvent.doubleClick(hitOf(h.q, 'h1'));
    expect(editor(h)).toBeNull();
    fireEvent.doubleClick(hitOf(h.q, 'n1'));
    const input = editor(h)!;
    expect(input.value).toBe('old');
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(h.state.annotations.find((a) => a.id === 'n1')!.text).toBe('new');
    expect(h.onCommit).toHaveBeenCalledTimes(1);
  });

  it('a real double-click (press captured by the layer) reopens the note text', () => {
    // In a browser, a press on a note starts a drag and captures the pointer on
    // the layer root, so the pointerup and the click/dblclick that follow are
    // retargeted to the root, not the note. Mirror that sequence here.
    const note = ann({ id: 'n1', kind: 'note', points: [{ t: 1000, v: 100 }], text: 'old' });
    const h = mountLayer({ annotations: [note] });
    for (let i = 0; i < 2; i++) {
      h.fire(hitOf(h.q, 'n1'), 'pointerdown', 120, 100);
      h.fire(h.root(), 'pointerup', 120, 100);
    }
    act(() => {
      fireEvent.doubleClick(h.root());
    });
    expect(editor(h)?.value).toBe('old');
    expect(h.onCommit).not.toHaveBeenCalled();
  });

  it('a double-click retargeted to the root after a press on empty ground opens nothing', () => {
    const note = ann({ id: 'n1', kind: 'note', points: [{ t: 1000, v: 100 }], text: 'old' });
    const h = mountLayer({ annotations: [note], prefs: { tool: 'hline' } });
    h.fire(hitOf(h.q, 'n1'), 'pointerdown', 120, 100);
    h.fire(h.root(), 'pointerup', 120, 100);
    h.fire(h.root(), 'pointerdown', 300, 50);
    h.fire(h.root(), 'pointerup', 300, 50);
    act(() => {
      fireEvent.doubleClick(h.root());
    });
    expect(editor(h)).toBeNull();
  });

  it('an unchanged text commits nothing', () => {
    const note = ann({ id: 'n1', kind: 'note', points: [{ t: 1000, v: 100 }], text: 'same' });
    const h = mountLayer({ annotations: [note] });
    fireEvent.doubleClick(hitOf(h.q, 'n1'));
    fireEvent.keyDown(editor(h)!, { key: 'Enter' });
    expect(h.onCommit).not.toHaveBeenCalled();
  });
});

describe('AnnotationLayer input: the overlay handle', () => {
  it('claimsPointer: armed tool, drawing hit, live gesture; not an empty press or hide-all', () => {
    const h = mountLayer({
      annotations: [ann({ id: 'h', kind: 'hline', points: [{ t: 0, v: 100 }] })],
    });
    const handle = h.overlayRef.current!;
    const press = (target: Element) => {
      const e = new MouseEvent('mousedown', { bubbles: true });
      Object.defineProperty(e, 'target', { value: target });
      return e;
    };
    expect(handle.claimsPointer(press(h.root()))).toBe(false);
    expect(handle.claimsPointer(press(hitOf(h.q, 'h')))).toBe(true);
    cleanup();

    const armed = mountLayer({ prefs: { tool: 'vline' } });
    expect(armed.overlayRef.current!.claimsPointer(press(armed.root()))).toBe(true);
    cleanup();

    const hidden = mountLayer({ prefs: { tool: 'vline' }, annotationsHidden: true });
    const e = new MouseEvent('mousedown');
    expect(hidden.overlayRef.current!.claimsPointer(e)).toBe(false);
  });

  it('beginMeasure claims at once, drafts a measure on move and commits nothing', () => {
    const h = mountLayer();
    const handle = h.overlayRef.current!;
    const ev = new PointerEvent('pointerdown', {
      clientX: 100,
      clientY: 50,
      button: 0,
      shiftKey: true,
      pointerId: 1,
    });
    act(() => handle.beginMeasure(ev));
    // Synchronous: the mousedown that follows sees the claim.
    expect(handle.claimsPointer(new MouseEvent('mousedown'))).toBe(true);
    expect(h.root().style.pointerEvents).toBe('all');
    h.fire(h.root(), 'pointermove', 200, 120);
    const draft = h.q('[data-annotation-draft="true"]');
    expect(draft?.getAttribute('data-annotation-kind')).toBe('measure');
    h.fire(h.root(), 'pointerup', 200, 120);
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.q('[data-annotation-draft="true"]')).toBeNull();
    expect(h.root().style.pointerEvents).toBe('none');
  });

  it('key(cancel) disarms an armed tool; key(delete) removes the selected drawing', () => {
    const h = mountLayer({
      annotations: [ann({ id: 'h', kind: 'hline', points: [{ t: 0, v: 100 }] })],
      prefs: { tool: 'box' },
      selectedId: 'h',
    });
    let r = { consumed: false };
    act(() => {
      r = h.overlayRef.current!.key('cancel');
    });
    expect(r.consumed).toBe(true);
    expect(h.onPrefs).toHaveBeenCalledWith({ tool: 'cursor' });
    act(() => {
      r = h.overlayRef.current!.key('delete');
    });
    expect(r.consumed).toBe(true);
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    expect(h.state.annotations).toEqual([]);
    expect(h.onSelect).toHaveBeenLastCalledWith(null);
  });

  it('a mousemove on a hit target forwards showTip at the local point', () => {
    const h = mountLayer({
      annotations: [ann({ id: 'h', kind: 'hline', points: [{ t: 0, v: 100 }] })],
    });
    act(() => {
      fireMouse(hitOf(h.q, 'h'), 'mousemove', { x: 250, y: 121 });
    });
    expect(h.showTip).toHaveBeenCalledWith(250, 121);
  });
});

// ---------------------------------------------------------------------------
// SinglePlot wiring.

const manual: Axis = {
  id: 'manual',
  name: 'manual',
  orientation: 'left',
  autoScale: false,
  logScale: false,
  min: 0,
  max: 100,
  visible: true,
};
const auto: Axis = {
  id: 'auto',
  name: 'auto',
  orientation: 'right',
  autoScale: true,
  logScale: false,
  visible: true,
};

function makePlot(annotations?: Annotation[]): Plot {
  const plot: Plot = {
    id: 'p1',
    title: 'Plot 1',
    traces: [],
    axes: [manual, auto],
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

function mountPlot(
  opts: { prefs?: Partial<AnnotationToolPrefs>; annotations?: Annotation[] } = {}
) {
  const onViewWindowChange = vi.fn();
  const onUpdateAxis = vi.fn();
  const onCommitAnnotations = vi.fn();
  const { container } = render(
    <SinglePlot
      plot={makePlot(opts.annotations)}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
      onUpdateAxis={onUpdateAxis}
      viewWindowNs={ns(WIN)}
      onViewWindowChange={onViewWindowChange}
      annotationPrefs={{ ...DEFAULT_TOOL_PREFS, ...opts.prefs }}
      onCommitAnnotations={onCommitAnnotations}
    />
  );
  const wrap = container.querySelector('[data-plot-id="p1"]')!;
  const root = () => container.querySelector('svg[data-annotation-layer]') as SVGSVGElement;
  const draft = () => container.querySelector('[data-annotation-draft="true"]');
  return { container, wrap, root, draft, onViewWindowChange, onUpdateAxis, onCommitAnnotations };
}

const winMove = (x: number, y: number) => fireMouse(window, 'mousemove', { x, y, buttons: 1 });
const winUp = (x: number, y: number) => fireMouse(window, 'mouseup', { x, y });

describe('SinglePlot drawing input', () => {
  it('mounts the overlay over the grid', () => {
    const p = mountPlot();
    const svg = p.root();
    expect(svg).not.toBeNull();
    expect(svg.style.left).toBe('70px');
    expect(svg.style.top).toBe('40px');
    expect(svg.style.pointerEvents).toBe('none');
  });

  it('shift+drag in the grid measures: no window write, a measure draft, no commit', () => {
    const p = mountPlot();
    act(() => {
      firePointer(p.wrap, 'pointerdown', { x: 400, y: 200, shiftKey: true });
      fireMouse(p.wrap, 'mousedown', { x: 400, y: 200, shiftKey: true });
    });
    expect(p.root().style.pointerEvents).toBe('all');
    act(() => {
      firePointer(p.root(), 'pointermove', { x: 450, y: 250, shiftKey: true });
      winMove(450, 250);
      firePointer(p.root(), 'pointermove', { x: 500, y: 280, shiftKey: true });
      winMove(500, 280);
    });
    expect(p.draft()?.getAttribute('data-annotation-kind')).toBe('measure');
    act(() => {
      flushFrames();
      firePointer(p.root(), 'pointerup', { x: 500, y: 280, shiftKey: true });
      winUp(500, 280);
      flushFrames();
    });
    expect(p.onViewWindowChange).not.toHaveBeenCalled();
    expect(p.onUpdateAxis).not.toHaveBeenCalled();
    expect(p.onCommitAnnotations).not.toHaveBeenCalled();
    expect(p.draft()).toBeNull();
  });

  it('an armed-tool drag draws instead of panning', () => {
    const p = mountPlot({ prefs: { tool: 'box' } });
    act(() => {
      firePointer(p.root(), 'pointerdown', { x: 300, y: 100 });
      fireMouse(p.root(), 'mousedown', { x: 300, y: 100 });
      firePointer(p.root(), 'pointermove', { x: 350, y: 150 });
      winMove(350, 150);
      firePointer(p.root(), 'pointermove', { x: 400, y: 200 });
      winMove(400, 200);
      flushFrames();
      firePointer(p.root(), 'pointerup', { x: 400, y: 200 });
      winUp(400, 200);
      flushFrames();
    });
    expect(p.onViewWindowChange).not.toHaveBeenCalled();
    expect(p.onUpdateAxis).not.toHaveBeenCalled();
    expect(p.onCommitAnnotations).toHaveBeenCalledTimes(1);
    const [fn] = p.onCommitAnnotations.mock.calls[0];
    const [box] = fn([]) as Annotation[];
    expect(box.kind).toBe('box');
    expect(box.axisId).toBe('manual');
  });

  it('shift held outside the grid does not claim; a plain grid drag still pans', () => {
    const p = mountPlot();
    act(() => {
      // Below the grid (the time band): shift does not start a measure.
      firePointer(p.wrap, 'pointerdown', { x: 400, y: 370, shiftKey: true });
    });
    expect(p.root().style.pointerEvents).toBe('none');
    act(() => {
      firePointer(p.root(), 'pointermove', { x: 450, y: 380, shiftKey: true });
      fireMouse(p.wrap, 'mouseup', { x: 450, y: 380 });
      winUp(450, 380);
    });
    expect(p.draft()).toBeNull();
    expect(p.onCommitAnnotations).not.toHaveBeenCalled();

    act(() => {
      firePointer(p.wrap, 'pointerdown', { x: 400, y: 200 });
      fireMouse(p.wrap, 'mousedown', { x: 400, y: 200 });
      winMove(450, 220);
      flushFrames();
      winUp(450, 220);
    });
    expect(p.onViewWindowChange).toHaveBeenCalledTimes(1);
  });

  it('a mousemove on an hline hit path forwards showTip with the local x and y', () => {
    const line = ann({ id: 'h', kind: 'hline', axisId: 'manual', points: [{ t: 0, v: 50 }] });
    const p = mountPlot({ annotations: [line] });
    const hit = p.container.querySelector('[data-annotation-id="h"] [data-annotation-hit]');
    expect(hit).not.toBeNull();
    act(() => {
      fireMouse(hit!, 'mousemove', { x: 333, y: 190 });
    });
    expect(fakeInstance.dispatchAction).toHaveBeenCalledWith({ type: 'showTip', x: 333, y: 190 });
  });
});

describe('PlotArea drawing channel', () => {
  it('threads onCommitAnnotations to the tab mount with the plot id', () => {
    const onCommitAnnotations = vi.fn();
    const plot = makePlot();
    const { container } = render(
      <PlotArea
        plots={[plot]}
        activePlotId="p1"
        viewMode="tabs"
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
        displayWindowByPlotId={new Map([['p1', ns(WIN)]])}
        annotationPrefsByPlot={new Map([['p1', { ...DEFAULT_TOOL_PREFS, tool: 'hline' }]])}
        onCommitAnnotations={onCommitAnnotations}
      />
    );
    const root = container.querySelector(
      '[data-plot-id="p1"] svg[data-annotation-layer]'
    ) as SVGSVGElement;
    expect(root).not.toBeNull();
    expect(root.style.pointerEvents).toBe('all');
    act(() => {
      firePointer(root, 'pointerdown', { x: 400, y: 190 });
      firePointer(root, 'pointerup', { x: 400, y: 190 });
    });
    expect(onCommitAnnotations).toHaveBeenCalledTimes(1);
    const [plotId, fn, label] = onCommitAnnotations.mock.calls[0];
    expect(plotId).toBe('p1');
    expect(label).toBe('Draw H-line');
    const [line] = fn([]) as Annotation[];
    expect(line.kind).toBe('hline');
  });
});

describe('AnnotationLayer input: abnormal gesture ends', () => {
  it('a second pointer neither moves nor ends the live gesture', () => {
    const h = mountLayer({ prefs: { tool: 'box' } });
    h.fire(h.root(), 'pointerdown', 100, 50, { pointerId: 1 });
    h.fire(h.root(), 'pointermove', 150, 90, { pointerId: 1 });
    h.fire(h.root(), 'pointermove', 300, 180, { pointerId: 2 });
    h.fire(h.root(), 'pointerup', 300, 180, { pointerId: 2 });
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.root().style.pointerEvents).toBe('all');
    h.fire(h.root(), 'pointerup', 180, 120, { pointerId: 1 });
    expect(h.onCommit).toHaveBeenCalledTimes(1);
    expect(h.state.annotations[0].points[1].t).toBeCloseTo(1200, 6);
  });

  it('losing pointer capture mid-drag cancels: no commit, the root released', () => {
    const h = mountLayer({
      annotations: [ann({ id: 'h', kind: 'hline', points: [{ t: 0, v: 100 }] })],
    });
    h.fire(hitOf(h.q, 'h'), 'pointerdown', 200, 120);
    h.fire(h.root(), 'pointermove', 200, 100);
    expect(h.root().style.pointerEvents).toBe('all');
    h.fire(h.root(), 'lostpointercapture', 200, 100);
    expect(h.root().style.pointerEvents).toBe('none');
    expect(h.q('[data-annotation-draft="true"]')).toBeNull();
    h.fire(h.root(), 'pointerup', 200, 90);
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.state.annotations[0].points[0].v).toBe(100);
  });

  it('hiding the drawings mid-drag drops the gesture; showing them commits nothing', () => {
    const store = createProjectionStore(fakeProjection);
    const onCommit = vi.fn();
    const list = [ann({ id: 'h', kind: 'hline', points: [{ t: 0, v: 100 }] })];
    const layer = (hidden: boolean) => (
      <div style={{ position: 'relative' }}>
        <AnnotationLayer
          config={TRACE_LAYER}
          projectionStore={store}
          annotations={list}
          axes={[{ id: 'a' }]}
          theme={drawingThemeFor('dark')}
          annotationsHidden={hidden}
          selectedId={null}
          onCommit={onCommit}
        />
      </div>
    );
    const { container, rerender } = render(layer(false));
    act(() => store.bump());
    const root = () => container.querySelector('svg[data-annotation-layer]') as SVGSVGElement;
    const hit = container.querySelector('[data-annotation-id="h"] [data-annotation-hit]')!;
    act(() => {
      firePointer(hit, 'pointerdown', { x: 200, y: 120 });
      firePointer(root(), 'pointermove', { x: 200, y: 100 });
    });
    expect(root().style.pointerEvents).toBe('all');
    rerender(layer(true));
    expect(root()).toBeNull();
    rerender(layer(false));
    expect(root().style.pointerEvents).toBe('none');
    act(() => {
      firePointer(root(), 'pointerup', { x: 200, y: 90 });
    });
    expect(onCommit).not.toHaveBeenCalled();
  });
});
