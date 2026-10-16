import { useEffect, useMemo, useRef, useState } from 'react';
import { CanopyError, type FormulaSpec } from '@slaclab/canopy-client';
import { useCanopyConnection } from '@slaclab/canopy-react';
import { evaluateFormula } from '../api/fox';
import { nsToMs, type TimeWindowNs } from '../api/time';
import type { PVTrace } from '../types';

export type FormulaSeriesStatus = 'idle' | 'ready' | 'error';

export interface FormulaSeriesResult {
  status: FormulaSeriesStatus;
  points: [number, number][];
  decimated?: boolean;
  error?: { code: string; detail: string };
}

const IDLE_RESULT: FormulaSeriesResult = { status: 'idle', points: [] };
const EMPTY_SERIES = new Map<string, FormulaSeriesResult>();

// Evaluates each formula trace over its plot window via Fox's one-shot REST
// endpoint. Mirrors useArchiveSeries' signature-gating so the work only re-fires
// when a spec or window actually changes (TraceApp rebuilds the maps every
// render). State is only updated from the async result callbacks; the prior
// result is left in place while a re-evaluation is in flight, so panning doesn't
// blank the curve. Live push updates are a follow-up (the SDK's
// FoxFormulaService over the Fox WebSocket).
export function useFormulaSeries(
  traces: PVTrace[],
  // Per-trace resolved Fox spec (bindings already mapped to PV names). `null`
  // means the formula isn't ready (empty / unbound) and is skipped.
  specByTrace: Map<string, FormulaSpec | null>,
  windowByTrace: Map<string, TimeWindowNs>
): Map<string, FormulaSeriesResult> {
  const conn = useCanopyConnection();
  const [results, setResults] = useState<Map<string, FormulaSeriesResult>>(EMPTY_SERIES);
  const abortByTrace = useRef(new Map<string, AbortController>());

  const signature = traces
    .map((t) => {
      if (t.kind !== 'formula') return `${t.id}:off`;
      const spec = specByTrace.get(t.id);
      const win = windowByTrace.get(t.id);
      if (!spec || !win) return `${t.id}:incomplete`;
      return `${t.id}:${JSON.stringify(spec)}|${win.fromNs}-${win.toNs}`;
    })
    .join('||');

  useEffect(() => {
    const wanted = new Set<string>();
    for (const trace of traces) {
      if (trace.kind !== 'formula') continue;
      const spec = specByTrace.get(trace.id);
      const win = windowByTrace.get(trace.id);
      if (!spec || !win) continue;
      wanted.add(trace.id);

      abortByTrace.current.get(trace.id)?.abort();
      const ac = new AbortController();
      abortByTrace.current.set(trace.id, ac);

      evaluateFormula(conn, spec, win.fromNs, win.toNs, ac.signal)
        .then((res) => {
          if (ac.signal.aborted) return;
          const ts = res.timeseries;
          const points: [number, number][] = [];
          if (ts) {
            for (let i = 0; i < ts.tsNs.length; i++) {
              const v = ts.values[i];
              if (v != null && Number.isFinite(v)) points.push([nsToMs(ts.tsNs[i]), v]);
            }
          }
          setResults((prev) =>
            new Map(prev).set(trace.id, { status: 'ready', points, decimated: ts?.decimated })
          );
        })
        .catch((err: unknown) => {
          if (ac.signal.aborted || (err as { name?: string }).name === 'AbortError') return;
          const error =
            err instanceof CanopyError
              ? { code: err.code, detail: err.detail }
              : { code: 'unknown_error', detail: (err as Error).message ?? 'evaluation failed' };
          setResults((prev) => {
            const next = new Map(prev);
            const prior = prev.get(trace.id);
            next.set(trace.id, { status: 'error', points: prior?.points ?? [], error });
            return next;
          });
        });
    }

    // Abort in-flight evaluations for traces that are no longer formula-evaluable.
    // (Stale result entries are harmless — the returned map only surfaces current
    // formula traces — so we don't setState here.)
    for (const id of [...abortByTrace.current.keys()]) {
      if (!wanted.has(id)) {
        abortByTrace.current.get(id)?.abort();
        abortByTrace.current.delete(id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature captures the meaningful inputs
  }, [conn, signature]);

  // Project `results` down to the current formula traces. Memoized on the result
  // map and the set of formula trace ids so the returned reference stays stable
  // across unrelated re-renders (e.g. ~10 Hz live-data ticks). A fresh Map every
  // render would defeat TraceApp's downstream useMemo, which lists this as a dep,
  // churning props to every SinglePlot on every tick.
  const formulaIds = traces
    .filter((t) => t.kind === 'formula')
    .map((t) => t.id)
    .join('|');
  return useMemo(() => {
    if (results.size === 0) return EMPTY_SERIES;
    const out = new Map<string, FormulaSeriesResult>();
    for (const trace of traces) {
      if (trace.kind !== 'formula') continue;
      out.set(trace.id, results.get(trace.id) ?? IDLE_RESULT);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formulaIds captures the trace subset
  }, [results, formulaIds]);
}
