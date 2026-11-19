// Status-line hint text: the armed tool's hint and the embedded notice, kept
// apart from StatusLine.tsx so that module exports only its component
// (react-refresh/only-export-components).
import type { Catalog, HintContext } from './catalog/types';
import type { Tool } from './tools';

/**
 * The armed tool's status-line hint, from its definition's `hint` in
 * `catalog`; `null` for the cursor (nothing armed) or a kind the catalog
 * does not offer.
 */
export function toolHintIn(
  catalog: Catalog,
  tool: Tool | undefined,
  ctx: HintContext
): string | null {
  if (!tool || tool === 'cursor') return null;
  return catalog.byKind(tool)?.hint(ctx) ?? null;
}

export const EMBEDDED_UNSAVED_HINT = 'Drawings on this plot are not saved in the tile';

/**
 * The embedded notice for the plot at `plotIndex`: only plot 0 is published
 * to the host tile, so any other plot's drawings are lost. `null` when not
 * embedded, on plot 0, or when the index is unknown.
 */
export function embeddedHintFor(plotIndex: number | undefined, embedded: boolean): string | null {
  if (!embedded || plotIndex === undefined || plotIndex <= 0) return null;
  return EMBEDDED_UNSAVED_HINT;
}
