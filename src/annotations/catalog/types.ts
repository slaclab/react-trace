// The drawing-tool contracts: what one tool
// definition carries, the catalog of tools a plot offers, and the host config
// a plot hands its drawing overlay. Types only; tool definitions import this,
// `shapeKit` and `format`, and never `model.ts` at runtime.
import type { ComponentType, ReactNode } from 'react';
import type { FieldOption } from '../../workbench/types';
import type { Annotation, AnnotationPoint } from '../model';
import type { ShedStore } from '../host/shedStore';
import type { AnnotationLabelStyle } from '../../annotationTheme';
import type { GridProjection, SnapHit } from '../../plot/geometry';

export type { ShedSnapshot, ShedStore } from '../host/shedStore';
export type { GridProjection, GridRect, SamplePoint, SnapHit } from '../../plot/geometry';

// ------------------------------------------------------------- core data --

/** The slice of a plot axis the drawing core reads: it replaces `types.ts` `Axis`. */
export interface AxisRef {
  id: string;
  name: string;
  /** EGU of the axis. */
  units?: string;
  /** User unit override; wins over `units` when set. */
  unitLabel?: string;
}

// ---------------------------------------------------------------- x axis --

/** How a drawing's x is shown: in an object name, or in the full status-line form. */
export type XFormatStyle = 'name' | 'status';

/**
 * What the drawing core knows about the plot's x axis. A stored point's
 * `t` is "x" in this axis's units: epoch ms on a time axis, the axis value on
 * a value axis.
 */
export interface XAxisDescriptor {
  kind: 'time' | 'value';
  /** One x as text (`'name'`: HH:MM:SS on time; `'status'`: the full date on time). */
  format(x: number, style: XFormatStyle): string;
  /** A span of x as text (a duration on time). */
  formatSpan(dx: number): string;
  /**
   * The x a drawing stores. `snapped` marks an x taken from a sample, `pxStep`
   * is one pixel's worth of x on the grid it was placed in.
   */
  quantize(x: number, snapped: boolean, pxStep: number): number;
}

// ------------------------------------------------------------- geometry --

/** The svg text attributes of a drawing label (font, size, slant); annotationTheme.ts holds the values. */
export type DrawingLabelStyle = AnnotationLabelStyle;

/** The theme slice a tool's geometry reads; a `ChartTheme` satisfies it. */
export interface DrawingTheme {
  /** The plot's own colour: the halo behind labels. */
  bg: string;
  tooltipBg: string;
  tooltipText: string;
  annotation: {
    palette: readonly string[];
    /** What a drawing coloured `ink` is drawn in. */
    ink: string;
    /** Measurement readouts and their guide lines. */
    measure: string;
    /** Outline of the selected drawing. */
    selection: string;
    /** Fill of the drag handles on the selected drawing. */
    handle: string;
    /** Labels, note text and the measure readout. */
    label: DrawingLabelStyle;
  };
}

/** The marks of one drawing in wrapper-local pixels; the layer hit-tests and draws handles from it. */
export interface Geometry {
  /** The visible marks. */
  body: ReactNode;
  /** Path data outlined in the selection colour when selected. */
  outline: string[];
  /** Transparent hit targets. */
  hits: ReactNode;
  /** Handle positions, index = point index. */
  handles: [number, number][];
  /** Where the lock glyph sits. */
  lockAt: [number, number];
}

/** What a tool's `geometry` reads besides the drawing and its grid. */
export interface GeometryContext {
  theme: DrawingTheme;
  xAxis: XAxisDescriptor;
}

/** Props of a tool's `Shape`: the drawing and the geometry it renders. */
export interface ShapeProps {
  annotation: Annotation;
  geometry: Geometry;
}

// ----------------------------------------------------------------- text --

/** What a tool's object name reads. */
export interface DrawingTextContext {
  /** The drawing's axis, when the plot knows it. */
  axis?: AxisRef;
  xAxis: XAxisDescriptor;
  /** The measure readout comes from binned data (its Δ reads approximate). */
  binned?: boolean;
}

/** What a tool's status-line hint reads. */
export interface HintContext {
  xAxis: XAxisDescriptor;
}

/** What a measure card reads: the text context and the host's measure provider. */
export interface MeasureCardContext extends DrawingTextContext {
  measure: MeasureProvider;
}

// --------------------------------------------------------------- fields --

interface DrawingFieldBase {
  /** Stable Inspector field id (Trace's ids are pinned by its schema test). */
  id: string;
  label: string;
  /** Shown only when true; absent = always shown for this tool. */
  when?(a: Annotation): boolean;
}

/**
 * One tool-owned Inspector field, typed over the drawing. `set` returns
 * the edited drawing, or the same reference when nothing changes.
 */
export type DrawingFieldSpec =
  | (DrawingFieldBase & {
      kind: 'number';
      get(a: Annotation): number | null;
      set(a: Annotation, value: number | null): Annotation;
    })
  | (DrawingFieldBase & {
      kind: 'select';
      options(a: Annotation): FieldOption[];
      get(a: Annotation): string;
      set(a: Annotation, value: string): Annotation;
    })
  | (DrawingFieldBase & {
      kind: 'text';
      get(a: Annotation): string;
      set(a: Annotation, value: string): Annotation;
    })
  | (DrawingFieldBase & {
      kind: 'toggle';
      get(a: Annotation): boolean;
      set(a: Annotation, value: boolean): Annotation;
    });

// ---------------------------------------------------------------- codec --

/** The points a link tuple stores, in order: `v` (H-line) … `tvtv` (two full points). */
export type CodecLayout = 'v' | 't' | 'tt' | 'tv' | 'tvtv';

/** A tool's own flag letters in a link tuple (Trend's `r`/`b`), after the common ones. */
export interface CodecFlags {
  /** The tool's letters for this drawing ('' for none). */
  encode(a: Annotation): string;
  /** `a` with the tool's properties read from the tuple's flags; unknown letters are ignored. */
  decode(flags: string, a: Annotation): Annotation;
}

export interface DrawingCodec {
  layout: CodecLayout;
  flags?: CodecFlags;
}

// ----------------------------------------------------------------- tool --

/** A tool icon (a carbon icon component). */
export type DrawingIcon = ComponentType<{ size?: number }>;

/** Which coordinates a tool uses: x only (V-line), y only (H-line), or both. */
export type DrawingAxes = 'x' | 'y' | 'xy';

/** Everything one drawing tool is. Behaviour keys on these fields, never on `kind` strings. */
export interface DrawingTool {
  // identity
  kind: string;
  /** Wire code: built-ins 0–6, 100+ other tools, 900+ test-only. */
  code: number;
  label: { long: string; short: string };
  icon: DrawingIcon;

  // placement
  arity: 1 | 2;
  axes: DrawingAxes;
  /** The Alt+key that arms the tool. */
  key?: string;
  /**
   * The rail group the tool sits in: tools of one group stand together, in
   * catalog order, groups in the order they first appear, a separator
   * between groups. Absent = a group of the tool's own.
   */
  railGroup?: string;
  /** Offered in the plot's context menu with this label. */
  menuAdd?: { label: string };
  /** Text is typed on the plot, in place, right after placing. */
  inlineText?: true;

  // shape
  /** Zero the coordinate the tool does not use, so file and link agree. */
  shapePoint(point: AnnotationPoint): AnnotationPoint;
  /** The drawing's marks on one grid, or null when it cannot be drawn there. Pure. */
  geometry(a: Annotation, grid: GridProjection, ctx: GeometryContext): Geometry | null;
  /** Renders a {@link Geometry}. */
  Shape: ComponentType<ShapeProps>;

  // text
  /** The Layers label of a drawing. */
  objName(a: Annotation, ctx: DrawingTextContext): string;
  /** The status-line hint while the tool is armed. */
  hint(ctx: HintContext): string;

  // measure only
  card?(a: Annotation, ctx: MeasureCardContext): string[];
  modifierGesture?: 'shift';

  /** Tool-owned Inspector fields, shown between the common head and tail. */
  fields: readonly DrawingFieldSpec[];
  /**
   * `base` (the commonly validated record) with the tool's own properties
   * copied from `raw` and checked; null rejects the record.
   */
  validate?(raw: Readonly<Record<string, unknown>>, base: Annotation): Annotation | null;
  codec: DrawingCodec;
}

/** The tools a plot offers, with lookups. Built by `makeCatalog`. */
export interface Catalog {
  /** In rail order. */
  tools: readonly DrawingTool[];
  byKind(kind: string): DrawingTool | undefined;
  byCode(code: number): DrawingTool | undefined;
}

// ----------------------------------------------------------------- host --

/** Finds the sample a magnet press lands on. Reads live data through a getter, never a closure over a frame. */
export interface SnapSource {
  snap(x: number, y: number, projection: GridProjection): SnapHit | null;
}

/** The measure card rows of a host: they cover only the measured x span. */
export interface MeasureProvider {
  card(a: Annotation, ctx: DrawingTextContext): string[];
}

/** Bumped by the plot on each new data frame; only the measure card subscribes. */
export interface FrameStore {
  subscribe(cb: () => void): () => void;
  getVersion(): number;
}

/** A plotted curve's colour, offered by the style panel so a drawing can match its curve. */
export interface StyleSwatch {
  color: string;
  /** The curve's name: the swatch's accessible name. */
  name: string;
}

/** What a plot hands its drawing overlay; built with `useMemo`, never keyed on the frame. */
export interface HostConfig {
  catalog: Catalog;
  xAxis: XAxisDescriptor;
  snap: SnapSource;
  measure: MeasureProvider;
  frames: FrameStore;
  shed: ShedStore;
  /** The axis a new drawing placed at (`px`, `py`) belongs to; null places nothing. */
  ownerAxisAt(px: number, py: number, snapHit: SnapHit | null): string | null;
  /** Why a drawing is hidden at render time ("x source changed", …), or null when shown. */
  hiddenReason(a: Annotation): string | null;
  /** The plotted curves' colours for the style panel, read when it renders; absent = none. */
  swatches?(): readonly StyleSwatch[];
}
