// A field inside the workbench's chrome: label · modified dot · reset, the control, then the disabled reason
// or the help line. The custom kind renders the tool's renderer inside the
// same chrome; the action kind is a bare button (no label, no dot).
//
// - `when(ctx)` false: nothing is rendered (a control whose service the
//   deployment cannot provide is hidden; the tool expresses that as `when`).
// - `disabled(ctx)` a reason: the control is disabled and the reason shown.
// - The dot shows iff `modified(ctx)`; reset calls `reset(ctx)`. Both come from
//   the tool's dot helpers, so the workbench never sees a default.
// - `level` is carried as `data-level`; `FieldBlock` decides where L3 goes.

import { useId, type ReactNode } from 'react';
import { Reset } from '@carbon/icons-react';
import type { FieldDef, ToolContext, ToolUi } from '../types';
import { FieldControl } from './FieldControl';
import { disabledReason, isFieldModified, isFieldShown } from './logic';
import type { FieldPlacement } from './hooks';

export interface FieldProps<S, M, U extends ToolUi = ToolUi> {
  field: FieldDef<S, M, U>;
  ctx: ToolContext<S, M, U>;
  /** `properties` (default) carries the field's `#id`; see `fieldHooks`. */
  placement?: FieldPlacement;
  /** Appended to the control's `#id` in a repeated block; see `fieldHooks`. */
  idSuffix?: string;
}

export function Field<S, M, U extends ToolUi = ToolUi>({
  field,
  ctx,
  placement = 'properties',
  idSuffix,
}: FieldProps<S, M, U>): ReactNode {
  const noteId = useId();
  if (!isFieldShown(field, ctx)) return null;
  const reason = disabledReason(field, ctx);
  const note = reason !== false ? reason : field.help;
  const control = (
    <FieldControl field={field} ctx={ctx} placement={placement} idSuffix={idSuffix} />
  );
  const noteLine = note ? (
    <div
      id={noteId}
      className={`wb-field__note${reason !== false ? ' wb-field__note--reason' : ''}`}
    >
      {note}
    </div>
  ) : null;

  if (field.kind === 'action') {
    return (
      <div className="wb-field wb-field--action" data-level={field.level} data-field={field.id}>
        {control}
        {noteLine}
      </div>
    );
  }

  const modified = isFieldModified(field, ctx);
  return (
    <div
      className={`wb-field wb-field--${field.kind}${modified ? ' wb-field--modified' : ''}`}
      data-level={field.level}
      data-field={field.id}
    >
      <div className="wb-field__head">
        <span className="wb-field__label" aria-hidden="true">
          {field.label}
        </span>
        {modified && (
          <>
            <span className="wb-field__dot" role="img" aria-label={`${field.label} modified`} />
            <button
              type="button"
              className="wb-field__reset"
              aria-label={`Reset ${field.label}`}
              title={`Reset ${field.label}`}
              onClick={() => field.reset?.(ctx)}
            >
              <Reset size={14} />
            </button>
          </>
        )}
      </div>
      <div className="wb-field__control">{control}</div>
      {noteLine}
    </div>
  );
}
