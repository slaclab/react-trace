// A section's add row.
//
// One per Outline section, on the shared `PvCombo`. Enter or a pick hands
// the PV to the tool's async `ops.add`; leaving the field keeps the
// half-typed text and adds nothing (`commitOnBlur={false}`, no cancel). The
// row never judges the PV: capacity, duplicates and unit are the tool's
// commit writer's to check, against the latest state, and a refusal comes
// back as `{message, action?}` and is shown under `outline-add-refusal`.
//
// One pending add per section: while `ops.add` runs the input is read-only,
// `outline-add-status` reads "checking…", and a second Enter or pick is
// dropped. A section at capacity shows a one-line note in place of the row
// (the count it shows is the outline's, so the note goes away as soon as an
// item leaves).

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@carbon/react';
import { PvCombo } from '../components/PvCombo';
import { TESTIDS } from './testids';
import type { AddRefusal, OutlineSection } from './types';

export interface OutlineAddRowProps {
  section: OutlineSection;
  /** The tool's `ops.add`, read through the binding's latest-ref. */
  add: (sectionId: string, pv: string) => Promise<AddRefusal | void>;
  /** Channel catalog ranked ahead of the search hits; the host's by default. */
  catalog?: readonly string[];
  archiver?: string;
}

/** Whether the section has no room left for another item. */
function sectionIsFull(section: OutlineSection): boolean {
  return section.capacity !== undefined && section.count >= section.capacity;
}

export function OutlineAddRow({ section, add, catalog, archiver }: OutlineAddRowProps) {
  const [pending, setPending] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<AddRefusal | null>(null);
  // Bumped after a successful add so the field starts empty again; PvCombo
  // keeps its own typed text and only reseeds it from a new `value`.
  const [generation, setGeneration] = useState(0);
  // The in-flight guard is a ref: two commits in one event turn must not
  // both see `pending === null`.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // PvCombo has no read-only prop; the input is marked directly while an
  // add is in flight (and the commit guard below drops anything that still
  // gets through).
  useEffect(() => {
    const input = wrap.current?.querySelector('input');
    if (!input) return;
    input.readOnly = pending !== null;
    if (pending !== null) input.setAttribute('aria-busy', 'true');
    else input.removeAttribute('aria-busy');
  }, [pending, generation]);

  const add_ = section.add;
  if (!add_) return null;

  if (sectionIsFull(section)) {
    return (
      <p className="wb-outline-add__full">
        {section.title} is full ({section.count}/{section.capacity})
      </p>
    );
  }

  const disabledReason = typeof add_.disabled === 'string' ? add_.disabled : null;

  const commit = (pv: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(pv);
    setRefusal(null);
    let result: Promise<AddRefusal | void>;
    try {
      result = add(section.id, pv);
    } catch (err) {
      result = Promise.reject(err);
    }
    result.then(
      (refused) => {
        inFlight.current = false;
        if (!mounted.current) return;
        setPending(null);
        if (refused) {
          setRefusal(refused);
        } else {
          setGeneration((g) => g + 1);
        }
      },
      (err: unknown) => {
        inFlight.current = false;
        if (!mounted.current) return;
        setPending(null);
        setRefusal({ message: err instanceof Error ? err.message : String(err) });
      }
    );
  };

  // While an add runs, keys that would edit or submit the field stop here,
  // before the combobox sees them; Tab and Escape still move focus out.
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (pending === null || e.key === 'Tab' || e.key === 'Escape') return;
    if (e.key === 'Enter' || e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <div className="wb-outline-add" data-section={section.id}>
      <div ref={wrap} className="wb-outline-add__field" onKeyDownCapture={onKeyDownCapture}>
        <PvCombo
          key={generation}
          id={`outline-add-${section.id}`}
          titleText={add_.placeholder}
          hideLabel
          placeholder={add_.placeholder}
          value=""
          search={add_.search}
          archiver={archiver}
          catalog={catalog}
          inputTestId={TESTIDS.outlineAddInput}
          disabled={disabledReason !== null}
          commitOnBlur={false}
          onInputChange={() => {
            if (refusal) setRefusal(null);
          }}
          onCommit={commit}
        />
      </div>
      {disabledReason !== null && <p className="wb-outline-add__note">{disabledReason}</p>}
      {pending !== null && (
        <p
          className="wb-outline-add__status"
          data-testid={TESTIDS.outlineAddStatus}
          aria-live="polite"
        >
          checking…
        </p>
      )}
      {refusal !== null && (
        <div
          className="wb-outline-add__refusal"
          role="alert"
          data-testid={TESTIDS.outlineAddRefusal}
        >
          <span>{refusal.message}</span>
          {refusal.action && (
            <Button kind="ghost" size="sm" onClick={refusal.action.onClick}>
              {refusal.action.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
