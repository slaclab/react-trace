import type { PVTrace } from './types';
import type { FormulaSpec } from '@slaclab/canopy-client';

// Formula variables are brace-delimited, e.g. {x1}, {alarm_pv}. Matches the
// Python trace's f:// syntax.
const VAR_RE = /\{([a-zA-Z_]\w*)\}/g;

// Unique {var} names referenced in an expression, in first-seen order. Drives
// the binding-table rows in the editor.
export function extractFormulaVars(expression: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of expression.matchAll(VAR_RE)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

// Resolve the bound variables a formula trace currently has (variable ->
// referenced trace id) into the Formula Engine's wire form (variable -> PV name). Unbound or
// unresolvable variables are simply omitted, so this is the "best effort" spec
// used for live validation as the user types. Formula-to-formula references and
// non-PV targets are skipped (deferred — see #33).
export function resolveBindings(trace: PVTrace, candidates: PVTrace[]): Record<string, string> {
  const out: Record<string, string> = {};
  const bindings = trace.bindings ?? {};
  for (const [variable, targetId] of Object.entries(bindings)) {
    const target = candidates.find((c) => c.id === targetId);
    if (target && target.kind !== 'formula' && target.pvName) out[variable] = target.pvName;
  }
  return out;
}

// Build the Formula Engine spec for evaluating/subscribing a formula trace, or null when
// it isn't ready: empty expression, no variables, or any referenced variable
// still unbound (so we don't fire incomplete evaluations).
export function resolveFormulaSpec(trace: PVTrace, candidates: PVTrace[]): FormulaSpec | null {
  const expression = trace.expression?.trim();
  if (!expression) return null;
  const vars = extractFormulaVars(expression);
  if (vars.length === 0) return null;
  const resolved = resolveBindings(trace, candidates);
  for (const v of vars) {
    if (!(v in resolved)) return null;
  }
  return { kind: 'timeseries', expression, bindings: resolved };
}
