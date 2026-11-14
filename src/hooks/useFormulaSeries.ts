import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { FormulaSpec } from '@slaclab/canopy-client';
import { useCanopyConnection } from '@slaclab/canopy-react';
import { evaluateFormula } from '../api/formulaEngine';
import type { TimeWindowNs } from '../api/time';
import { FormulaStore, specKey } from '../state/formulaStore';
import type { PVTrace } from '../types';

export type FormulaSeriesStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface FormulaSeriesResult {
  status: FormulaSeriesStatus;
  points: [number, number][];
  decimated?: boolean;
  error?: { code: string; detail: string };
}

const IDLE_RESULT: FormulaSeriesResult = { status: 'idle', points: [] };
const LOADING_RESULT: FormulaSeriesResult = { status: 'loading', points: [] };
const EMPTY_SERIES = new Map<string, FormulaSeriesResult>();

// Evaluates each formula trace over its plot window through the Formula Engine's one-shot REST
// endpoint. The per-mount FormulaStore owns the requests and decides per trace
// when one is needed; this hook feeds it the current specs and windows and
// projects its snapshot onto the current formula traces. Live push updates are
// a follow-up (#104).
export function useFormulaSeries(
  traces: PVTrace[],
  // Per-trace resolved Formula Engine spec (bindings already mapped to PV names). `null`
  // means the formula isn't ready (empty / unbound) and shows nothing.
  specByTrace: Map<string, FormulaSpec | null>,
  windowByTrace: Map<string, TimeWindowNs>
): Map<string, FormulaSeriesResult> {
  // One store per Canopy connection (in practice one per mount).
  const conn = useCanopyConnection();
  const store = useMemo(
    () =>
      new FormulaStore({
        evaluate: (spec, t0Ns, t1Ns, signal) => evaluateFormula(conn, spec, t0Ns, t1Ns, signal),
      }),
    [conn]
  );

  const formula = traces.filter((t) => t.kind === 'formula');
  // Identity each trace should be showing; '' when it isn't evaluable.
  const keys = formula.map((t) => {
    const spec = specByTrace.get(t.id);
    return spec && windowByTrace.has(t.id) ? specKey(spec) : '';
  });

  // Trigger only: TraceApp rebuilds the maps every render, and the store decides
  // per trace whether an input change needs an evaluation.
  const signature = formula
    .map((t, i) => {
      const win = windowByTrace.get(t.id);
      return `${t.id}:${keys[i]}|${win ? `${win.fromNs}-${win.toNs}` : '-'}`;
    })
    .join('||');

  useEffect(() => {
    for (const t of formula) {
      store.request(t.id, {
        spec: specByTrace.get(t.id) ?? null,
        window: windowByTrace.get(t.id) ?? null,
      });
    }
    store.retain(new Set(formula.map((t) => t.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature captures the inputs
  }, [store, signature]);

  useEffect(() => () => store.dispose(), [store]);

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // Memoized on the snapshot and the (trace, identity) pairs, so the returned
  // reference stays stable across unrelated re-renders (e.g. ~10 Hz live-data
  // ticks) and TraceApp's downstream useMemo holds.
  const projectionKey = formula.map((t, i) => `${t.id}:${keys[i]}`).join('|');
  return useMemo(() => {
    if (formula.length === 0) return EMPTY_SERIES;
    const out = new Map<string, FormulaSeriesResult>();
    formula.forEach((t, i) => {
      const entry = snapshot.get(t.id);
      // Checked here as well as in the store, so even the first render after a
      // spec edit or a load (before the effect runs) never shows points that
      // belong to another spec.
      if (entry && entry.identity === keys[i]) out.set(t.id, entry);
      else out.set(t.id, keys[i] ? LOADING_RESULT : IDLE_RESULT);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- projectionKey captures the trace subset
  }, [snapshot, projectionKey]);
}
