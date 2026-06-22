import { canopyFetch } from './client';
import type { FormulaResultDTO, FormulaSpecDTO, FormulaValidationDTO } from './types';

// Parse + typecheck a formula without evaluating — drives the editor's live
// red-lining as the user types.
export async function validateFormula(
  spec: FormulaSpecDTO,
  signal?: AbortSignal
): Promise<FormulaValidationDTO> {
  return canopyFetch<FormulaValidationDTO>('/fox/v1/validate', {
    method: 'POST',
    body: spec,
    signal,
  });
}

// One-shot evaluation over a fixed window (`t1Ns: 0` means "now"). Live formula
// curves use the WebSocket (formulaWsUrl) for push updates; this REST path serves
// absolute/static windows.
export async function evaluateFormula(
  spec: FormulaSpecDTO,
  t0Ns: number,
  t1Ns: number,
  signal?: AbortSignal
): Promise<FormulaResultDTO> {
  return canopyFetch<FormulaResultDTO>('/fox/v1/evaluate', {
    method: 'POST',
    body: { spec, t0Ns, t1Ns },
    signal,
  });
}

// Same-origin WS URL for live formula subscriptions. The Vite dev proxy (and any
// prod reverse proxy) handle the /fox upgrade and inject X-API-Key, so the bundle
// never holds the key. SSR-safe: returns an empty string when `window` is undefined.
export function formulaWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/fox/v1/ws/formulas`;
}
