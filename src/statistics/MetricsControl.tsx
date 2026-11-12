// The Metrics custom field of every tool's Statistics tab. The value is the
// tool's metric list (model.ts); every edit hands the whole next list to
// `onChange`, which the tool's schema writes through its normalizer.
//
// One compact row per metric: a checkbox for `on` (a table column), the label
// over its expression (mono, muted, ellipsised), an error mark when a custom
// expression does not validate, a strip-chart toggle (`strip`) and a chevron
// that expands the row. One row is expanded at a time. A preset expands to its
// read-only expression, Move up / Move down and Delete; a custom metric to
// Label and Expression inputs (local while typing, committed on blur or Enter,
// Escape restores the committed text), a Unit select over the catalog's
// kinds, Move up / Move down and Delete. Any metric can be deleted, so the
// cap is `MAX_METRICS` in all; a deleted preset comes back only through Reset
// metrics.
//
// The expression is validated in the browser on every keystroke
// (`validateExpression` against the current row count), shown as a warning
// while uncommitted and as an error once committed, and committed even when
// invalid: the table shows "–" for it and the row keeps the error, so a
// formula that references a row not added yet survives until it is.
//
// Add metric appends `c<k>` "Metric <k>", on, no strip, expands it and focuses
// its Expression; it is disabled with the reason at `MAX_METRICS`. Below it, an
// "Expression reference" disclosure lists the catalog's variables and the
// shared functions.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Checkbox, Select, SelectItem, TextInput } from '@carbon/react';
import {
  Add,
  ArrowDown,
  ArrowUp,
  ChartLine,
  ChevronDown,
  ChevronRight,
  TrashCan,
  WarningFilled,
} from '@carbon/icons-react';
import { FUNCTION_REFERENCE } from './expr';
import {
  MAX_METRICS,
  MAX_METRIC_EXPR_LENGTH,
  MAX_METRIC_LABEL_LENGTH,
  isCustomId,
  isMetricUnit,
  isPresetId,
  metricsFullMessage,
  nextCustomId,
  validateExpression,
  type Metric,
  type MetricCatalog,
} from './model';
import './statistics.css';

export interface MetricsControlProps {
  /** The list's `#id` (the field's Properties hook). */
  id?: string;
  catalog: MetricCatalog;
  value: readonly Metric[];
  /** The number of rows, so `y3` with two rows is reported. */
  rowCount: number;
  disabled?: boolean;
  onChange(value: Metric[]): void;
}

/** The name a row shows and its controls are named after. */
function displayLabel(metric: Metric): string {
  return metric.label === '' ? metric.id : metric.label;
}

/** A custom metric's expression error, or null (presets always validate). */
function metricError(catalog: MetricCatalog, metric: Metric, rowCount: number): string | null {
  if (isPresetId(catalog, metric.id)) return null;
  if (metric.expr.trim() === '') return 'Enter an expression';
  return validateExpression(catalog, metric.expr, rowCount);
}

export function MetricsControl({
  id,
  catalog,
  value,
  rowCount,
  disabled,
  onChange,
}: MetricsControlProps): ReactNode {
  const base = id ?? `${catalog.id}-metrics`;
  const [expanded, setExpanded] = useState<string | null>(null);
  // The new row's Expression takes focus once it has rendered.
  const [focusExpr, setFocusExpr] = useState<string | null>(null);
  const open = expanded !== null && value.some((m) => m.id === expanded) ? expanded : null;

  const patch = (metricId: string, next: Partial<Metric>) =>
    onChange(value.map((m) => (m.id === metricId ? { ...m, ...next } : m)));

  const move = (metricId: string, direction: -1 | 1) => {
    const from = value.findIndex((m) => m.id === metricId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= value.length) return;
    const next = [...value];
    [next[from], next[to]] = [next[to], next[from]];
    onChange(next);
  };

  const remove = (metricId: string) => {
    setExpanded(null);
    onChange(value.filter((m) => m.id !== metricId));
  };

  const full = value.length >= MAX_METRICS;
  const add = () => {
    if (full) return;
    const customs = value.filter((m) => isCustomId(m.id)).length;
    const metric: Metric = {
      id: nextCustomId(value),
      label: `Metric ${customs + 1}`,
      expr: '',
      unit: '',
      on: true,
      strip: false,
    };
    setExpanded(metric.id);
    setFocusExpr(metric.id);
    onChange([...value, metric]);
  };

  return (
    <div className="stats-metrics">
      <ul id={base} className="stats-metrics__list" aria-label="Metrics">
        {value.map((metric, index) => (
          <MetricRow
            key={metric.id}
            base={base}
            catalog={catalog}
            metric={metric}
            rowCount={rowCount}
            first={index === 0}
            last={index === value.length - 1}
            expanded={open === metric.id}
            focusExpr={focusExpr === metric.id}
            disabled={disabled}
            onFocused={() => setFocusExpr(null)}
            onToggleExpanded={() => setExpanded(open === metric.id ? null : metric.id)}
            onPatch={(next) => patch(metric.id, next)}
            onMove={(direction) => move(metric.id, direction)}
            onDelete={() => remove(metric.id)}
          />
        ))}
      </ul>
      <div className="stats-metrics__footer">
        <Button kind="ghost" size="sm" renderIcon={Add} disabled={disabled || full} onClick={add}>
          Add metric
        </Button>
        {full && (
          <div className="wb-field__note wb-field__note--reason">{metricsFullMessage()}</div>
        )}
      </div>
      <details className="stats-metrics__help">
        <summary>Expression reference</summary>
        <p className="wb-field__note">{catalog.example}</p>
        <dl className="stats-metrics__reference">
          {[...catalog.variables, ...FUNCTION_REFERENCE].map((e) => (
            <div key={`${e.name}:${e.signature}`} className="stats-metrics__ref">
              <dt>{e.signature}</dt>
              <dd>{e.description}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

// -------------------------------------------------------------------- row --

interface MetricRowProps {
  base: string;
  catalog: MetricCatalog;
  metric: Metric;
  rowCount: number;
  first: boolean;
  last: boolean;
  expanded: boolean;
  focusExpr: boolean;
  disabled?: boolean;
  onFocused(): void;
  onToggleExpanded(): void;
  onPatch(next: Partial<Metric>): void;
  onMove(direction: -1 | 1): void;
  onDelete(): void;
}

function MetricRow({
  base,
  catalog,
  metric,
  rowCount,
  first,
  last,
  expanded,
  focusExpr,
  disabled,
  onFocused,
  onToggleExpanded,
  onPatch,
  onMove,
  onDelete,
}: MetricRowProps): ReactNode {
  const label = displayLabel(metric);
  const preset = isPresetId(catalog, metric.id);
  const error = metricError(catalog, metric, rowCount);
  const rowId = `${base}-${metric.id}`;
  const detailId = `${rowId}-detail`;

  return (
    <li className={`stats-metrics__item${expanded ? ' stats-metrics__item--open' : ''}`}>
      <div className="stats-metrics__row">
        <Checkbox
          id={`${rowId}-on`}
          labelText={`Show ${label}`}
          hideLabel
          checked={metric.on}
          disabled={disabled}
          onChange={(_e, { checked }) => onPatch({ on: checked })}
        />
        <div className="stats-metrics__text">
          <span className="stats-metrics__label">{label}</span>
          <span className="stats-metrics__expr" title={metric.expr}>
            {metric.expr === '' ? ' ' : metric.expr}
          </span>
        </div>
        {error !== null && (
          <span
            className="stats-metrics__error"
            role="img"
            aria-label={`${label}: ${error}`}
            title={error}
          >
            <WarningFilled size={14} />
          </span>
        )}
        <button
          type="button"
          className="stats-metrics__icon"
          aria-label={`Strip chart for ${label}`}
          title={`Strip chart for ${label}`}
          aria-pressed={metric.strip}
          disabled={disabled}
          onClick={() => onPatch({ strip: !metric.strip })}
        >
          <ChartLine size={16} />
        </button>
        <button
          type="button"
          className="stats-metrics__icon"
          aria-label={expanded ? `Collapse ${label}` : `Edit ${label}`}
          title={expanded ? `Collapse ${label}` : `Edit ${label}`}
          aria-expanded={expanded}
          aria-controls={expanded ? detailId : undefined}
          onClick={onToggleExpanded}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
      </div>
      {expanded && (
        <div id={detailId} className="stats-metrics__detail">
          {preset ? (
            <div className="wb-field__note">
              Built-in: <code className="stats-metrics__code">{metric.expr}</code>
            </div>
          ) : (
            <>
              <CommitInput
                id={`${rowId}-label`}
                labelText="Label"
                value={metric.label}
                maxLength={MAX_METRIC_LABEL_LENGTH}
                disabled={disabled}
                // An empty label is refused: the row would have no name.
                validate={(text) =>
                  text.trim() === ''
                    ? 'Enter a label'
                    : /^[-~]/.test(text.trim())
                      ? 'A label cannot start with - or ~'
                      : null
                }
                onCommit={(text) => onPatch({ label: text.trim() })}
              />
              <CommitInput
                id={`${rowId}-expr`}
                labelText="Expression"
                mono
                value={metric.expr}
                maxLength={MAX_METRIC_EXPR_LENGTH}
                disabled={disabled}
                autoFocus={focusExpr}
                onFocused={onFocused}
                // Shown, never blocking: an invalid expression is kept.
                hint={(text) =>
                  text.trim() === '' ? null : validateExpression(catalog, text, rowCount)
                }
                onCommit={(text) => onPatch({ expr: text.trim() })}
              />
              <Select
                id={`${rowId}-unit`}
                labelText="Unit"
                size="sm"
                value={metric.unit}
                disabled={disabled}
                onChange={(e) => {
                  const unit = e.target.value;
                  if (isMetricUnit(catalog, unit)) onPatch({ unit });
                }}
              >
                {catalog.units.map((o) => (
                  <SelectItem key={o.value} value={o.value} text={o.label} />
                ))}
              </Select>
            </>
          )}
          <div className="stats-metrics__buttons">
            <Button
              kind="ghost"
              size="sm"
              renderIcon={ArrowUp}
              disabled={disabled || first}
              onClick={() => onMove(-1)}
            >
              Move up
            </Button>
            <Button
              kind="ghost"
              size="sm"
              renderIcon={ArrowDown}
              disabled={disabled || last}
              onClick={() => onMove(1)}
            >
              Move down
            </Button>
            <Button
              kind="danger--ghost"
              size="sm"
              renderIcon={TrashCan}
              aria-label={`Delete ${label}`}
              disabled={disabled}
              onClick={onDelete}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------- commit input --

interface CommitInputProps {
  id: string;
  labelText: string;
  value: string;
  maxLength: number;
  disabled?: boolean;
  mono?: boolean;
  autoFocus?: boolean;
  onFocused?(): void;
  /** A blocking error: the commit is refused and the error shown. */
  validate?(text: string): string | null;
  /** A non-blocking error: shown live and kept on commit. */
  hint?(text: string): string | null;
  onCommit(text: string): void;
}

/** A text input committed on blur or Enter; Escape restores the committed value. */
function CommitInput({
  id,
  labelText,
  value,
  maxLength,
  disabled,
  mono,
  autoFocus,
  onFocused,
  validate,
  hint,
  onCommit,
}: CommitInputProps): ReactNode {
  const [text, setText] = useState(value);
  const [refusal, setRefusal] = useState<string | null>(null);
  // Typed and not yet committed: the hint is a warning, not an error, so a
  // half-typed "mean(" never flashes red.
  const [editing, setEditing] = useState(false);
  // Re-sync from an outside change (load, reset) during render.
  const [syncedFrom, setSyncedFrom] = useState(value);
  if (value !== syncedFrom) {
    setSyncedFrom(value);
    setText(value);
    setRefusal(null);
    setEditing(false);
  }
  const ref = useRef<HTMLInputElement>(null);
  // Read through a ref: the caller passes a fresh closure every render, and
  // the focus must run once per request, not once per render.
  const onFocusedRef = useRef(onFocused);
  useEffect(() => {
    onFocusedRef.current = onFocused;
  });
  useEffect(() => {
    if (!autoFocus) return;
    ref.current?.focus();
    onFocusedRef.current?.();
  }, [autoFocus]);

  const commit = () => {
    const error = validate?.(text) ?? null;
    setRefusal(error);
    setEditing(false);
    if (error === null && text.trim() !== value) onCommit(text);
  };

  // A blocking refusal is invalid; the hint warns while typing and is
  // invalid once a commit (or the committed value) leaves it standing.
  const hinted = refusal === null ? (hint?.(text) ?? null) : null;
  const error = refusal ?? (editing ? null : hinted);
  const warning = editing ? hinted : null;
  return (
    <TextInput
      ref={ref}
      id={id}
      labelText={labelText}
      size="sm"
      className={mono ? 'stats-metrics__mono' : undefined}
      value={text}
      maxLength={maxLength}
      disabled={disabled}
      spellCheck={false}
      autoComplete="off"
      invalid={error !== null}
      invalidText={error ?? undefined}
      warn={warning !== null}
      warnText={warning ?? undefined}
      onChange={(e) => {
        setText(e.target.value);
        setRefusal(null);
        setEditing(true);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') {
          setText(value);
          setRefusal(null);
          setEditing(false);
        }
      }}
    />
  );
}
