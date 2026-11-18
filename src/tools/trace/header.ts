// Trace's heading at the head of the actions row (WorkbenchLayout's
// `heading`). Standalone: the product name, then the active plot's
// "N Live • N Archive" counter. Embedded: the counter alone, since the host's
// tile bar already names the tool.

import type { WorkbenchHeading } from '../../workbench/WorkbenchLayout';

/**
 * The name Trace shows: canopy-shell AppHeader's `prefix` and `productName`.
 * The prefix belongs to the site (a deployment's site config is to set it);
 * built in it is empty, so the heading reads "Trace".
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

/** The heading for the active plot: the name standalone, the counter always. Pure. */
export function traceHeading(
  plot: Parameters<typeof liveArchiveCounter>[0],
  embedded: boolean
): WorkbenchHeading {
  const status = liveArchiveCounter(plot);
  return embedded
    ? { status }
    : { prefix: TRACE_HEADER.prefix, name: TRACE_HEADER.productName, status };
}
