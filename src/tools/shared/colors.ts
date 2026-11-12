// The automatic Y colours of the context tools (Correlation, Waveform). A
// curve's colour is its pinned colour, else `autoYColor(position)`; the
// statistics panel draws each row in the colour its tool passes on the row.

/** Automatic Y colours in Y order (ECharts' default palette). */
export const Y_COLORS = [
  '#5470c6',
  '#91cc75',
  '#fac858',
  '#ee6666',
  '#73c0de',
  '#3ba272',
  '#fc8452',
  '#9a60b4',
];

/** The automatic colour of the Y at `index`, cycling through `Y_COLORS`. */
export function autoYColor(index: number): string {
  return Y_COLORS[((index % Y_COLORS.length) + Y_COLORS.length) % Y_COLORS.length];
}
