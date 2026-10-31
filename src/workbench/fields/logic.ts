// The pure rules the field renderers apply:
// shown (`when`), disabled with a reason, modified (the dot), and the number
// field's parse — and the schema lookups every pane shares (a target's object
// schema, a schema's fields). Kept apart from the components for fast refresh.

import type { FieldDef, ObjectSchema, Target, ToolContext, ToolSchema, ToolUi } from '../types';

/** The object schema behind `target`: the tool's, its section kind's or its item kind's. */
export function objectSchemaOf<S, M, U extends ToolUi>(
  schema: ToolSchema<S, M, U>,
  target: Target
): ObjectSchema<S, M, U> | undefined {
  if (target.level === 'tool') return schema.tool;
  if (target.level === 'section') return schema.sections[target.kind];
  return schema.items[target.kind];
}

/** Every field of `schema`, across its tabs in order; none without a schema. */
export function schemaFields<S, M, U extends ToolUi>(
  schema: ObjectSchema<S, M, U> | undefined
): FieldDef<S, M, U>[] {
  return schema ? schema.tabs.flatMap((tab) => tab.fields) : [];
}

/** Whether the field is shown for `ctx` (absent `when` = always). */
export function isFieldShown<S, M, U extends ToolUi>(
  field: FieldDef<S, M, U>,
  ctx: ToolContext<S, M, U>
): boolean {
  return field.when?.(ctx) ?? true;
}

/** Whether the field shows the modified dot: it is pinned. */
export function isFieldModified<S, M, U extends ToolUi>(
  field: FieldDef<S, M, U>,
  ctx: ToolContext<S, M, U>
): boolean {
  return field.modified?.(ctx) ?? false;
}

/** `false`, or why the field cannot be used right now. */
export function disabledReason<S, M, U extends ToolUi>(
  field: FieldDef<S, M, U>,
  ctx: ToolContext<S, M, U>
): false | string {
  return field.disabled?.(ctx) ?? false;
}

let opaqueSignature = 0;

/**
 * A field's value, gates, dot and options as one comparable string: the rate
 * rule's compare for a field rendered outside the panel's own block pass (row
 * slots, header fields, a pane's field list). A value that cannot be
 * stringified compares unequal every time.
 */
export function fieldSignature<S, M, U extends ToolUi>(
  field: FieldDef<S, M, U>,
  ctx: ToolContext<S, M, U>
): string {
  if (!isFieldShown(field, ctx)) return 'hidden';
  const value = 'get' in field ? (field.get as (c: ToolContext<S, M, U>) => unknown)(ctx) : null;
  const options =
    'options' in field && typeof field.options === 'function' ? field.options(ctx) : null;
  try {
    return (
      JSON.stringify([value, disabledReason(field, ctx), isFieldModified(field, ctx), options]) ??
      ''
    );
  } catch {
    opaqueSignature += 1;
    return `opaque:${opaqueSignature}`;
  }
}

/** Parse the typed text: '' is `null`, anything else must be a finite number. */
export function parseNumber(
  text: string,
  bounds: { min?: number; max?: number } = {}
): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return undefined;
  if (bounds.min !== undefined && value < bounds.min) return undefined;
  if (bounds.max !== undefined && value > bounds.max) return undefined;
  return value;
}
