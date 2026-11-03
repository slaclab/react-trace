// The drawing host: the one owner of a plot's drawing gesture, and the hooks a
// plot places beside the visual parts in DrawingOverlay.tsx /
// DrawingStatusLine.tsx.
//
// `useDrawingHost(config, document, projectionStore, options)` returns the
// host: the handle `{handleDrawingKey, claimsPointer, beginModifierGesture,
// openPlotMenu}` plus what the parts read (the config, the document, the
// projection and cursor stores, the axes and theme). The gesture reducer state
// lives in the one `AnnotationLayer` that `<DrawingLayers>` mounts (one svg per
// grid); the host holds that layer's `OverlayHandle` ref and answers through
// it, so every answer comes from the gesture's ref mirror within the same
// event, and no other part keeps reducer state of its own.
//
// Re-render discipline: the host never subscribes to `config.frames` (only the
// measure card does), and its identity changes only when the config,
// document, stores, axes or theme do; the handle's methods read the latest
// inputs through a ref. A frame bump therefore commits nothing here or in the
// overlay.
//
// `useDrawingPlotMenu(host, own)` is the plot context menu: the workbench's
// point menu, joined by one "Add … here" entry per catalog tool with a
// `menuAdd`, placed at the clicked point on the axis `ownerAxisAt` names
// (snapped through `config.snap` when the magnet is on).
// `useDrawingWrapperListeners(wrapRef, host)` is for plots without a listener
// of their own.
//
// No colour/font literals here (src/annotations is literal-guarded).
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { makeAnnotationId } from '../ids';
import type { AnnotationLayerProps, AnnotationLayerTheme, OverlayHandle } from '../AnnotationLayer';
import type { HostConfig, SnapHit } from '../catalog/types';
import { useContextMenu } from '../../workbench/contextMenu/context';
import type { ContextMenuWriters, MenuSignal } from '../../workbench/contextMenu/registry';
import {
  createCursorStore,
  isPlotChrome,
  type CursorStore,
  type ProjectionStore,
} from '../../plot/geometry';
import type { DrawingCommand } from '../keys';
import { quantizePointIn, type Annotation } from '../model';
import { appendCommitIn, seedDrawingIn, type Anchor } from '../tools';
import { routeDrawingKey } from './hostKeys';
import type { ShedSnapshot } from './shedStore';
import type { DrawingDocument } from './useDrawingDocument';

/** The slice of a chart instance the host drives: the tooltip follows the pointer. */
export interface ChartTipTarget {
  dispatchAction(action: { type: 'showTip'; x: number; y: number }): void;
}

/** Where a plot menu opens: wrapper-local px, viewport px of the wrapper's document, a portal node. */
export interface PlotMenuAt {
  localX: number;
  localY: number;
  clientX: number;
  clientY: number;
  /** Portal target: the wrapper's `ownerDocument.body`; the global document's body when absent. */
  target?: Element;
}

/** What the plot hands its drawing parts. */
export interface DrawingHandle {
  /** Acts on a drawing command (arm, cancel, delete); true when it was consumed. */
  handleDrawingKey(cmd: DrawingCommand<string>): boolean;
  /** True when the overlay owns this press (armed tool, live gesture, a drawing hit). */
  claimsPointer(e: PointerEvent | MouseEvent): boolean;
  /** Starts the catalog's modifier gesture (shift-measure) at this press, when it has one. */
  beginModifierGesture(e: PointerEvent): void;
  /** Opens the plot context menu at `at`. */
  openPlotMenu(at: PlotMenuAt): void;
}

/** The plot menu's open state, an external store so opening it re-renders only the menu. */
export interface PlotMenuStore {
  get(): PlotMenuAt | null;
  set(at: PlotMenuAt | null): void;
  subscribe(cb: () => void): () => void;
}

/** The host every part takes: the handle and what the parts read. */
export interface DrawingHost extends DrawingHandle {
  config: HostConfig;
  document: DrawingDocument;
  projectionStore: ProjectionStore;
  cursorStore: CursorStore;
  axes: AnnotationLayerProps['axes'];
  theme: AnnotationLayerTheme;
  /** Receives the layer's {@link OverlayHandle}; `<DrawingLayers>` binds it. */
  overlayRef: RefObject<OverlayHandle | null>;
  /** Forwards the pointer to the chart's tooltip (wrapper-local px). */
  showTip(x: number, y: number): void;
  menu: PlotMenuStore;
}

export interface DrawingHostOptions {
  /** The plot's visible Y axes; the first is the primary one. */
  axes: AnnotationLayerProps['axes'];
  theme: AnnotationLayerTheme;
  /** The chart getter (showTip); read at call time, never captured. */
  chart?: () => ChartTipTarget | null | undefined;
  /** The plot's cursor store (the status line's readout); the host makes one when absent. */
  cursorStore?: CursorStore;
}

function createPlotMenuStore(): PlotMenuStore {
  let at: PlotMenuAt | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => at,
    set(next) {
      if (next === at) return;
      at = next;
      for (const cb of [...listeners]) cb();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

/** `make`, called at most once: the first call's result on every call. */
function once<T>(make: () => T): () => T {
  let made: { value: T } | undefined;
  return () => (made ??= { value: make() }).value;
}

/**
 * The drawing host of one plot. `config` is the plot's memoized
 * {@link HostConfig}, `document` its {@link DrawingDocument}.
 */
export function useDrawingHost(
  config: HostConfig,
  document: DrawingDocument,
  projectionStore: ProjectionStore,
  options: DrawingHostOptions
): DrawingHost {
  const { axes, theme, chart, cursorStore: cursorProp } = options;
  const overlayRef = useRef<OverlayHandle | null>(null);
  // The hook's own cursor store, made on first need: never while the plot
  // passes one (Trace does), and the same one should the prop come and go.
  const [ownCursor] = useState(() => once(createCursorStore));
  const [menu] = useState(createPlotMenuStore);
  const cursorStore = cursorProp ?? ownCursor();
  // The latest inputs for the handle's methods; mirrored after each commit,
  // before any event can reach them.
  const latest = useRef({ config, document, chart });
  useLayoutEffect(() => {
    latest.current = { config, document, chart };
  });

  const handle = useMemo<DrawingHandle & Pick<DrawingHost, 'showTip'>>(
    () => ({
      handleDrawingKey(cmd) {
        if (cmd.kind === 'arm') {
          const { config: cfg, document: doc } = latest.current;
          if (!cfg.catalog.byKind(cmd.tool)) return false;
          doc.setPrefs({ tool: cmd.tool });
          return true;
        }
        return overlayRef.current?.key(cmd.kind).consumed ?? false;
      },
      claimsPointer(e) {
        return overlayRef.current?.claimsPointer(e) ?? false;
      },
      beginModifierGesture(e) {
        const tools = latest.current.config.catalog.tools;
        if (!tools.some((t) => t.modifierGesture === 'shift')) return;
        overlayRef.current?.beginMeasure(e);
      },
      openPlotMenu(at) {
        menu.set({ ...at });
      },
      showTip(x, y) {
        latest.current.chart?.()?.dispatchAction({ type: 'showTip', x, y });
      },
    }),
    [menu]
  );

  return useMemo<DrawingHost>(
    () => ({
      ...handle,
      config,
      document,
      projectionStore,
      cursorStore,
      axes,
      theme,
      overlayRef,
      menu,
    }),
    [handle, config, document, projectionStore, cursorStore, axes, theme, menu]
  );
}

// ---------------------------------------------------------------- notice --

/**
 * The status-line notice for what the last link shed: "N drawings not
 * saved in the link" while drawings were dropped, else "Note text shortened in
 * the link" when only note text was trimmed; null when nothing was shed.
 */
export function shedNoticeOf(shed: ShedSnapshot): string | null {
  if (shed.dropped > 0) {
    return `${shed.dropped} ${shed.dropped === 1 ? 'drawing' : 'drawings'} not saved in the link`;
  }
  if (shed.trimmed > 0) return 'Note text shortened in the link';
  return null;
}

// ------------------------------------------------------------------ menu --

/** One drawing entry of the plot menu. */
export interface DrawingMenuEntry {
  kind: string;
  label: string;
  /** True when the clicked point places nothing (no grid, no owner axis, off-scale). */
  disabled: boolean;
  /** Adds the drawing at the clicked point and selects it. */
  select(): void;
}

/**
 * Where a drawing added from the menu at (`x`, `y`) lands: the magnet's sample
 * when the magnet is on and finds one (its own axis), else the clicked point
 * on the axis `ownerAxisAt` names, read through that axis's grid. Null when
 * the point is in no grid, the owner is null, or the point is off-scale.
 */
function anchorAt(host: DrawingHost, x: number, y: number): Anchor | null {
  const { config, document: doc, projectionStore } = host;
  const proj = projectionStore.get();
  if (!proj) return null;
  const grid = proj.gridAt(x, y);
  if (!grid) return null;
  const snap = doc.prefs.magnet ? config.snap.snap(x, y, grid) : null;
  const owner = config.ownerAxisAt(x, y, snap);
  if (owner === null) return null;
  if (snap) {
    return {
      point: { t: snap.t, v: snap.v },
      snapped: true,
      axisId: snap.axisId,
      traceId: snap.traceId,
    };
  }
  const on = proj.gridOf(owner) ?? grid;
  const t = on.xToT(x);
  const v = on.yToV(y, owner);
  if (!Number.isFinite(t) || !Number.isFinite(v)) return null;
  return { point: { t, v }, snapped: false, axisId: owner };
}

/** The point a menu opened at: the nearest sample and the pointer in data units. */
function pointAt(host: DrawingHost, at: PlotMenuAt): PlotPoint {
  const proj = host.projectionStore.get();
  const grid = proj?.gridAt(at.localX, at.localY);
  if (!grid) return { at, hit: null, t: Number.NaN, v: Number.NaN };
  const hit = host.config.snap.snap(at.localX, at.localY, grid);
  const axis = grid.axisIds[0];
  return {
    at,
    hit,
    t: grid.xToT(at.localX),
    v: axis === undefined ? Number.NaN : grid.yToV(at.localY, axis),
  };
}

/** The drawing entries of the plot menu opened at (`x`, `y`), in rail order. */
export function drawingMenuEntriesAt(host: DrawingHost, x: number, y: number): DrawingMenuEntry[] {
  const { config } = host;
  const anchor = anchorAt(host, x, y);
  return config.catalog.tools.flatMap((tool) => {
    if (!tool.menuAdd) return [];
    return [
      {
        kind: tool.kind,
        label: tool.menuAdd.label,
        disabled: anchor === null,
        select() {
          // Re-read at the choice: the projection may have moved since the open.
          const now = anchorAt(host, x, y);
          if (!now) return;
          const proj = host.projectionStore.get();
          const grid = proj ? (proj.gridOf(now.axisId) ?? proj.gridAt(x, y)) : undefined;
          const step = grid ? Math.abs(grid.xToT(x + 1) - grid.xToT(x)) : 0;
          const point = quantizePointIn(
            config.xAxis,
            now.point,
            now.snapped,
            Number.isFinite(step) ? step : 0
          );
          const drawing: Annotation = {
            ...seedDrawingIn(config.catalog, tool.kind, { ...now, point }),
            id: makeAnnotationId(),
          };
          const commit = appendCommitIn(config.catalog, drawing);
          host.document.commit(commit.fn, commit.label);
          host.document.select(drawing.id);
        },
      },
    ];
  });
}

/** A right-click in the plot, as the plot's `point` reads it. */
export interface PlotPoint {
  at: PlotMenuAt;
  /** The sample nearest the pointer (whatever the magnet), or null when none is near. */
  hit: SnapHit | null;
  /** The pointer's x, in the plot's x units; NaN outside a grid. */
  t: number;
  /** The pointer's y on the primary axis of its grid; NaN outside a grid. */
  v: number;
}

/** What the plot puts in its point menu: the curve under the pointer, the reading, its writers. */
export interface PointMenu {
  signals: MenuSignal[];
  reading?: { header: string; text: string };
  writers?: ContextMenuWriters;
}

export interface DrawingPlotMenuOptions {
  /**
   * The point menu's request and writers, read when it opens. The drawing
   * entries join as "Add … here".
   */
  point?(p: PlotPoint): PointMenu;
}

/**
 * The plot context menu: a right-click in a grid (through `openPlotMenu`)
 * opens the workbench's shared right-click menu with the plot's `point`
 * request, and the catalog's add entries at the clicked point join it as
 * "Add … here". Every plot tool renders inside the workbench, whose
 * `ContextMenuProvider` hosts the menu; without that provider a right-click
 * opens nothing.
 */
export function useDrawingPlotMenu(host: DrawingHost, own: DrawingPlotMenuOptions = {}): void {
  const { menu } = host;
  const at = useSyncExternalStore(menu.subscribe, menu.get, menu.get);
  const menus = useContextMenu();
  const pointRef = useRef(own.point);
  useLayoutEffect(() => {
    pointRef.current = own.point;
  });
  useEffect(() => {
    if (at === null) return;
    menu.set(null);
    if (menus === null) return;
    const entries = drawingMenuEntriesAt(host, at.localX, at.localY);
    const p = pointAt(host, at);
    const spec = pointRef.current?.(p) ?? { signals: [] };
    menus.open(
      { scope: 'point', signals: spec.signals, reading: spec.reading },
      { x: at.clientX, y: at.clientY, target: at.target },
      {
        ...spec.writers,
        addHere: () =>
          entries.map((en) => ({
            label: en.label,
            disabled: en.disabled ? 'Not on a plotted axis here' : false,
            run: () => en.select(),
          })),
      }
    );
  }, [at, menus, menu, host]);
}

// ------------------------------------------------------------- listeners --

/**
 * The wrapper listeners for a plot without its own: the wrapper becomes
 * focusable (`tabIndex=-1` unless it has a tabindex) and takes focus on
 * pointerdown with `preventScroll`; keydown routes through the handle and is
 * claimed only when consumed; a shift+press inside a grid starts the modifier
 * gesture; a right-click inside a grid opens the plot menu; the pointer feeds
 * the cursor store. Plot chrome (rail, badges, status line) is left alone.
 */
export function useDrawingWrapperListeners(
  wrapRef: RefObject<HTMLElement | null>,
  host: DrawingHost
): void {
  const hostRef = useRef(host);
  useLayoutEffect(() => {
    hostRef.current = host;
  });
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (!wrap.hasAttribute('tabindex')) wrap.tabIndex = -1;
    const toLocal = (e: { clientX: number; clientY: number }) => {
      const r = wrap.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const inGrid = (x: number, y: number): boolean => {
      const proj = hostRef.current.projectionStore.get();
      return proj?.gridAt(x, y) !== undefined;
    };
    const onPointerDownFocus = () => {
      if (wrap.ownerDocument.activeElement === wrap) return;
      wrap.focus({ preventScroll: true });
    };
    const onPointerDownModifier = (e: PointerEvent) => {
      if (!e.shiftKey || e.button !== 0 || isPlotChrome(e.target)) return;
      const { x, y } = toLocal(e);
      if (inGrid(x, y)) hostRef.current.beginModifierGesture(e);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const h = hostRef.current;
      routeDrawingKey(h.config.catalog, e, h.handleDrawingKey);
    };
    const onContextMenu = (e: MouseEvent) => {
      if (isPlotChrome(e.target)) return;
      const { x, y } = toLocal(e);
      if (!inGrid(x, y)) return;
      e.preventDefault();
      hostRef.current.openPlotMenu({
        localX: x,
        localY: y,
        clientX: e.clientX,
        clientY: e.clientY,
        target: wrap.ownerDocument.body,
      });
    };
    const onMouseMove = (e: MouseEvent) => hostRef.current.cursorStore.set(toLocal(e));
    const onMouseLeave = () => hostRef.current.cursorStore.set(null);
    wrap.addEventListener('pointerdown', onPointerDownFocus);
    wrap.addEventListener('pointerdown', onPointerDownModifier);
    wrap.addEventListener('keydown', onKeyDown);
    wrap.addEventListener('contextmenu', onContextMenu);
    wrap.addEventListener('mousemove', onMouseMove);
    wrap.addEventListener('mouseleave', onMouseLeave);
    return () => {
      wrap.removeEventListener('pointerdown', onPointerDownFocus);
      wrap.removeEventListener('pointerdown', onPointerDownModifier);
      wrap.removeEventListener('keydown', onKeyDown);
      wrap.removeEventListener('contextmenu', onContextMenu);
      wrap.removeEventListener('mousemove', onMouseMove);
      wrap.removeEventListener('mouseleave', onMouseLeave);
    };
  }, [wrapRef]);
}
