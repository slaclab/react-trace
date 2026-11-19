// Where the drawing rail sits on a plot: its left inset and the x of its
// right edge, in wrapper px. The rail floats over the plot's left gutter, so a
// plot that draws a Y axis name there (Trace) widens that gutter by what the
// rail covers (components/plotOption `plotLayout`).

/** The rail's left inset from the plot's left edge. */
export const RAIL_LEFT = 2;

/**
 * The x of the rail's right edge: the inset, then its 1 px border, 2 px
 * padding, 24 px buttons, 2 px padding and 1 px border (DrawingRail's styles).
 */
export const RAIL_RIGHT = RAIL_LEFT + 1 + 2 + 24 + 2 + 1;
