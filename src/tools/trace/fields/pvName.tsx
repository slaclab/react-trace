// Trace's PV name custom field: the
// workbench's PV field (PvCombo with its capture-phase Escape rule) over a
// search scoped to the curve's archiver — the curve's own override, else its
// plot's default — as today's RightPanel. The combo commits on Enter, a pick
// or blur; the schema's `set` decides what a commit does (the unit
// re-assignment runs only when the PV changed).

import { useMemo, type ReactNode } from 'react';
import { moleSearch } from '../../../pvSearch';
import { PvFieldControl } from '../../../workbench/fields/PvFieldControl';

export interface PvNameControlProps {
  /** The `#id` (Properties only). */
  id?: string;
  /** The committed PV; '' while the curve has none. */
  value: string;
  /** The archiver whose index the search reads; undefined = the backend default. */
  archiver: string | undefined;
  onChange(pv: string): void;
}

export function PvNameControl({ id, value, archiver, onChange }: PvNameControlProps): ReactNode {
  const search = useMemo(() => moleSearch({ archiver }), [archiver]);
  return (
    <PvFieldControl id={id} value={value} label="PV name" search={search} onCommit={onChange} />
  );
}
