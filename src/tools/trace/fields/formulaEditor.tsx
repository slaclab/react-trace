// Trace's Formula editor custom field. Ported from today's RightPanel
// `FormulaGeneralTab`, edit semantics unchanged: an expression over
// `{x1}`-style variables (the textarea carries the field's `#id`), live
// validation through the Formula Engine debounced 400 ms (an older request is aborted), and
// one binding select per variable (`#formula-bind-<var>`) over the PV curves of
// the same plot. Every edit commits `{ expression, bindings }`; bindings map a
// variable to a curve id.

import { useEffect, useState, type ReactNode } from 'react';
import { Select, SelectItem } from '@carbon/react';
import { CanopyError } from '@slaclab/canopy-client';
import { useCanopyConnection } from '@slaclab/canopy-react';
import { validateFormula } from '../../../api/formulaEngine';
import { extractFormulaVars } from '../../../formula';

/** The editor's value: what a formula curve stores. */
export interface FormulaEditorValue {
  expression: string;
  /** Variable → referenced curve id. */
  bindings: Record<string, string>;
}

/** A curve a variable can be bound to. */
export interface BindableCurve {
  id: string;
  label: string;
}

export interface FormulaEditorProps {
  /** The expression textarea's `#id` (the field's Properties hook). */
  id?: string;
  value: FormulaEditorValue;
  /** The curves a variable may reference (same plot, PV-backed, not this one). */
  bindable: readonly BindableCurve[];
  /** The bound variables resolved to PV names (the Formula Engine's wire form), for validation. */
  resolvedBindings: Record<string, string>;
  onChange(value: FormulaEditorValue): void;
}

/** The debounce before a validation request, as today's editor. */
export const FORMULA_VALIDATE_DEBOUNCE_MS = 400;
export const UNBOUND_VARIABLE = 'Unbound variable';
export const SELECT_CURVE = '— select curve —';

interface Validation {
  valid: boolean;
  errors: string[];
}

export function FormulaEditorControl({
  id,
  value,
  bindable,
  resolvedBindings,
  onChange,
}: FormulaEditorProps): ReactNode {
  const { expression, bindings } = value;
  const vars = extractFormulaVars(expression);
  const unbound = vars.filter((v) => !bindings[v]);
  const hasExpr = expression.trim().length > 0;
  const canopy = useCanopyConnection();
  const [validation, setValidation] = useState<Validation | null>(null);

  // Keyed on the resolved PV names, so a bound curve's PV change re-validates
  // even though its id (the stored binding) stays the same.
  const resolvedKey = JSON.stringify(resolvedBindings);
  useEffect(() => {
    const expr = expression.trim();
    if (!expr) return;
    const ac = new AbortController();
    const handle = setTimeout(() => {
      validateFormula(
        canopy,
        { kind: 'timeseries', expression: expr, bindings: JSON.parse(resolvedKey) },
        ac.signal
      )
        .then((r) => {
          if (!ac.signal.aborted) setValidation({ valid: r.valid, errors: r.errors });
        })
        .catch((err: unknown) => {
          if (ac.signal.aborted || (err as { name?: string }).name === 'AbortError') return;
          const detail = err instanceof CanopyError ? err.detail : (err as Error).message;
          setValidation({ valid: false, errors: [detail] });
        });
    }, FORMULA_VALIDATE_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
      ac.abort();
    };
  }, [canopy, expression, resolvedKey]);

  let status: ReactNode = null;
  if (hasExpr && validation && !validation.valid && validation.errors.length > 0) {
    status = (
      <div className="wb-field__note trace-formula__errors" role="alert">
        {validation.errors.join('; ')}
      </div>
    );
  } else if (hasExpr && validation?.valid && unbound.length === 0) {
    status = (
      <div className="wb-field__note trace-formula__valid" role="status">
        Valid
      </div>
    );
  }

  return (
    <div className="trace-formula">
      <p className="wb-field__note">
        Combine curves with <code className="prop-code-var">{'{x1}'}</code>-style variables, e.g.{' '}
        <code className="prop-code-var">{'{x1} + {x2}'}</code>. Supports arithmetic and math
        functions (<code>mean</code>, <code>ln</code>, <code>abs</code>, <code>sqrt</code>, …).
      </p>
      <textarea
        id={id}
        aria-label="Formula"
        className="prop-code-area"
        placeholder="{x1} + {x2}"
        rows={3}
        value={expression}
        spellCheck={false}
        onChange={(e) => onChange({ expression: e.target.value, bindings })}
      />
      {status}
      <div className="trace-formula__variables">
        {vars.length === 0 ? (
          <p className="wb-field__note">
            Add a <code className="prop-code-var">{'{var}'}</code> to the formula to bind it to a
            curve.
          </p>
        ) : bindable.length === 0 ? (
          <p className="wb-field__note">
            No PV curves on this plot to reference. Add a PV trace first.
          </p>
        ) : (
          vars.map((v) => (
            <Select
              key={v}
              id={`formula-bind-${v}`}
              labelText={`{${v}}`}
              value={bindings[v] ?? ''}
              size="sm"
              invalid={!bindings[v]}
              invalidText={UNBOUND_VARIABLE}
              onChange={(e) =>
                onChange({ expression, bindings: { ...bindings, [v]: e.target.value } })
              }
            >
              <SelectItem value="" text={SELECT_CURVE} />
              {bindable.map((c) => (
                <SelectItem key={c.id} value={c.id} text={c.label} />
              ))}
            </Select>
          ))
        )}
      </div>
    </div>
  );
}
