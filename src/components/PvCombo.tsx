// The one PV-name field: the properties panel's PV Name, the Layers panel's
// add-trace row and the correlation plot's sections all take a PV through it.
//
// A Carbon ComboBox over two suggestion sources merged by `pvNameSuggestions`:
// the host's channel catalog, ranked in the browser (150 ms), then Mole's
// index through `search` (300 ms), which still lists archived-only PVs the
// catalog does not know. Keystrokes only drive the suggestions; the PV is
// committed on a pick, on Enter or on leaving the field with text (Carbon's
// custom-value rule), never per keystroke, since a committed PV starts an
// archive fetch and a live subscription. The helper line reports the search
// (searching, N matches, failed). Escape, or leaving the field with nothing
// typed, is a cancel for the callers that open the field on demand.

import { useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { ComboBox, type ComboBoxProps } from '@carbon/react';
import {
  moleSearch,
  pvNameSuggestions,
  useChannelMatches,
  usePVSearch,
  type PvSearch,
} from '../pvSearch';

export interface PvComboProps {
  id: string;
  /** The committed PV; '' while there is none. */
  value: string;
  onCommit: (pv: string) => void;
  /** Escape in the field, or the field left with nothing typed. */
  onCancel?: () => void;
  /** Every keystroke, for a caller with its own submit control. */
  onInputChange?: (text: string) => void;
  /**
   * Whether leaving the field with text commits it (Carbon's custom-value
   * rule), as the properties panel's PV Name does. Off for a row with its own
   * Add button, where leaving must not add a half-typed name.
   */
  commitOnBlur?: boolean;
  /** PV search; Mole's index of `archiver` by default. */
  search?: PvSearch;
  archiver?: string;
  /** Channel catalog ranked ahead of the search hits; the host's by default. */
  catalog?: readonly string[];
  titleText?: string;
  hideLabel?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** `data-testid` of the input. */
  inputTestId?: string;
}

const itemToString = (item: string | null | undefined) => item ?? '';

// The index re-exports the Dropdown's OnChangeData under the same name, so the
// ComboBox's (with `inputValue`) is read off its props.
type PvComboChange = Parameters<ComboBoxProps<string>['onChange']>[0];

export function PvCombo({
  id,
  value,
  onCommit,
  onCancel,
  onInputChange,
  commitOnBlur = true,
  search,
  archiver,
  catalog,
  titleText = 'PV name',
  hideLabel = false,
  placeholder = 'Type to search PVs',
  autoFocus = false,
  disabled = false,
  inputTestId,
}: PvComboProps) {
  const [query, setQuery] = useState(value);
  // A new committed value (another trace selected, a reset) replaces the
  // typed text; useState only seeds on mount.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setQuery(value);
  }
  // Stable across renders: the search hook re-fetches when it changes.
  const searchFn = useMemo(() => search ?? moleSearch({ archiver }), [search, archiver]);
  // While the text still equals the committed PV nothing is searched: a focus
  // on a filled field must not re-fetch matches for the PV already chosen.
  const pattern = query === value ? '' : query;
  const result = usePVSearch(pattern, searchFn);
  const channelHits = useChannelMatches(pattern, undefined, catalog);
  const items = pvNameSuggestions(value, channelHits, result.pvs);
  const suggestionCount = items.length - (value ? 1 : 0);
  const helperText =
    result.status === 'loading'
      ? 'Searching…'
      : result.status === 'error'
        ? `Search failed: ${result.error?.code ?? 'unknown'}`
        : result.status === 'ready' && pattern
          ? `${suggestionCount} match${suggestionCount === 1 ? '' : 'es'}`
          : '';

  // Set from the field's blur until its next focus: Carbon commits a custom
  // value on blur through a state change, so its onChange lands after the
  // blur event, and the flag tells that commit from a pick or an Enter.
  const blurred = useRef(false);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && onCancel) {
      e.stopPropagation();
      onCancel();
    }
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    // A pick in the open menu moves focus within the field: not a leave.
    if (!onCancel || e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (query.trim() === '') onCancel();
  };

  return (
    <div
      className={`pv-combo${hideLabel ? ' pv-combo--bare' : ''}`}
      onKeyDown={onKeyDown}
      onBlurCapture={() => {
        blurred.current = true;
      }}
      onFocusCapture={() => {
        blurred.current = false;
      }}
      onBlur={onBlur}
    >
      <ComboBox
        id={id}
        titleText={titleText}
        // Carbon names the input "Choose an item" by default; the title is
        // its name whether the label is shown or hidden (pv-combo--bare).
        aria-label={titleText}
        placeholder={placeholder}
        items={items}
        itemToString={itemToString}
        selectedItem={value || null}
        disabled={disabled}
        inputProps={{ autoFocus, 'data-testid': inputTestId } as object}
        onInputChange={(text: string) => {
          setQuery(text);
          onInputChange?.(text);
        }}
        onChange={({ selectedItem, inputValue }: PvComboChange) => {
          // A pick carries the item; Enter on a custom value carries the text;
          // the clear button carries neither and commits nothing.
          const pv = (selectedItem ?? inputValue ?? '').trim();
          if (!pv || (blurred.current && !commitOnBlur)) return;
          setQuery(pv);
          onCommit(pv);
        }}
        allowCustomValue
        helperText={helperText}
        size="sm"
      />
    </div>
  );
}
