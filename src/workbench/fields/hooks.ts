// Where a field renders, and the hooks that placement carries.
//
// - `properties`: the properties panel. The control carries the schema field id as its
//   `#id` (`#show-symbols`, `#axis-autoscale`, `#time-range`, `#density-y`,
//   `#role`, `#pv-name`), except a colour field, whose hook is the existing
//   `data-testid=trace-color-swatch` on its swatch. Never both on one control.
// - `header`: a section's inline header field. `data-testid=<field id>`, no `#id`
//   (how Correlation's inline `trigger-source` gets its hook).
// - `row`: an Outline row slot (swatch, eye). Neither hook.
//
// Controls that need an id for their own label wiring get a React-generated
// one off the Properties rendering; it is not a field hook.

/** Where a field is rendered. */
export type FieldPlacement = 'properties' | 'header' | 'row';

/** The colour field's Properties hook. */
export const COLOUR_SWATCH_TESTID = 'trace-color-swatch';

export interface FieldHooks {
  /** The control's `#id`, set on the Properties rendering only. */
  id?: string;
  /** The control's `data-testid`. */
  testId?: string;
}

/**
 * The hooks a field's control carries in `placement`. `idSuffix` keeps a
 * repeated block's `#id`s unique (the second and later Axes sub-blocks:
 * `#axis-unit--ax2`); the first copy keeps the bare id.
 */
export function fieldHooks(
  field: { id: string; kind: string },
  placement: FieldPlacement,
  idSuffix = ''
): FieldHooks {
  if (placement === 'row') return {};
  if (placement === 'header') return { testId: field.id };
  if (field.kind === 'colour') return { testId: COLOUR_SWATCH_TESTID };
  return { id: field.id + idSuffix };
}
