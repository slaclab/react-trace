// @vitest-environment jsdom
// The drawing host parts, run over a fake projection for a single-grid and a
// split config: keys route through the handle and are claimed only when
// consumed; the plot menu opens the workbench menu with the drawing entries
// as "Add … here"; a new drawing takes the axis `ownerAxisAt` names; the
// status line shows the shed notice; a `frames` bump alone commits nothing in
// the overlay.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Profiler, useMemo, useRef, useState } from 'react';
import { MenuContext, type ContextMenuApi } from '../../workbench/contextMenu/context';
import type { ContextMenuWriters, MenuRequest } from '../../workbench/contextMenu/registry';
import { drawingThemeFor } from '../../annotationTheme';
import { CORRELATION_CATALOG } from '../catalog';
import { VALUE_X_AXIS } from '../catalog/xAxis';
import type { FrameStore, GridProjection, HostConfig } from '../catalog/types';
import { createProjectionStore, type Projection } from '../../plot/geometry';
import type { Annotation } from '../model';
import { DEFAULT_TOOL_PREFS, type AnnotationToolPrefs } from '../tools';
import { firePointer, projectionOf } from '../../plot/testUtils';
import { createShedStore } from './shedStore';
import type { DrawingDocument } from './useDrawingDocument';
import {
  shedNoticeOf,
  useDrawingHost,
  useDrawingPlotMenu,
  useDrawingWrapperListeners,
  type DrawingHost,
} from './useDrawingHost';
import { DrawingLayers, DrawingRailFor } from './DrawingOverlay';
import { DrawingStatusLine } from './DrawingStatusLine';
import { drawingCommandOf, routeDrawingKey } from './hostKeys';

afterEach(cleanup);

// Grids share x = t/10. Single: one grid at (0, 0) 200 x 100 drawing 'y'
// (y = 100 - v). Split: grid 0 draws 'a' at top 0, grid 1 draws 'b' at top
// 120 (y = 220 - v).
function grid(top: number, axisId: string): GridProjection {
  const base = top + 100;
  return {
    tToX: (t) => t / 10,
    xToT: (x) => x * 10,
    vToY: (v, id) => (id === axisId ? base - v : NaN),
    yToV: (y, id) => (id === axisId ? base - y : NaN),
    gridRect: { left: 0, top, width: 200, height: 100 },
    axisIds: [axisId],
  };
}
const SINGLE = grid(0, 'y');
const G0 = grid(0, 'a');
const G1 = grid(120, 'b');
// A fresh object per read, as a real projection rebuild is, so a bump re-renders.
const singleProjection = (): Projection => projectionOf(SINGLE);
const splitProjection = (): Projection => projectionOf(G0, G1);

function createFrames(): FrameStore & { bump(): void } {
  let v = 0;
  const listeners = new Set<() => void>();
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getVersion: () => v,
    bump() {
      v += 1;
      for (const cb of [...listeners]) cb();
    },
  };
}

type Layout = 'single' | 'split';

function makeConfig(layout: Layout, over: Partial<HostConfig> = {}) {
  const frames = createFrames();
  const config: HostConfig = {
    catalog: CORRELATION_CATALOG,
    xAxis: VALUE_X_AXIS,
    snap: { snap: () => null },
    measure: { card: () => [] },
    frames,
    shed: createShedStore(),
    ownerAxisAt:
      layout === 'single' ? () => 'y' : (_x: number, y: number) => (y >= 120 ? 'b' : 'a'),
    hiddenReason: () => null,
    ...over,
  };
  return { config, frames };
}

interface Live {
  list: Annotation[];
  prefs: AnnotationToolPrefs;
  selectedId: string | null;
  hidden: boolean;
  host: DrawingHost | null;
  /** The workbench menu opens, in order: the request and the plot's writers. */
  menus: { request: MenuRequest; writers: ContextMenuWriters }[];
}

function mount(
  layout: Layout,
  opts: {
    config?: Partial<HostConfig>;
    prefs?: Partial<AnnotationToolPrefs>;
    /** The document carries no hide-all writer. */
    noHide?: boolean;
  } = {}
) {
  const { config, frames } = makeConfig(layout, opts.config);
  const store = createProjectionStore(layout === 'single' ? singleProjection : splitProjection);
  const axes = layout === 'single' ? [{ id: 'y' }] : [{ id: 'a' }, { id: 'b' }];
  const live: Live = {
    list: [],
    prefs: { ...DEFAULT_TOOL_PREFS, ...opts.prefs },
    selectedId: null,
    hidden: false,
    host: null,
    menus: [],
  };
  const menuApi: ContextMenuApi = {
    openSignals: () => false,
    open(request, _at, writers) {
      live.menus.push({ request, writers: writers ?? {} });
      return true;
    },
    signalOf: () => null,
    toast: () => {},
  };
  const commits = { overlay: 0 };
  const commit = vi.fn();

  function Plot() {
    const [list, setList] = useState<Annotation[]>([]);
    const [prefs, setPrefsState] = useState<AnnotationToolPrefs>(live.prefs);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [hidden, setHidden] = useState(false);
    const document = useMemo<DrawingDocument>(
      () => ({
        annotations: list,
        commit(fn, label) {
          commit(label);
          setList((l) => fn(l));
        },
        undo: () => {},
        selectedId,
        select: setSelectedId,
        prefs,
        setPrefs: (patch) => setPrefsState((p) => ({ ...p, ...patch })),
        hidden,
        setHidden: opts.noHide ? undefined : setHidden,
      }),
      [list, selectedId, prefs, hidden]
    );
    live.list = list;
    live.prefs = prefs;
    live.selectedId = selectedId;
    live.hidden = hidden;
    const host = useDrawingHost(config, document, store, { axes, theme: drawingThemeFor('dark') });
    live.host = host;
    const wrapRef = useRef<HTMLDivElement | null>(null);
    useDrawingWrapperListeners(wrapRef, host);
    useDrawingPlotMenu(host);
    return (
      <>
        <div ref={wrapRef} data-testid="wrap" style={{ position: 'relative' }}>
          <Profiler id="overlay" onRender={() => void (commits.overlay += 1)}>
            <DrawingLayers host={host} />
            <DrawingRailFor host={host} />
          </Profiler>
        </div>
        <DrawingStatusLine host={host} />
      </>
    );
  }

  const utils = render(
    <MenuContext.Provider value={menuApi}>
      <Plot />
    </MenuContext.Provider>
  );
  act(() => store.bump());
  const wrap = utils.getByTestId('wrap');
  const svgs = () => [...wrap.querySelectorAll('svg[data-annotation-layer]')] as SVGSVGElement[];
  const key = (init: KeyboardEventInit, target: EventTarget = wrap) => {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(ev);
    });
    return ev;
  };
  const fire = (el: EventTarget, type: string, x: number, y: number) =>
    act(() => {
      firePointer(el, type, { x, y });
    });
  return { ...utils, wrap, store, config, frames, live, commits, commit, svgs, key, fire };
}

describe('drawing host keys', () => {
  it('routes a key through the handle and claims it only when consumed', () => {
    const { key, live } = mount('single');
    // Alt+H arms the H-line (by physical key: Option+H is ˙ on macOS).
    const arm = key({ key: '˙', code: 'KeyH', altKey: true });
    expect(arm.defaultPrevented).toBe(true);
    expect(live.prefs.tool).toBe('hline');
    // Esc disarms: consumed.
    const esc = key({ key: 'Escape' });
    expect(esc.defaultPrevented).toBe(true);
    expect(live.prefs.tool).toBe('cursor');
    // Esc with nothing to cancel falls through (the workbench reset owns it).
    expect(key({ key: 'Escape' }).defaultPrevented).toBe(false);
    // Delete with nothing selected is not consumed.
    expect(key({ key: 'Delete' }).defaultPrevented).toBe(false);
    // Navigation is never the host's.
    expect(key({ key: 'ArrowLeft' }).defaultPrevented).toBe(false);
    // A tool the catalog does not offer (Alt+R, the time range) arms nothing.
    expect(key({ key: 'r', code: 'KeyR', altKey: true }).defaultPrevented).toBe(false);
    expect(live.prefs.tool).toBe('cursor');
  });

  it('ignores keys typed into an editable target inside the wrapper', () => {
    const { key, wrap, live } = mount('single');
    const input = document.createElement('input');
    wrap.appendChild(input);
    const ev = key({ key: 'h', code: 'KeyH', altKey: true }, input);
    expect(ev.defaultPrevented).toBe(false);
    expect(live.prefs.tool).toBe('cursor');
  });

  it('deletes the selected drawing through the handle with one commit', () => {
    const { key, live, fire, svgs, commit } = mount('single', { prefs: { tool: 'hline' } });
    fire(svgs()[0], 'pointerdown', 50, 40);
    fire(svgs()[0], 'pointerup', 50, 40);
    expect(live.list).toHaveLength(1);
    act(() => live.host!.document.select(live.list[0].id));
    commit.mockClear();
    const del = key({ key: 'Delete' });
    expect(del.defaultPrevented).toBe(true);
    expect(live.list).toHaveLength(0);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('handleDrawingKey answers whether it consumed the command', () => {
    const { live } = mount('split');
    let out = false;
    act(() => {
      out = live.host!.handleDrawingKey({ kind: 'arm', tool: 'box' });
    });
    expect(out).toBe(true);
    expect(live.prefs.tool).toBe('box');
    expect(live.host!.handleDrawingKey({ kind: 'arm', tool: 'trange' })).toBe(false);
  });

  it('makes the wrapper focusable and focuses it on pointerdown', () => {
    const { wrap } = mount('single');
    expect(wrap.getAttribute('tabindex')).toBe('-1');
    const focus = vi.spyOn(wrap, 'focus');
    act(() => {
      firePointer(wrap, 'pointerdown', { x: 10, y: 10 });
    });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(wrap);
  });

  it('pure routing: navigation resolves to no drawing command; a refused command is not claimed', () => {
    const plain = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(drawingCommandOf(CORRELATION_CATALOG, { ...plain, key: 'ArrowRight' })).toBeNull();
    expect(drawingCommandOf(CORRELATION_CATALOG, { ...plain, key: 'Escape' })).toEqual({
      kind: 'cancel',
    });
    const e = { ...plain, key: 'Escape', preventDefault: vi.fn() };
    expect(routeDrawingKey(CORRELATION_CATALOG, e, () => false)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(routeDrawingKey(CORRELATION_CATALOG, e, () => true)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe('drawing host plot menu', () => {
  /** The "Add … here" entries of the last menu opened. */
  const addHere = (live: Live) => live.menus.at(-1)?.writers.addHere?.() ?? [];

  it('opens the workbench point menu with the drawing entries as Add … here', () => {
    const { wrap, live } = mount('split');
    act(() => {
      fireEvent.contextMenu(wrap, { clientX: 50, clientY: 150 });
    });
    expect(live.menus).toHaveLength(1);
    expect(live.menus[0].request).toEqual({ scope: 'point', signals: [], reading: undefined });
    expect(addHere(live).map((c) => c.label)).toEqual([
      'Add horizontal line here',
      'Add vertical line here',
      'Add note here',
    ]);
  });

  it('adds a drawing on the axis ownerAxisAt names and selects it', () => {
    const ownerAxisAt = vi.fn((_x: number, y: number) => (y >= 120 ? 'b' : 'a'));
    const { wrap, live } = mount('split', { config: { ownerAxisAt } });
    act(() => {
      fireEvent.contextMenu(wrap, { clientX: 50, clientY: 150 });
    });
    expect(ownerAxisAt).toHaveBeenCalledWith(50, 150, null);
    act(() => {
      addHere(live)
        .find((c) => c.label === 'Add horizontal line here')!
        .run();
    });
    expect(live.list).toHaveLength(1);
    const [a] = live.list;
    expect(a.kind).toBe('hline');
    expect(a.axisId).toBe('b');
    expect(a.points[0].v).toBe(70);
    expect(live.selectedId).toBe(a.id);
  });

  it('disables the entries where ownerAxisAt places nothing', () => {
    const { wrap, live } = mount('single', { config: { ownerAxisAt: () => null } });
    act(() => {
      fireEvent.contextMenu(wrap, { clientX: 50, clientY: 50 });
    });
    const entries = addHere(live);
    expect(entries).toHaveLength(3);
    expect(entries.every((c) => c.disabled === 'Not on a plotted axis here')).toBe(true);
  });

  it('opens no menu outside every grid or on plot chrome', () => {
    const { wrap, live } = mount('split');
    act(() => {
      fireEvent.contextMenu(wrap, { clientX: 50, clientY: 110 });
    });
    expect(live.menus).toHaveLength(0);
    const rail = wrap.querySelector('[data-drawing-rail]') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(rail, { clientX: 50, clientY: 50 });
    });
    expect(live.menus).toHaveLength(0);
  });
});

describe('drawing host layers', () => {
  it('renders one svg per grid of the split config', () => {
    const { svgs } = mount('split');
    expect(svgs()).toHaveLength(2);
  });

  it('a drawn drawing takes the axis ownerAxisAt returns', () => {
    const ownerAxisAt = vi.fn((_x: number, y: number) => (y >= 120 ? 'b' : 'a'));
    const { svgs, fire, live } = mount('split', {
      config: { ownerAxisAt },
      prefs: { tool: 'hline' },
    });
    fire(svgs()[1], 'pointerdown', 50, 150);
    fire(svgs()[1], 'pointerup', 50, 150);
    expect(ownerAxisAt).toHaveBeenCalledWith(50, 150, null);
    expect(live.list).toHaveLength(1);
    expect(live.list[0].axisId).toBe('b');
    expect(live.list[0].points[0].v).toBe(70);
  });

  it('claimsPointer answers from the overlay: armed claims, cursor on empty plot does not', () => {
    const { live, svgs } = mount('single');
    const ev = new MouseEvent('mousedown', { clientX: 50, clientY: 50 });
    Object.defineProperty(ev, 'target', { value: svgs()[0] });
    expect(live.host!.claimsPointer(ev)).toBe(false);
    act(() => {
      live.host!.handleDrawingKey({ kind: 'arm', tool: 'hline' });
    });
    expect(live.host!.claimsPointer(ev)).toBe(true);
  });

  it('offers the hide toggle only when the document has a hide-all writer', () => {
    const a = mount('single');
    expect(a.wrap.querySelector('[data-drawing-toggle="hide"]')).not.toBeNull();
    cleanup();
    const b = mount('single', { noHide: true });
    expect(b.wrap.querySelector('[data-drawing-toggle="hide"]')).toBeNull();
  });
});

describe('drawing host status line', () => {
  it('shows the shed notice while something was shed', () => {
    const { config, container } = mount('single');
    const notice = () => container.querySelector('[data-status-shed-notice]')?.textContent ?? null;
    expect(notice()).toBeNull();
    act(() => config.shed.publish({ dropped: 2, trimmed: 1 }));
    expect(notice()).toBe('2 drawings not saved in the link');
    act(() => config.shed.publish({ dropped: 0, trimmed: 3 }));
    expect(notice()).toBe('Note text shortened in the link');
    act(() => config.shed.publish({ dropped: 0, trimmed: 0 }));
    expect(notice()).toBeNull();
  });

  it('shedNoticeOf words one dropped drawing in the singular', () => {
    expect(shedNoticeOf({ dropped: 1, trimmed: 0 })).toBe('1 drawing not saved in the link');
    expect(shedNoticeOf({ dropped: 0, trimmed: 0 })).toBeNull();
  });
});

describe('drawing host re-render discipline', () => {
  it.each<Layout>(['single', 'split'])(
    '%s: a frames bump alone commits nothing in the overlay',
    (layout) => {
      const { frames, store, commits } = mount(layout);
      const before = commits.overlay;
      act(() => {
        for (let i = 0; i < 20; i += 1) frames.bump();
      });
      expect(commits.overlay).toBe(before);
      // A projection bump does re-render it (the counter is live).
      act(() => store.bump());
      expect(commits.overlay).toBeGreaterThan(before);
    }
  );
});
