import {
  canopyFetch,
  type AbortSignalLike,
  type CanopyConnection,
  type FormulaResultDTO,
  type FormulaSpec,
} from '@slaclab/canopy-client';

// Fox's REST endpoints. The SDK covers Fox's live-formula WebSocket
// (FormulaEngineService) but not these, so they stay here on its REST core.

// Result of POST /fox/v1/validate (canopy.fox.schemas.formula).
export interface FormulaValidationDTO {
  valid: boolean;
  tokens: string[];
  errors: string[];
}

// Parse + typecheck a formula without evaluating — drives the editor's live
// red-lining as the user types.
export async function validateFormula(
  conn: CanopyConnection,
  spec: FormulaSpec,
  signal?: AbortSignalLike
): Promise<FormulaValidationDTO> {
  return canopyFetch<FormulaValidationDTO>(conn, '/fox/v1/validate', {
    method: 'POST',
    body: spec,
    signal,
  });
}

// One-shot evaluation over a fixed window (`t1Ns: 0` means "now").
export async function evaluateFormula(
  conn: CanopyConnection,
  spec: FormulaSpec,
  t0Ns: number,
  t1Ns: number,
  signal?: AbortSignalLike
): Promise<FormulaResultDTO> {
  return canopyFetch<FormulaResultDTO>(conn, '/fox/v1/evaluate', {
    method: 'POST',
    body: { spec, t0Ns, t1Ns },
    signal,
  });
}
