// The workbench Sidebar: one pane, the plot's properties, beside the canvas.
//
// The pane has a slim header (its title and a collapse button). Collapsed,
// the sidebar is a 32 px rail whose one target expands it again. A user
// selection (selection.ts) expands a collapsed sidebar without writing.
//
// Persistence: the arrangement store keeps the collapsed flag and the width.
// Only a deliberate gesture writes; a reveal, a tile resize or a clamped
// re-expand never does.
//
// Resizing. The sidebar sits in a horizontal react-resizable-panels
// group beside the canvas (`children`):
//
// - The design default (300 px, min 220 px, max 60 %) is the panel's
//   `defaultSize`, so the library's own separator double-click is the reset.
// - The page's own width (read once from the store) is applied after mount
//   through the panel ref, without writing.
// - The sidebar keeps its px width when the group resizes
//   (`preserve-pixel-size`); the page's own width is re-applied, clamped by
//   the library and without writing, on re-expand from the rail and whenever
//   the tile widens.
// - The width is written only from a pointer-armed resize: a pointerdown the
//   library takes (or one on our separator) arms; every pointerup or
//   pointercancel clears the arm in a frame after the library's commit. Only
//   a value that changed since the arm is written, so a click on the
//   separator writes nothing.
//
// Without ResizeObserver (old engines, bare jsdom) the library cannot run, and
// the sidebar falls back to a fixed-width layout.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { SidePanelClose } from '@carbon/icons-react';
import {
  Group,
  Panel,
  Separator,
  useGroupRef,
  usePanelRef,
  type Layout,
} from 'react-resizable-panels';

import {
  DEFAULT_WIDTH_PX,
  MIN_WIDTH_PX,
  createArrangementStore,
  type ArrangementStore,
} from './arrangementStore';
import { useRevealRequest } from './selection';

/** The design defaults: the library's double-click resets to these. */
export const SIDEBAR_DEFAULT_SIZE = `${DEFAULT_WIDTH_PX}px`;
export const SIDEBAR_MIN_SIZE = `${MIN_WIDTH_PX}px`;
export const SIDEBAR_MAX_SIZE = '60%';

/** The pane's title, on its header and on the rail. */
export const SIDEBAR_TITLE = 'Properties';

function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** react-resizable-panels needs ResizeObserver; without it the layout is fixed. */
function canResize(): boolean {
  return typeof globalThis.ResizeObserver === 'function';
}

/** The px the library splits among a group's panels (separators excluded). */
function panelsExtent(group: HTMLElement | null): number {
  if (!group) return 0;
  let sum = 0;
  for (const child of Array.from(group.children)) {
    if (!(child instanceof HTMLElement) || !child.hasAttribute('data-panel')) continue;
    sum += child.offsetWidth;
  }
  return sum;
}

/** Run callbacks in the next animation frame; pending frames die with the component. */
function useFrames() {
  const pending = useRef(new Set<number>());
  useEffect(() => {
    const frames = pending.current;
    return () => {
      frames.forEach((id) => cancelAnimationFrame(id));
      frames.clear();
    };
  }, []);
  return useCallback((fn: () => void) => {
    const id = requestAnimationFrame(() => {
      pending.current.delete(id);
      fn();
    });
    pending.current.add(id);
  }, []);
}

/**
 * The resize arm: set by a pointerdown that starts a resize, cleared on every
 * pointerup/pointercancel in the frame after the library's commit (the library
 * commits on the pointerup itself, and its double-click reset follows the
 * second pointerup before that frame).
 */
function useResizeArm(onArm: () => void) {
  const armedRef = useRef(false);
  const clearFrameRef = useRef<number | null>(null);
  const onArmRef = useRef(onArm);
  useEffect(() => {
    onArmRef.current = onArm;
  });

  useEffect(() => {
    const disarm = () => {
      if (clearFrameRef.current !== null) cancelAnimationFrame(clearFrameRef.current);
      clearFrameRef.current = requestAnimationFrame(() => {
        clearFrameRef.current = null;
        armedRef.current = false;
      });
    };
    window.addEventListener('pointerup', disarm, true);
    window.addEventListener('pointercancel', disarm, true);
    return () => {
      window.removeEventListener('pointerup', disarm, true);
      window.removeEventListener('pointercancel', disarm, true);
      if (clearFrameRef.current !== null) cancelAnimationFrame(clearFrameRef.current);
      clearFrameRef.current = null;
    };
  }, []);

  /** On the group: the library's document-capture pointerdown has already run. */
  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const target = e.target instanceof Element ? e.target : null;
    // The library prevents the default of a pointerdown it takes as a resize
    // (its hit area is wider than the separator element itself).
    if (!e.defaultPrevented && !target?.closest('.wb-split__edge')) return;
    if (clearFrameRef.current !== null) {
      cancelAnimationFrame(clearFrameRef.current);
      clearFrameRef.current = null;
    }
    armedRef.current = true;
    onArmRef.current();
  }, []);

  return { armedRef, onPointerDown };
}

export interface SidebarProps {
  /** The pane's content: the properties panel. */
  children: ReactNode;
  /** The page's arrangement store; when absent the Sidebar creates and connects its own. */
  store?: ArrangementStore;
  /** The canvas beside the sidebar; the resizable edge sits between the two. */
  canvas?: ReactNode;
}

/** The given store, or one created (and connected) for this mount. */
function useStore(given: ArrangementStore | undefined): ArrangementStore {
  const [own] = useState(() => (given ? null : createArrangementStore()));
  useEffect(() => (own ? own.connect() : undefined), [own]);
  return given ?? (own as ArrangementStore);
}

export function Sidebar({ children, store: givenStore, canvas }: SidebarProps) {
  const store = useStore(givenStore);
  const [rail, setRail] = useState(() => store.initial.collapsed);
  const railRef = useRef(rail);

  const baseId = useId();
  const sideId = `${baseId}-side`;
  const canvasId = `${baseId}-canvas`;
  const titleId = `${baseId}-title`;

  /** Show the rail or the pane; when `persist`, write it. */
  const showRail = useCallback(
    (next: boolean, persist: boolean) => {
      if (railRef.current === next) return;
      railRef.current = next;
      setRail(next);
      if (persist) store.write({ collapsed: next });
    },
    [store]
  );

  // A user selection reveals the pane; never written.
  useRevealRequest(() => showRail(false, false));

  // ----------------------------------------------------------- resizing --

  const [resizable] = useState(canResize);
  const sideRef = usePanelRef();
  const widthGroupRef = useGroupRef();
  const widthGroupElRef = useRef<HTMLDivElement | null>(null);
  /** The page's own width: read once, then only what this page's gestures wrote. */
  const pageWidthRef = useRef(store.initial.widthPx);
  /** What was shown when the arm was set; only a change from it is written. */
  const armedWidthRef = useRef<number | null>(null);
  const frame = useFrames();

  const shownWidthPx = (): number | null => {
    const pct = widthGroupRef.current?.getLayout()[sideId];
    if (pct === undefined) return null;
    return Math.round((pct / 100) * panelsExtent(widthGroupElRef.current));
  };

  const arm = useResizeArm(() => {
    armedWidthRef.current = shownWidthPx();
  });

  /** Re-apply the page's own width (the library clamps it); never written. */
  const applyWidth = () => {
    if (railRef.current) return;
    if (panelsExtent(widthGroupElRef.current) === 0) return;
    sideRef.current?.resize(`${pageWidthRef.current}px`);
  };
  const applyRef = useRef(applyWidth);
  useEffect(() => {
    applyRef.current = applyWidth;
  });

  const onWidthLayoutChanged = (layout: Layout) => {
    if (!arm.armedRef.current || railRef.current) return;
    const pct = layout[sideId];
    if (pct === undefined) return;
    const extent = panelsExtent(widthGroupElRef.current);
    if (extent === 0) return;
    const px = Math.max(MIN_WIDTH_PX, Math.round((pct / 100) * extent));
    if (px === armedWidthRef.current) return;
    armedWidthRef.current = px;
    pageWidthRef.current = px;
    store.write({ widthPx: px });
  };

  // Once after mount: the page's own width (no write).
  useEffect(() => {
    if (resizable) frame(() => applyRef.current());
  }, [resizable, frame]);

  // Re-expand from the rail re-applies the page's width, clamped (no write).
  const wasRailRef = useRef(rail);
  useEffect(() => {
    const wasRail = wasRailRef.current;
    wasRailRef.current = rail;
    if (resizable && wasRail && !rail) frame(() => applyRef.current());
  }, [rail, resizable, frame]);

  // The tile widens: re-apply the page's width, after the library has taken
  // the new size (no write).
  useEffect(() => {
    const el = widthGroupElRef.current;
    if (!resizable || !el) return;
    let last = 0;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        if (width > last) frame(() => applyRef.current());
        last = width;
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [resizable, frame]);

  // ------------------------------------------------------------- render --

  const sidebar = (
    <div className={cls('wb-sidebar', rail && 'wb-sidebar--collapsed')}>
      {rail && (
        <div className="wb-sidebar__rail" role="toolbar" aria-orientation="vertical">
          <button
            type="button"
            className="wb-sidebar__rail-target"
            data-pane="properties"
            aria-label={`Expand ${SIDEBAR_TITLE}`}
            title={`Expand ${SIDEBAR_TITLE}`}
            onClick={() => showRail(false, true)}
          >
            <span className="wb-sidebar__rail-label">{SIDEBAR_TITLE}</span>
          </button>
        </div>
      )}
      <section
        className="wb-sidebar__pane wb-sidebar__pane--properties"
        data-pane="properties"
        aria-labelledby={titleId}
        hidden={rail}
      >
        <div className="wb-sidebar__header">
          <h2 id={titleId} className="wb-sidebar__title">
            {SIDEBAR_TITLE}
          </h2>
          <button
            type="button"
            className="wb-sidebar__collapse"
            aria-label={`Collapse ${SIDEBAR_TITLE}`}
            title={`Collapse ${SIDEBAR_TITLE}`}
            onClick={() => showRail(true, true)}
          >
            <SidePanelClose size={16} />
          </button>
        </div>
        <div className="wb-sidebar__content">{children}</div>
      </section>
    </div>
  );

  return resizable ? (
    <Group
      orientation="horizontal"
      className="wb-split"
      elementRef={widthGroupElRef}
      groupRef={widthGroupRef}
      onLayoutChanged={onWidthLayoutChanged}
      onPointerDown={arm.onPointerDown}
      data-wb-rail={rail || undefined}
    >
      <Panel
        id={sideId}
        panelRef={sideRef}
        defaultSize={SIDEBAR_DEFAULT_SIZE}
        minSize={SIDEBAR_MIN_SIZE}
        maxSize={SIDEBAR_MAX_SIZE}
        groupResizeBehavior="preserve-pixel-size"
        className="wb-split__slot"
        style={{ overflow: 'hidden' }}
        data-wb-slot="sidebar"
      >
        {sidebar}
      </Panel>
      <Separator className="wb-split__edge" aria-label="Resize sidebar" disabled={rail} />
      <Panel id={canvasId} className="wb-split__slot" data-wb-slot="canvas">
        {canvas}
      </Panel>
    </Group>
  ) : (
    <div className="wb-split wb-split--static">
      <div className="wb-split__side">{sidebar}</div>
      {canvas !== undefined && <div className="wb-split__canvas">{canvas}</div>}
    </div>
  );
}
