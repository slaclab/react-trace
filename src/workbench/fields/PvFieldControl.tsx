// The `pv` field's control: the shared PV
// field (`PvCombo`) with the workbench's Escape rule.
//
// Escape must be handled in the capture phase. With the menu closed, Downshift
// answers Escape by clearing the input (`selectedItem: null, inputValue: ''`)
// before any bubbling handler runs, and PvCombo exposes no way to write the
// text back. So, on the wrapper, before Downshift sees the key:
// - a draft (typed text that is not the committed PV) is reverted to the
//   committed PV and the key goes no further: the first Escape is the field's;
// - a clean field keeps its text (`preventDownshiftDefault`) and the key goes
//   on up, where the workbench root may take it (go to tool level);
// - an open menu over a clean field is left to Carbon, which closes it.
// The revert remounts the combo, which re-seeds its text from the committed
// PV, and gives the focus back to its input.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { PvCombo } from '../../components/PvCombo';
import type { PvSearch } from '../../pvSearch';

export interface PvFieldControlProps {
  /** The committed PV; '' while there is none. */
  value: string;
  onCommit(pv: string): void;
  label: string;
  /** The `#id` (Properties only). */
  id?: string;
  testId?: string;
  disabled?: boolean;
  search?: PvSearch;
}

type DownshiftKeyEvent = Event & { preventDownshiftDefault?: boolean };

export function PvFieldControl({
  value,
  onCommit,
  label,
  id,
  testId,
  disabled,
  search,
}: PvFieldControlProps) {
  const fallbackId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(value);
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setDraft(value);
  }
  // Bumped by a revert: a new combo seeds its text from `value`.
  const [generation, setGeneration] = useState(0);
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    wrapper.current?.querySelector('input')?.focus();
  }, [generation]);

  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    const open = wrapper.current?.querySelector('[aria-expanded="true"]') != null;
    if (draft !== value) {
      (e.nativeEvent as DownshiftKeyEvent).preventDownshiftDefault = true;
      e.stopPropagation();
      setDraft(value);
      refocus.current = true;
      setGeneration((g) => g + 1);
      return;
    }
    // Clean: never let Downshift wipe the committed PV off a closed field.
    if (!open) (e.nativeEvent as DownshiftKeyEvent).preventDownshiftDefault = true;
  };

  return (
    <div ref={wrapper} className="wb-pv-field" onKeyDownCapture={onKeyDownCapture}>
      <PvCombo
        key={generation}
        id={id ?? fallbackId}
        value={value}
        onCommit={onCommit}
        onInputChange={setDraft}
        search={search}
        titleText={label}
        hideLabel
        disabled={disabled}
        inputTestId={testId}
      />
    </div>
  );
}
