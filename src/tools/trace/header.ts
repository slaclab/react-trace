// Trace's heading at the head of the actions row (WorkbenchLayout's
// `heading`). Standalone: the product name, after the site's prefix and in
// the shell's brand colour when the site says so (src/site `header`), then
// the active plot's "N Live • N Archive" counter. Embedded: the counter
// alone, since the host's tile bar already names the tool.

import { siteDefaults } from '../../site/store';
import type { WorkbenchHeading } from '../../workbench/WorkbenchLayout';

/**
 * The name Trace shows: canopy-shell AppHeader's `prefix` and `productName`.
 * The prefix belongs to the site (its `header.prefix`, src/site); built in
 * it is this empty one, so the heading reads "Trace".
 */
export const TRACE_HEADER: { readonly prefix: string; readonly productName: string } = {
  prefix: '',
  productName: 'Trace',
};

/**
 * The counter of a plot's curves: how many read live data and how many read
 * the archive (a curve doing both counts in each), as the retired header
 * counted them. Pure.
 */
export function liveArchiveCounter(
  plot: { traces: readonly { useLive?: boolean; useArchive?: boolean }[] } | undefined
): string {
  const traces = plot?.traces ?? [];
  const live = traces.filter((t) => t.useLive).length;
  const archive = traces.filter((t) => t.useArchive).length;
  return `${live} Live • ${archive} Archive`;
}

/**
 * The heading for the active plot: the name standalone, the counter always.
 * Pure but for the site's `header` (fixed for the page load).
 */
export function traceHeading(
  plot: Parameters<typeof liveArchiveCounter>[0],
  embedded: boolean
): WorkbenchHeading {
  const status = liveArchiveCounter(plot);
  if (embedded) return { status };
  const { prefix, brand } = siteDefaults().header;
  return { prefix, name: TRACE_HEADER.productName, status, ...(brand ? { brand: true } : {}) };
}
