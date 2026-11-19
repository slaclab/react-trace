// Waveform's Element range custom field (Acquisition › More). The value is `state.elems` (null = all elements). The two
// texts are local while typing and committed together on blur or Enter: a
// valid range is written, anything else shows the error and writes nothing.
// Escape restores the committed value. The field's `#id` sits on First.

import { useState, type ReactNode } from 'react';
import { TextInput } from '@carbon/react';
import type { WaveformElementRange } from '../query';
import {
  commitElementRange,
  ELEMENT_RANGE_ERROR,
  elementRangeText,
  sameElementRange,
} from './elementRangeText';

export interface ElementRangeControlProps {
  /** The First input's `#id` (the field's Properties hook); Last gets `<id>-last`. */
  id?: string;
  value: WaveformElementRange | null;
  onChange(value: WaveformElementRange | null): void;
}

export function ElementRangeControl({ id, value, onChange }: ElementRangeControlProps): ReactNode {
  const base = id ?? 'element-range';
  const [first, setFirst] = useState(elementRangeText(value?.first));
  const [last, setLast] = useState(elementRangeText(value?.last));
  const [error, setError] = useState<string | undefined>(undefined);
  // Re-sync from an outside change (load, reset) during render.
  const [syncedFrom, setSyncedFrom] = useState(value);
  if (!sameElementRange(value, syncedFrom)) {
    setSyncedFrom(value);
    setFirst(elementRangeText(value?.first));
    setLast(elementRangeText(value?.last));
    setError(undefined);
  }

  const commit = () => {
    const next = commitElementRange(first, last);
    if (next === 'invalid') {
      setError(ELEMENT_RANGE_ERROR);
      return;
    }
    setError(undefined);
    if (!sameElementRange(next, value)) onChange(next);
  };
  const restore = () => {
    setFirst(elementRangeText(value?.first));
    setLast(elementRangeText(value?.last));
    setError(undefined);
  };
  const onKeyDown = (e: { key: string }) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') restore();
  };

  return (
    <span className="wb-waveform-element-range">
      <TextInput
        id={base}
        labelText="First element"
        placeholder="0"
        size="sm"
        inputMode="numeric"
        value={first}
        invalid={error !== undefined}
        invalidText={error}
        onChange={(e) => setFirst(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      <TextInput
        id={`${base}-last`}
        labelText="Last element"
        placeholder="last"
        size="sm"
        inputMode="numeric"
        value={last}
        invalid={error !== undefined}
        onChange={(e) => setLast(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    </span>
  );
}
