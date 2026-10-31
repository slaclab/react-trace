// One control per field kind. `FieldControl` is the bare control: the properties panel wraps
// it in `Field`'s label/dot/reset chrome, the Outline renders a row slot
// (`row: 'swatch' | 'eye'`) or a section header field with it directly.
//
// Every control reads through `field.get(ctx)` and writes through
// `field.set(ctx, value)`; nothing here knows a default. Hooks follow the
// placement (`fieldHooks`): `#id` on the Properties rendering only, a header
// field's `data-testid=<field id>`, nothing on a row slot. A `disabled(ctx)`
// reason disables the control (the chrome shows the reason). Each control
// carries its own accessible name, so the chrome's label is visual only.

import { useId, useState, type ReactNode } from 'react';
import { Button, Select, SelectItem, TextInput, Toggle } from '@carbon/react';
import { Copy, View, ViewOff } from '@carbon/icons-react';
import type { FieldDef, FieldOption, ToolContext, ToolUi } from '../types';
import { disabledReason, parseNumber } from './logic';
import { ColourSwatch } from './ColourSwatch';
import { PvFieldControl } from './PvFieldControl';
import { fieldHooks, type FieldPlacement } from './hooks';

export interface FieldControlProps<S, M, U extends ToolUi = ToolUi> {
  field: FieldDef<S, M, U>;
  ctx: ToolContext<S, M, U>;
  placement?: FieldPlacement;
  /** Appended to the `#id` of a repeated block's copy; see `fieldHooks`. */
  idSuffix?: string;
}

export function FieldControl<S, M, U extends ToolUi = ToolUi>({
  field,
  ctx,
  placement = 'properties',
  idSuffix,
}: FieldControlProps<S, M, U>): ReactNode {
  const { id, testId } = fieldHooks(field, placement, idSuffix);
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const disabled = disabledReason(field, ctx) !== false;
  const small = placement === 'row';

  switch (field.kind) {
    case 'text':
      return (
        <TextInput
          id={controlId}
          labelText={field.label}
          hideLabel
          size="sm"
          placeholder={field.placeholder}
          value={field.get(ctx)}
          disabled={disabled}
          data-testid={testId}
          onChange={(e) => field.set(ctx, e.target.value)}
        />
      );
    case 'number':
      return (
        <NumberControl
          id={controlId}
          label={field.label}
          value={field.get(ctx)}
          min={field.min}
          max={field.max}
          unit={field.unit}
          disabled={disabled}
          testId={testId}
          onChange={(value) => field.set(ctx, value)}
        />
      );
    case 'select':
      return (
        <Select
          id={controlId}
          labelText={field.label}
          hideLabel
          size="sm"
          value={field.get(ctx)}
          disabled={disabled}
          data-testid={testId}
          onChange={(e) => field.set(ctx, e.target.value)}
        >
          {field.options(ctx).map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              text={option.disabled ? `${option.label} (${option.disabled})` : option.label}
              disabled={option.disabled !== undefined}
              title={option.disabled}
            />
          ))}
        </Select>
      );
    case 'segmented':
      return (
        <Segmented
          id={id}
          label={field.label}
          value={field.get(ctx)}
          options={field.options(ctx)}
          disabled={disabled}
          testId={testId}
          onChange={(value) => field.set(ctx, value)}
        />
      );
    case 'toggle': {
      const on = field.get(ctx);
      if (field.row === 'eye' && placement !== 'properties') {
        const name = `${on ? 'Hide' : 'Show'} ${field.label.toLowerCase()}`;
        return (
          <button
            type="button"
            className={`wb-eye${on ? '' : ' wb-eye--off'}`}
            aria-label={name}
            title={name}
            aria-pressed={on}
            disabled={disabled}
            data-testid={testId}
            onClick={() => field.set(ctx, !on)}
          >
            {on ? <View size={16} /> : <ViewOff size={16} />}
          </button>
        );
      }
      return (
        <Toggle
          id={controlId}
          labelText={field.label}
          hideLabel
          // The panel's switch is Carbon's standard one; a row keeps
          // the small switch at its compact density.
          size={small ? 'sm' : 'md'}
          toggled={on}
          disabled={disabled}
          data-testid={testId}
          onToggle={(checked: boolean) => field.set(ctx, checked)}
        />
      );
    }
    case 'colour':
      return (
        <ColourSwatch
          value={field.get(ctx)}
          label={field.label}
          disabled={disabled}
          testId={testId}
          small={small}
          onChange={(colour) => field.set(ctx, colour)}
        />
      );
    case 'pv':
      return (
        <PvFieldControl
          id={id}
          value={field.get(ctx)}
          label={field.label}
          disabled={disabled}
          testId={testId}
          search={field.search}
          onCommit={(pv) => field.set(ctx, pv)}
        />
      );
    case 'readonly':
      return (
        <output
          id={id}
          className="wb-field__readonly"
          data-testid={testId}
          aria-label={field.label}
        >
          {field.get(ctx)}
        </output>
      );
    case 'code':
      return <CodeBlock id={id} label={field.label} text={field.get(ctx)} testId={testId} />;
    case 'custom':
      return (
        <span className="wb-field__custom" data-testid={testId}>
          {field.render({
            ctx,
            value: field.get(ctx),
            onChange: (value: unknown) => field.set(ctx, value),
            id,
          })}
        </span>
      );
    case 'action':
      return (
        <Button
          id={id}
          kind="tertiary"
          size="sm"
          disabled={disabled}
          data-testid={testId}
          onClick={() => field.run(ctx)}
        >
          {field.label}
        </Button>
      );
  }
}

// ------------------------------------------------------------------ number --

function rangeText(min?: number, max?: number): string {
  if (min !== undefined && max !== undefined) return `Between ${min} and ${max}`;
  if (min !== undefined) return `At least ${min}`;
  if (max !== undefined) return `At most ${max}`;
  return 'A number';
}

function NumberControl({
  id,
  label,
  value,
  min,
  max,
  unit,
  disabled,
  testId,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null;
  min?: number;
  max?: number;
  unit?: string;
  disabled: boolean;
  testId?: string;
  onChange(value: number | null): void;
}) {
  // The typed text, so a half-typed "1." or "-" survives a render (a text
  // input: a number input sanitises "-" to ""); only a parsable value inside
  // the bounds is written. A new value from outside (a reset, another
  // selection) replaces the text.
  const [text, setText] = useState(value === null ? '' : String(value));
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    if (parseNumber(text) !== value) setText(value === null ? '' : String(value));
  }
  const invalid = parseNumber(text, { min, max }) === undefined;
  return (
    <span className="wb-field__number">
      <TextInput
        id={id}
        labelText={label}
        hideLabel
        size="sm"
        inputMode="decimal"
        value={text}
        invalid={invalid}
        invalidText={rangeText(min, max)}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseNumber(e.target.value, { min, max });
          if (parsed !== undefined) onChange(parsed);
        }}
      />
      {unit !== undefined && <span className="wb-field__unit">{unit}</span>}
    </span>
  );
}

// --------------------------------------------------------------- segmented --

function Segmented({
  id,
  label,
  value,
  options,
  disabled,
  testId,
  onChange,
}: {
  id?: string;
  label: string;
  value: string;
  options: FieldOption[];
  disabled: boolean;
  testId?: string;
  onChange(value: string): void;
}) {
  return (
    <div id={id} role="radiogroup" aria-label={label} className="wb-segmented" data-testid={testId}>
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            className={`wb-segmented__option${checked ? ' wb-segmented__option--checked' : ''}`}
            disabled={disabled || option.disabled !== undefined}
            title={option.disabled}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------------- code --

function CodeBlock({
  id,
  label,
  text,
  testId,
}: {
  id?: string;
  label: string;
  text: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <div className="wb-code">
      <pre id={id} className="wb-code__text" aria-label={label} data-testid={testId}>
        <code>{text}</code>
      </pre>
      <Button
        kind="ghost"
        size="sm"
        renderIcon={Copy}
        className="wb-code__copy"
        onClick={() => void copy()}
      >
        {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
      </Button>
    </div>
  );
}
