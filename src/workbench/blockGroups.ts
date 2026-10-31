// How a block splits its fields: the main list (L1 then L2), the read-only
// Status group, and the L3 fields behind More.

import { isFieldShown } from './fields';
import type { FieldDef, ToolContext, ToolUi } from './types';

export interface BlockGroups<S, M, U extends ToolUi> {
  main: FieldDef<S, M, U>[];
  status: FieldDef<S, M, U>[];
  more: FieldDef<S, M, U>[];
}

/** The shown fields of `fields`, split into the main list, the Status group and More. */
export function blockGroups<S, M, U extends ToolUi>(
  fields: readonly FieldDef<S, M, U>[],
  ctx: ToolContext<S, M, U>
): BlockGroups<S, M, U> {
  const shown = fields.filter((field) => isFieldShown(field, ctx));
  const status = shown.filter((f) => f.group === 'status');
  const rest = shown.filter((f) => f.group !== 'status');
  return {
    main: [...rest.filter((f) => f.level === 'L1'), ...rest.filter((f) => f.level === 'L2')],
    status,
    more: rest.filter((f) => f.level === 'L3'),
  };
}
