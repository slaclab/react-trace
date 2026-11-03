import { useState } from 'react';
import {
  Button,
  Checkbox,
  ComposedModal,
  DismissibleTag,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Dropdown,
  Search,
  Tag,
} from '@carbon/react';
import { usePVSearch } from '../hooks/usePVSearch';
import type { Plot } from '../types';

// Mole caps `limit` at 1000 and its Appliance adapter fetches every match
// before slicing, so a larger limit costs the archiver nothing; it only bounds
// the payload and the list. 500 stays scrollable.
export const PV_SEARCH_LIMIT = 500;

// The archiver returns matches in no useful order. Numeric-aware so that
// KLYS:LI21:2 lists before KLYS:LI21:11.
const collator = new Intl.Collator(undefined, { numeric: true });

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

interface PVSearchModalProps {
  open: boolean;
  /** Every plot: the target picker lists them and marks PVs already on the target. */
  plots: Plot[];
  /** The plot the dialog was opened for; the target picker starts there. */
  initialPlotId: string;
  onAdd: (plotId: string, pvNames: string[]) => void;
  onClose: () => void;
}

// Bulk PV entry (#43), after the Python Trace archive search window: type a
// pattern, tick the matches you want, Add. Ticks outlive the pattern, so PVs
// can be gathered from several searches; the Selected strip keeps every tick
// in view. Double-clicking a match adds it together with the selection. The
// parent keys this component per open, so each open mounts a fresh instance
// with an empty pattern and selection.
export function PVSearchModal({ open, plots, initialPlotId, onAdd, onClose }: PVSearchModalProps) {
  const [pattern, setPattern] = useState('');
  const [targetPlotId, setTargetPlotId] = useState(initialPlotId);
  // Ticks name PVs on the archiver that listed them, which another archiver
  // may not have, so the selection remembers its archiver and counts for
  // nothing once the target reads from a different one. Insertion-ordered:
  // PVs are added in the order they were ticked.
  const [selection, setSelection] = useState<{
    archiver: string | undefined;
    pvs: ReadonlySet<string>;
  }>(() => ({ archiver: plots.find((p) => p.id === initialPlotId)?.archiver, pvs: new Set() }));

  const target = plots.find((p) => p.id === targetPlotId) ?? plots[0];
  // Search the target plot's archiver: that is where the new traces will read.
  // A closed dialog searches nothing, even if its pattern or plot changes.
  const search = usePVSearch(open ? pattern : '', target?.archiver, 300, PV_SEARCH_LIMIT);
  const selected = selection.archiver === target?.archiver ? selection.pvs : EMPTY_SELECTION;
  // Every change starts from the effective selection, so a stale one is dropped.
  const setSelected = (update: (prev: ReadonlySet<string>) => ReadonlySet<string>) =>
    setSelection({ archiver: target?.archiver, pvs: update(selected) });

  const rows = [...search.pvs].sort(collator.compare);
  const chosen = [...selected];
  const listedChosen = rows.filter((pv) => selected.has(pv));
  const allListed = rows.length > 0 && listedChosen.length === rows.length;
  const onPlot = new Set(target?.traces.map((t) => t.pvName) ?? []);

  const toggle = (pv: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pv)) next.delete(pv);
      else next.add(pv);
      return next;
    });
  // Select all acts on the listed matches only; ticks from earlier searches stay.
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const pv of rows) {
        if (allListed) next.delete(pv);
        else next.add(pv);
      }
      return next;
    });
  const remove = (pv: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(pv);
      return next;
    });
  const add = (pvNames: string[]) => {
    if (target && pvNames.length > 0) onAdd(target.id, pvNames);
  };

  let status: string;
  if (search.status === 'loading') {
    status = 'Searching…';
  } else if (search.status === 'error') {
    status = `Search failed: ${search.error?.detail || search.error?.code || 'unknown error'}`;
  } else if (search.status === 'ready') {
    status = search.truncated
      ? `Showing the first ${PV_SEARCH_LIMIT} matches. Narrow the pattern to see others.`
      : `${search.pvs.length} match${search.pvs.length === 1 ? '' : 'es'}`;
  } else {
    status = 'Type part of a PV name. * matches any characters, ? matches one.';
  }

  return (
    <ComposedModal
      open={open}
      onClose={onClose}
      size="md"
      selectorPrimaryFocus="#pv-search-pattern"
    >
      <ModalHeader title="Search PVs" label={target ? `Add to ${target.title}` : undefined} />
      <ModalBody className="pv-search__body">
        {plots.length > 1 && (
          <Dropdown
            id="pv-search-target"
            titleText="Add to plot"
            label="Plot"
            size="sm"
            items={plots}
            itemToString={(p: Plot | null) => p?.title ?? ''}
            selectedItem={target}
            onChange={({ selectedItem }: { selectedItem?: Plot | null }) => {
              if (selectedItem) setTargetPlotId(selectedItem.id);
            }}
          />
        )}
        <Search
          id="pv-search-pattern"
          labelText="Pattern"
          placeholder="Pattern, e.g. KLYS:LI2*:PDES"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onClear={() => setPattern('')}
        />
        <div
          className="pv-search__status"
          role="status"
          style={{
            color: search.status === 'error' ? 'var(--cds-text-error)' : 'var(--cds-text-helper)',
          }}
        >
          {status}
        </div>
        {/* The results keep their place while empty so the footer never jumps. */}
        <div className="pv-search__results">
          {rows.length > 0 && (
            <>
              <div className="pv-search__row pv-search__row--all">
                <Checkbox
                  id="pv-search-select-all"
                  labelText="Select all"
                  checked={allListed}
                  indeterminate={listedChosen.length > 0 && !allListed}
                  onChange={toggleAll}
                />
              </div>
              <ul className="pv-search__list" aria-label="Matches">
                {rows.map((pv, i) => (
                  <li
                    key={pv}
                    className="pv-search__row"
                    onDoubleClick={() => add(selected.has(pv) ? chosen : [...chosen, pv])}
                  >
                    <Checkbox
                      id={`pv-search-row-${i}`}
                      labelText={pv}
                      checked={selected.has(pv)}
                      onChange={() => toggle(pv)}
                    />
                    {onPlot.has(pv) && (
                      <Tag size="sm" type="cool-gray">
                        on plot
                      </Tag>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        {/* Below the list so that appearing never moves a row under the pointer
            between the two clicks of a double-click. */}
        {chosen.length > 0 && (
          <div className="pv-search__selected">
            <span className="pv-search__selected-label">Selected ({chosen.length})</span>
            <div className="pv-search__selected-tags">
              {chosen.map((pv) => (
                <DismissibleTag
                  key={pv}
                  size="sm"
                  type="blue"
                  text={pv}
                  title={`Remove ${pv}`}
                  onClose={() => remove(pv)}
                />
              ))}
            </div>
            <Button kind="ghost" size="sm" onClick={() => setSelected(() => new Set())}>
              Clear
            </Button>
          </div>
        )}
      </ModalBody>
      <ModalFooter
        secondaryButtonText="Cancel"
        primaryButtonText={
          chosen.length > 0 ? `Add ${chosen.length} PV${chosen.length === 1 ? '' : 's'}` : 'Add PVs'
        }
        primaryButtonDisabled={chosen.length === 0}
        onRequestSubmit={() => add(chosen)}
        onRequestClose={onClose}
      >
        {null}
      </ModalFooter>
    </ComposedModal>
  );
}
