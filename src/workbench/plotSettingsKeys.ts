// The plot-wide tab ids the panel treats specially, and the key a plot-wide
// section's open state is remembered under.

/** The tool-level tab that is the chart source, not a section. */
export const CODE_TAB = 'code';
/** The tool-level tab that also holds the `placement: 'axes'` sections. */
export const AXES_TAB = 'axes';

/** Where a plot-wide section's open state is remembered (also the chart source's). */
export function plotSectionKey(toolId: string, tabId: string): string {
  return `plot:${toolId}:${tabId}`;
}
