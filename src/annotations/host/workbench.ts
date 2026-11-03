// The drawing workbench integration: the Inspector schema of one drawing and
// the Outline section that lists a plot's drawings, generic over the host's
// state. Trace instantiates both over its plots; Correlation and Waveform over
// their own drawing lists.
//
// Inspector layout: the common head (Kind, Label, Colour, Width, Style, Axis),
// then every tool's own `fields` in catalog order (one Inspector field per
// field id, shown only while the selected drawing's tool declares it), then
// the common tail (Locked, Visible, Delete).
//
// Every write goes through `ctx.update` with the host's `access.patch` /
// `access.remove`, so the host's history-wrapped writer makes it undoable.
// The optional flags (`dash`, `locked`, `hidden`) are stored only when set.

import type {
  AxisRef,
  Catalog,
  DrawingFieldSpec,
  DrawingTool,
  XAxisDescriptor,
} from '../catalog/types';
import { ANNOTATION_INK } from '../../annotationTheme';
import {
  ANNOTATION_WIDTHS,
  MAX_ANNOTATION_TEXT,
  STYLE_WIDTHS,
  objNameIn,
  type Annotation,
  type AnnotationWidth,
} from '../model';
import type {
  FieldDef,
  ObjectSchema,
  OutlineRow,
  OutlineSection,
  SectionSchema,
  ToolContext,
  ToolUi,
} from '../../workbench/types';

/** The item kind drawing rows render under (`schema.items.annotation`). */
export const DRAWING_ITEM_KIND = 'annotation';

/** The section kind (and id) drawings are listed under. */
export const DRAWINGS_SECTION_KIND = 'annotations';

/** The drawings section's default title. */
export const DRAWINGS_SECTION_TITLE = 'Drawings';

/** The unit tag of the drawings section. */
export const DRAWINGS_SECTION_UNIT = 'drawing';

/** The id of the drawing Inspector tab. */
export const DRAWING_TAB_ID = 'drawing';

/**
 * How the schema reaches a host's drawings. `id` is a drawing id; the host
 * resolves it against whichever document holds it.
 */
export interface DrawingAccess<S> {
  /** The drawing list holding `id` (empty when none does). */
  list(state: S, id: string): readonly Annotation[];
  /** `state` with drawing `id` replaced by `fn(drawing)`; the same `state` when nothing changes. */
  patch(state: S, id: string, fn: (a: Annotation) => Annotation): S;
  /** `state` without drawing `id`. */
  remove(state: S, id: string): S;
  /** The Y axes of the document holding `id`, in order (the Axis field's options). */
  axes(state: S, id: string): readonly AxisRef[];
}

export interface DrawingSchemaOptions {
  /** The host's tools. */
  catalog: Catalog;
}

const widthOption = (w: AnnotationWidth) => ({ value: String(w), label: `${w} px` });
const WIDTH_OPTIONS = STYLE_WIDTHS.map(widthOption);

/** The Width options for a drawing: the offered widths, and its own when it holds another. */
function widthOptionsFor(a: Annotation | undefined) {
  return a && !STYLE_WIDTHS.includes(a.width)
    ? [...WIDTH_OPTIONS, widthOption(a.width)]
    : WIDTH_OPTIONS;
}

/** The swatch colour of the theme's ink: the chrome's primary text, which follows the theme. */
const INK_SWATCH = 'var(--cds-text-primary)';
const STYLE_OPTIONS = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
];

/** `a` with the optional key set to `value`, or without it when `value` is undefined. */
function withOptional<K extends 'dash' | 'locked' | 'hidden'>(
  a: Annotation,
  key: K,
  value: Annotation[K] | undefined
): Annotation {
  if (a[key] === value) return a;
  const out = { ...a };
  if (value === undefined) delete out[key];
  else out[key] = value;
  return out;
}

/** The value a tool field reads when the drawing is gone or its tool lacks the field. */
function emptyValue(kind: DrawingFieldSpec['kind']): string | number | boolean | null {
  switch (kind) {
    case 'number':
      return null;
    case 'toggle':
      return false;
    default:
      return '';
  }
}

/**
 * The tool fields of `catalog`, grouped by field id in catalog order: one
 * Inspector field per id, carrying each declaring tool's spec by kind.
 * Throws when two tools give one id different field kinds.
 */
function toolFieldGroups(catalog: Catalog): {
  id: string;
  label: string;
  kind: DrawingFieldSpec['kind'];
  specs: Map<string, DrawingFieldSpec>;
}[] {
  const groups = new Map<
    string,
    {
      id: string;
      label: string;
      kind: DrawingFieldSpec['kind'];
      specs: Map<string, DrawingFieldSpec>;
    }
  >();
  for (const tool of catalog.tools) {
    for (const spec of tool.fields) {
      let group = groups.get(spec.id);
      if (group === undefined) {
        group = { id: spec.id, label: spec.label, kind: spec.kind, specs: new Map() };
        groups.set(spec.id, group);
      } else if (group.kind !== spec.kind) {
        throw new Error(
          `drawing field ${JSON.stringify(spec.id)} is a ${group.kind} and a ${spec.kind}`
        );
      }
      group.specs.set(tool.kind, spec);
    }
  }
  return [...groups.values()];
}

/** The drawing Inspector schema over a host's drawings; call once at module level. */
export function createDrawingSchema<S, M, U extends ToolUi = ToolUi>(
  access: DrawingAccess<S>,
  { catalog }: DrawingSchemaOptions
): ObjectSchema<S, M, U> {
  type Ctx = ToolContext<S, M, U>;
  const drawing = (ctx: Ctx): Annotation | undefined =>
    access.list(ctx.state, ctx.target.id).find((a) => a.id === ctx.target.id);
  const toolOf = (a: Annotation | undefined): DrawingTool | undefined =>
    a === undefined ? undefined : catalog.byKind(a.kind);
  const patch = (ctx: Ctx, fn: (a: Annotation) => Annotation) =>
    ctx.update((state) => access.patch(state, ctx.target.id, fn));
  const base = { tab: DRAWING_TAB_ID, level: 'L1' as const };

  const head: FieldDef<S, M, U>[] = [
    {
      ...base,
      id: 'annotation-kind',
      label: 'Kind',
      kind: 'readonly',
      get: (ctx) => {
        const a = drawing(ctx);
        if (a === undefined) return '';
        return toolOf(a)?.label.long ?? a.kind;
      },
    },
    {
      ...base,
      id: 'annotation-label',
      label: 'Label',
      kind: 'text',
      get: (ctx) => drawing(ctx)?.text ?? '',
      set: (ctx, text) => {
        const next = text.slice(0, MAX_ANNOTATION_TEXT);
        patch(ctx, (a) => (a.text === next ? a : { ...a, text: next }));
      },
    },
    {
      ...base,
      id: 'annotation-color',
      label: 'Colour',
      kind: 'colour',
      row: 'swatch',
      get: (ctx) => {
        const color = drawing(ctx)?.color ?? '';
        return color === ANNOTATION_INK ? INK_SWATCH : color;
      },
      set: (ctx, value) => {
        if (value === '') return;
        // The ink's swatch value written back stores the ink itself.
        const color = value === INK_SWATCH ? ANNOTATION_INK : value;
        patch(ctx, (a) => (a.color === color ? a : { ...a, color }));
      },
    },
    {
      ...base,
      id: 'annotation-width',
      label: 'Width',
      kind: 'select',
      options: (ctx) => widthOptionsFor(drawing(ctx)),
      get: (ctx) => {
        const a = drawing(ctx);
        return a ? String(a.width) : '';
      },
      set: (ctx, value) => {
        const width = ANNOTATION_WIDTHS.find((w) => String(w) === value);
        if (width === undefined) return;
        patch(ctx, (a) => (a.width === width ? a : { ...a, width }));
      },
    },
    {
      ...base,
      id: 'annotation-style',
      label: 'Style',
      kind: 'select',
      options: () => STYLE_OPTIONS,
      get: (ctx) => (drawing(ctx)?.dash ? 'dashed' : 'solid'),
      set: (ctx, value) => {
        if (value !== 'solid' && value !== 'dashed') return;
        patch(ctx, (a) => withOptional(a, 'dash', value === 'dashed' ? true : undefined));
      },
    },
    {
      // Only for tools whose points carry a value. A move to another axis
      // drops the magnet's trace: the snapped curve belongs to the old axis.
      ...base,
      id: 'annotation-axis',
      label: 'Axis',
      kind: 'select',
      when: (ctx) => {
        const tool = toolOf(drawing(ctx));
        return tool !== undefined && tool.axes !== 'x';
      },
      options: (ctx) =>
        access.axes(ctx.state, ctx.target.id).map((axis, i) => ({
          value: axis.id,
          label: axis.name || `Y-Axis ${i + 1}`,
        })),
      get: (ctx) => drawing(ctx)?.axisId ?? '',
      set: (ctx, axisId) => {
        if (!access.axes(ctx.state, ctx.target.id).some((x) => x.id === axisId)) return;
        patch(ctx, (a) => {
          if (a.axisId === axisId) return a;
          const out = { ...a, axisId };
          delete out.traceId;
          return out;
        });
      },
    },
  ];

  const toolFields = toolFieldGroups(catalog).map((group): FieldDef<S, M, U> => {
    // The spec of the selected drawing's tool, when that tool declares this field.
    const specOf = (a: Annotation | undefined): DrawingFieldSpec | undefined =>
      a === undefined ? undefined : group.specs.get(a.kind);
    const shown = (ctx: Ctx) => {
      const a = drawing(ctx);
      const spec = specOf(a);
      return a !== undefined && spec !== undefined && (spec.when?.(a) ?? true);
    };
    const read = (ctx: Ctx): unknown => {
      const a = drawing(ctx);
      const spec = specOf(a);
      if (a === undefined || spec === undefined) return emptyValue(group.kind);
      return spec.get(a);
    };
    const write = (ctx: Ctx, value: unknown) =>
      patch(ctx, (a) => {
        const spec = specOf(a);
        if (spec === undefined) return a;
        return (spec.set as (a: Annotation, v: unknown) => Annotation)(a, value);
      });
    const common = { ...base, id: group.id, label: group.label, when: shown };
    switch (group.kind) {
      case 'number':
        return {
          ...common,
          kind: 'number',
          get: (ctx) => read(ctx) as number | null,
          set: write,
        };
      case 'select':
        return {
          ...common,
          kind: 'select',
          options: (ctx) => {
            const a = drawing(ctx);
            const spec = specOf(a);
            return a !== undefined && spec?.kind === 'select' ? spec.options(a) : [];
          },
          get: (ctx) => read(ctx) as string,
          set: write,
        };
      case 'text':
        return { ...common, kind: 'text', get: (ctx) => read(ctx) as string, set: write };
      case 'toggle':
        return { ...common, kind: 'toggle', get: (ctx) => read(ctx) as boolean, set: write };
    }
  });

  const tail: FieldDef<S, M, U>[] = [
    {
      ...base,
      id: 'annotation-locked',
      label: 'Locked',
      kind: 'toggle',
      row: 'lock',
      get: (ctx) => drawing(ctx)?.locked === true,
      set: (ctx, locked) => patch(ctx, (a) => withOptional(a, 'locked', locked ? true : undefined)),
    },
    {
      ...base,
      id: 'annotation-visible',
      label: 'Visible',
      kind: 'toggle',
      row: 'eye',
      get: (ctx) => {
        const a = drawing(ctx);
        return a !== undefined && !a.hidden;
      },
      set: (ctx, visible) =>
        patch(ctx, (a) => withOptional(a, 'hidden', visible ? undefined : true)),
    },
    {
      ...base,
      id: 'annotation-delete',
      label: 'Delete',
      kind: 'action',
      level: 'L2',
      run: (ctx) => ctx.update((state) => access.remove(state, ctx.target.id)),
    },
  ];

  return {
    tabs: [{ id: DRAWING_TAB_ID, label: 'Drawing', fields: [...head, ...toolFields, ...tail] }],
  };
}

/** The drawings section header's hide-all eye: `get` is "drawings shown". */
export interface DrawingsEye<S, M, U extends ToolUi = ToolUi> {
  /** The eye's field id (its `data-testid` in the section header). */
  id: string;
  get(ctx: ToolContext<S, M, U>): boolean;
  set(ctx: ToolContext<S, M, U>, visible: boolean): void;
}

/**
 * The drawings section schema: no add row (drawings are made on the plot), one
 * field, the header eye. Call once at module level.
 */
export function createDrawingsSectionSchema<S, M, U extends ToolUi = ToolUi>(
  eye: DrawingsEye<S, M, U>,
  title: string = DRAWINGS_SECTION_TITLE
): SectionSchema<S, M, U> {
  const visible: FieldDef<S, M, U> = {
    id: eye.id,
    label: 'Visible',
    kind: 'toggle',
    tab: DRAWINGS_SECTION_KIND,
    level: 'L1',
    row: 'eye',
    get: (ctx) => eye.get(ctx),
    set: (ctx, on) => eye.set(ctx, on),
  };
  return { tabs: [{ id: DRAWINGS_SECTION_KIND, label: title, fields: [visible] }] };
}

export interface DrawingsSectionOptions {
  /** The host's tools. */
  catalog: Catalog;
  /** The plot's x axis. */
  xAxis: XAxisDescriptor;
  /** The section title; "Drawings" by default. */
  title?: string;
  /** Measure readouts come from binned data. */
  binned?: boolean;
}

/**
 * The Outline section listing `list` by `objName`, in list order. A drawing
 * for which `hiddenReason` returns a reason is hidden by context: its row is
 * dimmed (`stale`) and carries the reason.
 */
export function drawingsSection(
  list: readonly Annotation[],
  axes: readonly AxisRef[],
  hiddenReason: (a: Annotation) => string | null,
  options: DrawingsSectionOptions
): OutlineSection {
  const { catalog, xAxis } = options;
  const rows = list.map((a): OutlineRow => {
    const label = objNameIn(catalog, xAxis, a, axes, options.binned ?? false);
    const reason = hiddenReason(a);
    if (reason !== null) {
      return { id: a.id, kind: DRAWING_ITEM_KIND, label, status: 'stale', refusal: reason };
    }
    return { id: a.id, kind: DRAWING_ITEM_KIND, label, status: 'ok' };
  });
  return {
    id: DRAWINGS_SECTION_KIND,
    kind: DRAWINGS_SECTION_KIND,
    title: options.title ?? DRAWINGS_SECTION_TITLE,
    unit: DRAWINGS_SECTION_UNIT,
    count: rows.length,
    rows,
  };
}
