// Correlation's Lookback custom field (Plot › Acquisition). The value is
// `state.lookback`, a span in Trace's syntax ("30m", "1.5h") within
// [1m, 24h] — what `lookback=` carries. The text is
// local while typing and committed on blur or Enter: a valid span is written
// (clamped to the bounds, as the query parser clamps), anything else shows the
// error and writes nothing. Escape restores the committed value.

import { useState, type ReactNode } from 'react';
import { TextInput } from '@carbon/react';
import { commitLookback, LOOKBACK_ERROR } from './lookbackSpan';

export interface LookbackControlProps {
  /** The input's `#id` (the field's Properties hook). */
  id?: string;
  value: string;
  disabled?: boolean;
  onChange(value: string): void;
}

export function LookbackControl({
  id,
  value,
  disabled,
  onChange,
}: LookbackControlProps): ReactNode {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | undefined>(undefined);
  // Re-sync from an outside change (load, reset) during render.
  const [syncedFrom, setSyncedFrom] = useState(value);
  if (value !== syncedFrom) {
    setSyncedFrom(value);
    setText(value);
    setError(undefined);
  }

  const commit = () => {
    const next = commitLookback(text);
    if (next === null) {
      setError(LOOKBACK_ERROR);
      return;
    }
    setError(undefined);
    setText(next);
    if (next !== value) onChange(next);
  };

  return (
    <TextInput
      id={id ?? 'correlation-lookback'}
      labelText="Lookback"
      hideLabel
      size="sm"
      value={text}
      disabled={disabled}
      invalid={error !== undefined}
      invalidText={error}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') {
          setText(value);
          setError(undefined);
        }
      }}
    />
  );
}
