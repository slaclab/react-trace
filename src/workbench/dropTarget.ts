// The attributes that make an element outside the Outline a drop target for
// a card (a plot's tab or grid cell): the Outline hit-tests them while a card
// is dragged off every section, when the tool's binding has `ops.drop`.

/** Marks the element; its value is the target id handed to `ops.drop`. */
export const DROP_TARGET_ATTR = 'data-workbench-drop';
/** The target's name in announcements ("TEST:SINE moved to Plot 2."). */
export const DROP_LABEL_ATTR = 'data-workbench-drop-label';
/** Set by the Outline while a card is over the target: `allowed` or `refused`. */
export const DROP_STATE_ATTR = 'data-workbench-drop-state';
