// Annotation layer: the drawings of one plot, rendered through its catalog.
//
// One absolutely positioned <svg data-annotation-layer> per grid of the
// projection (`grids`), each at its grid's rect and mounted inside the plot
// wrapper after the chart. A drawing renders in the grid of its axis through
// its tool's `geometry` and `Shape` (the plot's catalog, Trace's built-ins by
// default); the layer adds the selection outline, hit targets, handles, lock
// glyph and measure card around it.
//
// Coordinates are the projection's wrapper-local pixels: each svg sits at its
// grid's origin, so one inner <g> translates by -gridRect.left/-top and the
// svg's own box clips everything to the grid.
//
// Visibility rules:
//   - `annotationsHidden` (hide all) renders no drawing at all;
//   - `a.hidden` drawings, and those the host's `hiddenReason` names a reason
//     for, are not rendered; nor is a kind the catalog does not offer;
//   - a value-axis tool draws only in the grid holding its axis, and its
//     geometry is null off the visible axes or at a non-finite y;
//     x-only tools (vline, trange) fall back to grid 0 and always render.
// A drawing stored in `ink` is drawn in the theme's ink. Selected drawings get
// a faint selection halo, small handles (each with a larger transparent grab
// target) and the style chip (`StylePanel`); locked ones never get handles or
// the chip and show a lock glyph instead. A `draft` renders at 0.8 opacity.
//
// The roots take no pointer events; only the transparent hit paths
// (`pointer-events: stroke`) and hit rects (`pointer-events: fill`) do, so the
// input half can claim presses through `[data-annotation-id]`. Attributes are
// explicit (no CSS classes) so the PNG capture can compose each svg as is.
//
// Input half. Pointer Events on the svg roots drive `reduceToolsIn`
// over the plot's catalog and x axis, with the overlay-local `GestureState` (a
// `useReducer` whose value is mirrored in a ref, updated synchronously with
// each dispatch). The reducer runs in the event handlers and its `commit` /
// `select` / `prefs` are forwarded from there, never from a state updater
//; a gesture commits once, on pointerup. A pointer projects
// through the grid under it; a live gesture keeps projecting through the grid
// it started in. A new drawing's axis comes from the host's `ownerAxisAt`
// (null places nothing); a snap hit on another grid is re-expressed through
// the hit's own grid. The roots take `pointer-events: all` only while a
// tool is armed or a gesture is live (a shift-measure begun from the wrapper
// included); while they cover the canvas, and on the drawings' hit targets in
// cursor mode, mousemove forwards `showTip` so the crosshair and tooltip keep
// following. The `OverlayHandle` (claimsPointer / beginMeasure / key) answers
// from the ref mirror, so a claim made on pointerdown is seen by the mousedown
// that follows.
//
// No colour literals here (src/annotations is literal-guarded): strokes come
// from each drawing's stored colour and the chart theme.
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import {
  inRect,
  useProjection,
  type Projection,
  type ProjectionStore,
  type SnapHit,
} from '../plot/geometry';
import { annotationPaint } from '../annotationTheme';
import {
  DRAFT_OPACITY,
  HANDLE_R,
  HANDLE_STROKE,
  OUTLINE_EXTRA,
  OUTLINE_OPACITY,
} from './catalog/shapeKit';
import { MeasureReadout, type CardSource } from './MeasureReadout';
import { NoteEditor } from './NoteEditor';
import { StylePanel } from './StylePanel';
import type {
  AxisRef,
  DrawingTheme,
  DrawingTool,
  FrameStore,
  GeometryContext,
  GridProjection,
  HostConfig,
  MeasureProvider,
} from './catalog/types';
import { MAX_ANNOTATION_TEXT, withStyle, type Annotation } from './model';
import {
  DEFAULT_TOOL_PREFS,
  EMPTY_GESTURE,
  hasGesture,
  hasInlineTextIn,
  isLive,
  NO_HIT,
  reduceToolsIn,
  type AnnotationToolPrefs,
  type GestureState,
  type ToolEvent,
  type ToolHit,
  type ToolPoint,
  type ToolsResult,
} from './tools';

/** The theme slice the layer reads; a `ChartTheme` satisfies it. */
export type AnnotationLayerTheme = DrawingTheme;

/**
 * The slice of a plot's {@link HostConfig} the layer reads. The catalog and
 * the x axis are required; any other absent field takes the neutral default
 * (no magnet, an empty measure card, no frame store, the primary axis as
 * owner, nothing hidden).
 */
export type DrawingLayerConfig = Pick<
  HostConfig,
  'catalog' | 'xAxis' | 'snap' | 'measure' | 'frames' | 'ownerAxisAt' | 'hiddenReason' | 'swatches'
>;

export interface AnnotationLayerProps {
  projectionStore: ProjectionStore;
  annotations: readonly Annotation[];
  /** The plot's visible axes: a v-bearing drawing on any other axis is skipped. */
  axes: readonly (Pick<AxisRef, 'id'> & Partial<Pick<AxisRef, 'name' | 'units' | 'unitLabel'>>)[];
  theme: AnnotationLayerTheme;
  /** Hide all drawings (and the draft). */
  annotationsHidden?: boolean;
  selectedId?: string | null;
  /**
   * A drawing rendered as the draft. Absent, the overlay's own gesture draft
   * (the drawing being placed, moved or measured) is shown.
   */
  draft?: Annotation | null;
  /** This plot's drawing-tool prefs (TraceApp's, keyed by plot). */
  prefs?: AnnotationToolPrefs;
  /** Patches this plot's tool prefs (e.g. back to cursor after a commit). */
  onPrefs?: (patch: Partial<AnnotationToolPrefs>) => void;
  /** Applies one gesture's edit to the plot's drawing list (TraceApp `update` + `withAnnotations`). */
  onCommit?: (fn: (list: Annotation[]) => Annotation[], label: string) => void;
  /** Selects a drawing (`null` = none). */
  onSelectAnnotation?: (id: string | null) => void;
  /** Forwards the cursor to the chart (`dispatchAction({type:'showTip', x, y})`), wrapper-local px. */
  showTip?: (x: number, y: number) => void;
  /** Receives the {@link OverlayHandle} (SinglePlot's `overlayRef`). */
  overlayRef?: Ref<OverlayHandle>;
  /** The host's drawing config; see {@link DrawingLayerConfig}. */
  config: Pick<DrawingLayerConfig, 'catalog' | 'xAxis'> & Partial<DrawingLayerConfig>;
}

/**
 * What the drawing overlay exposes to its plot. Every answer
 * comes from the gesture's ref mirror, so it holds within the same event.
 */
export interface OverlayHandle {
  /** True when the overlay owns this press (armed tool, live gesture or measure, a drawing hit). */
  claimsPointer(e: PointerEvent | MouseEvent): boolean;
  /** Start a shift-measure at this press: the root takes the pointer and captures it. */
  beginMeasure(e: PointerEvent): void;
  key(cmd: 'cancel' | 'delete'): { consumed: boolean };
}

/** A frame store that never bumps (Trace: the card follows the layer's own renders). */
const NO_FRAMES: FrameStore = Object.freeze({
  subscribe: () => () => {},
  getVersion: () => 0,
});

const NEVER_HIDDEN = (): string | null => null;

/** The measure card without a host provider: no rows. */
const NO_MEASURE: MeasureProvider = Object.freeze({ card: () => [] });

/** The layer's grids: the projection's, each holding only the visible axes. */
function layerGridsOf(proj: Projection, axes: AnnotationLayerProps['axes']): GridProjection[] {
  const visible = axes.map((ax) => ax.id);
  return proj.grids.map((g) => ({
    ...g,
    axisIds: g.axisIds.filter((id) => visible.includes(id)),
  }));
}

/** Index of the grid drawing `axisId`, or -1. */
function gridIndexOfAxis(grids: readonly GridProjection[], axisId: string): number {
  return grids.findIndex((g) => g.axisIds.includes(axisId));
}

/**
 * The grid a drawing renders in: its axis's; an x-only tool whose axis no grid
 * draws falls back to grid 0; -1 skips the drawing.
 */
function drawingGridIndex(
  def: DrawingTool,
  a: Annotation,
  grids: readonly GridProjection[]
): number {
  const i = gridIndexOfAxis(grids, a.axisId);
  if (i >= 0) return i;
  return def.axes === 'x' && grids.length > 0 ? 0 : -1;
}

/** A small padlock centred at (x, y), in the drawing's colour. */
function LockGlyph({ x, y, color, bg }: { x: number; y: number; color: string; bg: string }) {
  return (
    <g transform={`translate(${x + 8} ${y - 10})`} pointerEvents="none" data-annotation-lock="">
      <path
        d="M-2.5 -1V-3.5A2.5 2.5 0 0 1 2.5 -3.5V-1"
        fill="none"
        stroke={color}
        strokeWidth={1.2}
      />
      <rect x={-4} y={-1} width={8} height={6} rx={1} fill={color} stroke={bg} strokeWidth={0.5} />
    </g>
  );
}

/** Radius of a handle's transparent grab target: easier to hit than the small dot it covers. */
const HANDLE_HIT_R = 7;

/** `a` with its colour as drawn: the theme's ink for `ink`. */
function painted(a: Annotation, theme: AnnotationLayerTheme): Annotation {
  const color = annotationPaint(a.color, theme.annotation);
  return color === a.color ? a : { ...a, color };
}

function Drawing({
  a,
  def,
  grid,
  ctx,
  theme,
  selected,
  draft,
  card,
}: {
  a: Annotation;
  def: DrawingTool;
  grid: GridProjection;
  ctx: GeometryContext;
  theme: AnnotationLayerTheme;
  selected: boolean;
  draft: boolean;
  card?: CardSource;
}) {
  const shown = painted(a, theme);
  const geo = def.geometry(shown, grid, ctx);
  if (!geo) return null;
  const locked = a.locked === true;
  const Shape = def.Shape;
  return (
    <g
      data-annotation-id={a.id}
      data-annotation-kind={a.kind}
      data-annotation-selected={selected ? 'true' : undefined}
      data-annotation-locked={locked ? 'true' : undefined}
      data-annotation-draft={draft ? 'true' : undefined}
      opacity={draft ? DRAFT_OPACITY : undefined}
    >
      {selected &&
        geo.outline.map((d, i) => (
          <path
            key={`o${i}`}
            d={d}
            fill="none"
            stroke={theme.annotation.selection}
            strokeWidth={a.width + OUTLINE_EXTRA}
            strokeOpacity={OUTLINE_OPACITY}
            strokeLinejoin="round"
            pointerEvents="none"
            data-annotation-selection=""
          />
        ))}
      <Shape annotation={shown} geometry={geo} />
      {!draft && geo.hits}
      {selected &&
        !locked &&
        geo.handles.map(([x, y], i) => (
          <g key={`h${i}`} data-handle={i}>
            <circle
              cx={x}
              cy={y}
              r={HANDLE_R}
              fill={theme.annotation.handle}
              stroke={shown.color}
              strokeWidth={HANDLE_STROKE}
              pointerEvents="none"
            />
            <circle cx={x} cy={y} r={HANDLE_HIT_R} fill="transparent" pointerEvents="all" />
          </g>
        ))}
      {locked && (
        <LockGlyph x={geo.lockAt[0]} y={geo.lockAt[1]} color={shown.color} bg={theme.bg} />
      )}
      {card && def.card && (
        <MeasureReadout
          a={shown}
          def={def}
          source={card}
          handles={geo.handles}
          grid={grid.gridRect}
          theme={theme}
          grip={selected && !draft}
        />
      )}
    </g>
  );
}

/** The readout grip an event target sits in, or null. */
function gripOf(target: EventTarget | null): Element | null {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return null;
  return el.closest('[data-readout-grip]');
}

/** The drawing (and handle) under an event target, or none. */
function hitOf(target: EventTarget | null, annotations: readonly Annotation[]): ToolHit {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return NO_HIT;
  const g = el.closest('[data-annotation-id]');
  if (!g || g.getAttribute('data-annotation-draft') === 'true') return NO_HIT;
  const id = g.getAttribute('data-annotation-id');
  const annotation = annotations.find((a) => a.id === id);
  if (!annotation) return NO_HIT;
  const handle = el.closest('[data-handle]');
  if (handle && g.contains(handle)) {
    const index = Number(handle.getAttribute('data-handle'));
    if (Number.isInteger(index)) return { kind: 'handle', annotation, index };
  }
  return { kind: 'body', annotation };
}

/**
 * The Y axis a pointer projects onto: `fixed` keeps a drawing's own axis (a
 * second anchor, a dragged handle, a hit drawing); `owner` asks the host's
 * `ownerAxisAt` (a new drawing's first anchor), falling back to `fallback`
 * when it answers null — a null fallback places nothing.
 */
type PointAxis = { kind: 'fixed'; axisId: string } | { kind: 'owner'; fallback: string | null };

const gestureReducer = (_prev: GestureState, next: GestureState) => next;

/** True when the layer renders and takes input: a laid-out, non-empty grid and drawings shown. */
function isUsable(proj: Projection | null, hidden: boolean | undefined): proj is Projection {
  return !!proj && !hidden && proj.gridRect.width > 0 && proj.gridRect.height > 0;
}

export function AnnotationLayer(props: AnnotationLayerProps) {
  const {
    projectionStore,
    annotations,
    axes,
    theme,
    annotationsHidden,
    selectedId,
    draft: draftProp,
    prefs = DEFAULT_TOOL_PREFS,
    overlayRef,
    config,
  } = props;
  const { catalog, xAxis } = config;
  const proj = useProjection(projectionStore);
  const [gesture, setGesture] = useReducer(gestureReducer, EMPTY_GESTURE);
  // The ref mirror: written with every dispatch, read by the
  // handlers and the OverlayHandle so answers never wait for a re-render.
  const gestureRef = useRef<GestureState>(gesture);
  // One root per grid, in grid order.
  const rootsRef = useRef<(SVGSVGElement | null)[]>([]);
  // The root that holds the live gesture's pointer capture.
  const capturedRef = useRef<SVGSVGElement | null>(null);
  // The latest props for handlers and the imperative handle.
  // Mirrored after each commit, before any event can reach the handlers.
  const latest = useRef({ props, prefs, proj });
  useLayoutEffect(() => {
    latest.current = { props, prefs, proj };
  });
  // Native events beginMeasure already ran the reducer for (the root's own
  // listener sees the same press after the wrapper's).
  const [handled] = useState(() => new WeakSet<Event>());
  // The pointer that started the live gesture; other pointers never drive it.
  const pointerIdRef = useRef<number | null>(null);
  // The grid the live gesture started in: its points keep projecting there.
  const startGridRef = useRef<number | null>(null);
  // True only while that pointer's button is held. A 2-point tool's first
  // click leaves the gesture live between clicks ('await') with no button
  // down; the browser's lostpointercapture after that pointerup must not
  // cancel it.
  const pressedRef = useRef(false);
  // What the latest press on the layer hit. A press on a drawing captures the
  // pointer on the root, so the browser retargets the click and dblclick that
  // follow to the root; double-click falls back to this to find the note.
  const pressHitRef = useRef<ToolHit>(NO_HIT);
  // The note whose text is being typed in place, and the draft text. A note
  // just placed opens it (the reducer's `edit`); double-click reopens it.
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  // Each measure readout's drag offset from its default place, by drawing id,
  // and the grip drag in progress.
  const [readoutOffsets, setReadoutOffsets] = useState<
    Readonly<Record<string, readonly [number, number]>>
  >({});
  const gripRef = useRef<{
    id: string;
    pointerId: number;
    x: number;
    y: number;
    base: readonly [number, number];
  } | null>(null);

  const enabled = () => isUsable(latest.current.proj, latest.current.props.annotationsHidden);
  const catalogNow = () => latest.current.props.config.catalog;
  const gridsNow = (): GridProjection[] => {
    const p = latest.current.proj;
    return p ? layerGridsOf(p, latest.current.props.axes) : [];
  };

  // Wrapper-local px: the roots' parent is the plot wrapper (the projection's frame).
  const toLocal = (e: { clientX: number; clientY: number }) => {
    const frame = rootsRef.current.find((r) => r)?.parentElement;
    const r = frame?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  // The grid a pointer projects through: the live gesture's start grid, else
  // the grid under the pointer, else grid 0.
  const pointGrid = (grids: readonly GridProjection[], x: number, y: number): number => {
    const start = startGridRef.current;
    if (start !== null && start < grids.length && isLive(gestureRef.current)) return start;
    const under = grids.findIndex((g) => inRect(g.gridRect, x, y));
    return under >= 0 ? under : 0;
  };

  // Magnet: the nearest sample under the pointer, when
  // this plot's magnet is on, from the host's snap source (none without one). A `fixed` axis keeps the drawing's own axis: a
  // sample on another axis is re-expressed there at the same pixel — its y
  // from the hit's own grid, inverted on the drawing's axis in `grid`;
  // otherwise the anchor adopts the sample's curve and axis with its exact value.
  const snapAt = (
    x: number,
    y: number,
    grid: GridProjection,
    grids: readonly GridProjection[],
    fixedAxis: string | null
  ): SnapHit | null => {
    const { props: cur, prefs: pr } = latest.current;
    if (!pr.magnet) return null;
    const hit = cur.config.snap ? cur.config.snap.snap(x, y, grid) : null;
    if (!hit || fixedAxis === null || hit.axisId === fixedAxis) return hit;
    const hitGrid = grids[gridIndexOfAxis(grids, hit.axisId)] ?? grid;
    const v = grid.yToV(hitGrid.vToY(hit.v, hit.axisId), fixedAxis);
    return Number.isFinite(v) ? { ...hit, v, axisId: fixedAxis } : null;
  };

  /** The tool point at a pointer and the grid it projects through; null places nothing. */
  const pointAt = (
    e: { clientX: number; clientY: number },
    axis: PointAxis
  ): { pt: ToolPoint; grid: number } | null => {
    const { x, y } = toLocal(e);
    const grids = gridsNow();
    const gi = pointGrid(grids, x, y);
    const grid = grids[gi];
    if (!grid) return null;
    let axisId: string;
    let snap: SnapHit | null;
    if (axis.kind === 'fixed') {
      axisId = axis.axisId;
      snap = snapAt(x, y, grid, grids, axisId);
    } else {
      snap = snapAt(x, y, grid, grids, null);
      const cur = latest.current.props;
      const owner = cur.config.ownerAxisAt
        ? cur.config.ownerAxisAt(x, y, snap)
        : (cur.axes[0]?.id ?? null);
      const owned = owner ?? axis.fallback;
      if (owned === null) return null;
      axisId = owned;
    }
    const step = Math.abs(grid.xToT(x + 1) - grid.xToT(x));
    return {
      pt: {
        x,
        y,
        t: grid.xToT(x),
        v: grid.yToV(y, axisId),
        axisId,
        snap,
        pxStep: Number.isFinite(step) ? step : 0,
      },
      grid: gi,
    };
  };

  // The axis a pointer projects onto. A new drawing's first anchor (an armed
  // press, a shift-measure, a 1-point draft following the pointer) takes the
  // host's owner axis and is free to adopt a snapped curve's; otherwise the
  // dragged / drafted / hit drawing's axis is fixed.
  const axisFor = (g: GestureState, hit: ToolHit = NO_HIT, shift = false): PointAxis => {
    const primary = latest.current.props.axes[0]?.id ?? '';
    if (g.draft && !g.drag && catalogNow().byKind(g.draft.kind)?.arity === 2)
      return { kind: 'fixed', axisId: g.draft.axisId };
    if (g.drag) return { kind: 'fixed', axisId: g.drag.original.axisId };
    if (g.pending) return { kind: 'owner', fallback: g.draft?.axisId ?? primary };
    if (latest.current.prefs.tool !== 'cursor') return { kind: 'owner', fallback: null };
    if (hit.kind !== 'none') return { kind: 'fixed', axisId: hit.annotation.axisId };
    return { kind: 'owner', fallback: shift ? null : primary };
  };

  const run = (event: ToolEvent): ToolsResult => {
    const cfg = latest.current.props.config;
    const result = reduceToolsIn(
      { catalog: cfg.catalog, xAxis: cfg.xAxis },
      latest.current.prefs,
      gestureRef.current,
      event
    );
    if (result.gesture !== gestureRef.current) {
      gestureRef.current = result.gesture;
      setGesture(result.gesture);
    }
    const cur = latest.current.props;
    if (result.commit) cur.onCommit?.(result.commit.fn, result.commit.label);
    if (result.select !== undefined) cur.onSelectAnnotation?.(result.select);
    if (result.prefs) cur.onPrefs?.(result.prefs);
    if (result.edit) setEditing({ id: result.edit, text: '' });
    return result;
  };

  const capture = (pointerId: number, root: SVGSVGElement | null) => {
    if (!root) return;
    capturedRef.current = root;
    root.style.pointerEvents = 'all';
    try {
      root.setPointerCapture?.(pointerId);
    } catch {
      // An inactive pointer id (synthetic events) cannot be captured.
    }
  };

  const endLive = () => {
    pointerIdRef.current = null;
    startGridRef.current = null;
  };

  const press = (e: PointerEvent, shift: boolean, root: SVGSVGElement | null) => {
    if (e.button !== 0 || !enabled() || gripOf(e.target)) return;
    const hit = hitOf(e.target, latest.current.props.annotations);
    pressHitRef.current = hit;
    const before = gestureRef.current;
    const at = pointAt(e, axisFor(before, hit, shift));
    if (!at) return;
    run({ type: 'pointerDown', pt: at.pt, hit, shift });
    if (isLive(gestureRef.current)) {
      pointerIdRef.current = e.pointerId;
      if (startGridRef.current === null || !isLive(before)) startGridRef.current = at.grid;
      pressedRef.current = true;
      const roots = rootsRef.current;
      capture(e.pointerId, root ?? roots[at.grid] ?? roots.find((r) => r) ?? null);
    } else {
      endLive();
    }
  };
  // A move/up belongs to the live gesture only when it comes from its pointer.
  const ownsPointer = (e: { pointerId: number }) =>
    pointerIdRef.current === null || e.pointerId === pointerIdRef.current;

  const handle: OverlayHandle = {
    claimsPointer(e) {
      if (!enabled()) return false;
      if (latest.current.prefs.tool !== 'cursor') return true;
      if (isLive(gestureRef.current)) return true;
      return hitOf(e.target, latest.current.props.annotations).kind !== 'none';
    },
    beginMeasure(e) {
      handled.add(e);
      press(e, true, null);
    },
    key(cmd) {
      if (cmd === 'cancel') return { consumed: run({ type: 'cancel' }).consumed === true };
      const { annotations: list, selectedId: sel } = latest.current.props;
      const target = sel ? (list.find((a) => a.id === sel) ?? null) : null;
      return { consumed: run({ type: 'keyDelete', target }).consumed === true };
    },
  };
  useImperativeHandle(overlayRef, () => handle);

  // A press on a readout's grip drags the readout, never the measure.
  const startGripDrag = (e: ReactPointerEvent<SVGSVGElement>): boolean => {
    const grip = gripOf(e.target);
    if (!grip) return false;
    const id = grip.closest('[data-annotation-id]')?.getAttribute('data-annotation-id');
    if (e.button !== 0 || !id) return true;
    e.preventDefault();
    gripRef.current = {
      id,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      base: readoutOffsets[id] ?? [0, 0],
    };
    try {
      grip.setPointerCapture?.(e.pointerId);
    } catch {
      // An inactive pointer id (synthetic events) cannot be captured.
    }
    return true;
  };
  const moveGrip = (e: ReactPointerEvent<SVGSVGElement>): boolean => {
    const drag = gripRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return false;
    const next: [number, number] = [
      drag.base[0] + e.clientX - drag.x,
      drag.base[1] + e.clientY - drag.y,
    ];
    setReadoutOffsets((prev) => ({ ...prev, [drag.id]: next }));
    return true;
  };
  const endGrip = (e: { pointerId: number }): boolean => {
    const drag = gripRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return false;
    gripRef.current = null;
    return true;
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (handled.has(e.nativeEvent)) return;
    if (startGripDrag(e)) return;
    press(e.nativeEvent, e.shiftKey, e.currentTarget);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (moveGrip(e)) return;
    const g = gestureRef.current;
    if (!isLive(g) || !ownsPointer(e)) return;
    const at = pointAt(e, axisFor(g));
    if (at) run({ type: 'pointerMove', pt: at.pt });
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (endGrip(e)) return;
    const g = gestureRef.current;
    if (!isLive(g) || !ownsPointer(e)) return;
    pressedRef.current = false;
    const at = pointAt(e, axisFor(g));
    if (at) run({ type: 'pointerUp', pt: at.pt });
    else run({ type: 'cancel' });
    if (!isLive(gestureRef.current)) endLive();
    try {
      capturedRef.current?.releasePointerCapture?.(e.pointerId);
    } catch {
      // Not captured.
    }
  };
  const cancelLive = () => {
    endLive();
    pressedRef.current = false;
    if (hasGesture(gestureRef.current)) run({ type: 'cancel' });
  };
  const onPointerCancel = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (endGrip(e)) return;
    if (ownsPointer(e)) cancelLive();
  };
  // Capture lost while the button is held (window blur, an OS gesture): the
  // pointerup will never arrive, so end the gesture rather than leave the
  // root claiming. Every pointerup (and our explicit release) is followed by
  // a lostpointercapture too; pressedRef is already false by then, so a
  // 2-point tool awaiting its second click survives it.
  const onLostPointerCapture = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (endGrip(e)) return;
    if (pressedRef.current && isLive(gestureRef.current) && ownsPointer(e)) cancelLive();
  };
  // Hidden or a collapsed grid mid-gesture: the layer stops rendering, so
  // drop the gesture instead of resurfacing it as a stale commit later.
  const usable = isUsable(proj, annotationsHidden);
  useEffect(() => {
    if (usable) return;
    if (hasGesture(gestureRef.current)) {
      endLive();
      pressedRef.current = false;
      gestureRef.current = EMPTY_GESTURE;
      setGesture(EMPTY_GESTURE);
    }
  }, [usable]);
  // Any mousemove that reaches an svg (root claimed, or a hit target in
  // cursor mode) never reached the chart: forward it.
  const onMouseMove = (e: ReactMouseEvent<SVGSVGElement>) => {
    const { x, y } = toLocal(e);
    latest.current.props.showTip?.(x, y);
  };

  // Double-click on a drawing whose tool types its text in place (the note)
  // opens that text, never the chart's own double-click (auto-scale, All).
  const onDoubleClick = (e: ReactMouseEvent<SVGSVGElement>) => {
    // On a readout's grip: the readout goes back to its default place.
    const grip = gripOf(e.target);
    if (grip) {
      e.preventDefault();
      e.stopPropagation();
      const id = grip.closest('[data-annotation-id]')?.getAttribute('data-annotation-id');
      if (id) {
        setReadoutOffsets((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
      return;
    }
    const list = latest.current.props.annotations;
    let hit = hitOf(e.target, list);
    const pressHit = pressHitRef.current;
    if (hit.kind === 'none' && e.target === e.currentTarget && pressHit.kind !== 'none') {
      // Retargeted to a grid's root by pointer capture: use the note the press
      // hit, as it stands now.
      const pressed = list.find((a) => a.id === pressHit.annotation.id);
      if (pressed) hit = { kind: 'body', annotation: pressed };
    }
    if (
      hit.kind === 'none' ||
      hit.annotation.locked ||
      !hasInlineTextIn(catalogNow(), hit.annotation.kind)
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    setEditing({ id: hit.annotation.id, text: hit.annotation.text });
  };
  // Ends the edit once (Enter, Escape and the blur that follows them): a
  // changed text is one commit, labelled like the Properties edit.
  const finishEdit = (save: boolean) => {
    const cur = editing;
    if (!cur) return;
    setEditing(null);
    if (!save) return;
    const text = cur.text.trim().slice(0, MAX_ANNOTATION_TEXT);
    const before = latest.current.props.annotations.find((a) => a.id === cur.id);
    if (!before || before.text === text) return;
    const noun = catalogNow().byKind(before.kind)?.label.short ?? before.kind;
    latest.current.props.onCommit?.(
      (list) => list.map((a) => (a.id === cur.id ? { ...a, text } : a)),
      `Edit ${noun}`
    );
  };

  if (!isUsable(proj, annotationsHidden)) return null;
  const grids = layerGridsOf(proj, axes);
  const hiddenReason = config.hiddenReason ?? NEVER_HIDDEN;
  const frames = config.frames ?? NO_FRAMES;
  const geoCtx: GeometryContext = { theme, xAxis };
  const draft = draftProp !== undefined ? draftProp : (gesture.draft ?? null);
  // The drawing being moved shows as its draft only.
  const dragging = gesture.draft && gesture.drag ? gesture.drag.original.id : null;
  const claimed = prefs.tool !== 'cursor' || isLive(gesture);
  // The host's measure card rows (Trace's is its measure card); none without a provider.
  const measure: MeasureProvider = config.measure ?? NO_MEASURE;
  const axisRefOf = (axisId: string): AxisRef | undefined => {
    const ax = axes.find((x) => x.id === axisId);
    return ax
      ? { id: ax.id, name: ax.name ?? '', units: ax.units, unitLabel: ax.unitLabel }
      : undefined;
  };
  const cardOf = (def: DrawingTool, a: Annotation): CardSource | undefined =>
    def.card
      ? {
          ctx: { axis: axisRefOf(a.axisId), xAxis, measure },
          frames,
          offset: readoutOffsets[a.id],
        }
      : undefined;

  // Each drawing in its grid's svg: persisted drawings, then the draft.
  const perGrid: ReactNode[][] = grids.map(() => []);
  const place = (a: Annotation, isDraft: boolean) => {
    const def = catalog.byKind(a.kind);
    if (!def || a.hidden || hiddenReason(a) !== null) return;
    const gi = drawingGridIndex(def, a, grids);
    if (gi < 0) return;
    perGrid[gi].push(
      <Drawing
        key={isDraft ? `draft:${a.id}` : a.id}
        a={a}
        def={def}
        grid={grids[gi]}
        ctx={geoCtx}
        theme={theme}
        selected={!isDraft && a.id === selectedId}
        draft={isDraft}
        card={cardOf(def, a)}
      />
    );
  };
  for (const a of annotations) if (a.id !== dragging) place(a, false);
  if (draft) place(draft, true);

  const edited = editing ? annotations.find((a) => a.id === editing.id && !a.hidden) : undefined;
  const editedDef = edited ? catalog.byKind(edited.kind) : undefined;
  const editedGrid =
    edited && editedDef?.inlineText ? grids[drawingGridIndex(editedDef, edited, grids)] : undefined;
  const editor =
    editing && edited && editedGrid ? (
      <NoteEditor
        a={edited}
        text={editing.text}
        grid={editedGrid}
        theme={theme}
        onChange={(text) => setEditing({ id: edited.id, text })}
        onFinish={finishEdit}
      />
    ) : null;
  // The selected drawing's style chip, below and right of its handles. Not
  // while it is locked, hidden, being edited or reshaped, or with no writer.
  const sel = selectedId ? annotations.find((a) => a.id === selectedId) : undefined;
  const selDef = sel ? catalog.byKind(sel.kind) : undefined;
  let stylePanel: ReactNode = null;
  if (
    sel &&
    selDef &&
    props.onCommit &&
    !sel.locked &&
    !sel.hidden &&
    hiddenReason(sel) === null &&
    !editing &&
    !hasGesture(gesture)
  ) {
    const gi = drawingGridIndex(selDef, sel, grids);
    const geo = gi >= 0 ? selDef.geometry(painted(sel, theme), grids[gi], geoCtx) : null;
    if (geo && geo.handles.length > 0) {
      const at: [number, number] = [
        Math.max(...geo.handles.map(([x]) => x)) + 6,
        Math.max(...geo.handles.map(([, y]) => y)) + 6,
      ];
      const noun = selDef.label.short;
      const id = sel.id;
      stylePanel = (
        <StylePanel
          key={id}
          annotation={sel}
          at={at}
          bounds={grids[gi].gridRect}
          theme={theme}
          swatches={config.swatches?.() ?? []}
          onStyle={(patch) =>
            latest.current.props.onCommit?.(
              (list) => list.map((a) => (a.id === id ? withStyle(a, patch) : a)),
              `Style ${noun}`
            )
          }
        />
      );
    }
  }
  return (
    <>
      {grids.map((g, i) => {
        const rect = g.gridRect;
        return (
          <svg
            key={i}
            ref={(el) => {
              rootsRef.current[i] = el;
            }}
            data-annotation-layer=""
            width={rect.width}
            height={rect.height}
            viewBox={`0 0 ${rect.width} ${rect.height}`}
            style={{
              position: 'absolute',
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              overflow: 'hidden',
              pointerEvents: claimed ? 'all' : 'none',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onLostPointerCapture={onLostPointerCapture}
            onMouseMove={onMouseMove}
            onDoubleClick={onDoubleClick}
          >
            <g transform={`translate(${-rect.left} ${-rect.top})`}>{perGrid[i]}</g>
          </svg>
        );
      })}
      {editor}
      {stylePanel}
    </>
  );
}
