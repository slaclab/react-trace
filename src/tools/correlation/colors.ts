// Y colours: one function builds the PV -> colour map that the plot and the
// statistics rows (Strips, Readout, Distribution) all draw with. A Y's colour
// is its pinned `colors` record, else `autoYColor(position in state.ys)` — the
// position in the state, never in a table frame's columns, so a Y the server
// refuses (absent from the frame) never recolours a neighbour.

import { autoYColor } from '../shared/colors';
import type { CorrelationState } from './query';

/** Every Y PV's colour, in `state.ys` order: its pinned colour, else its automatic one. */
export function yColorMap(state: Pick<CorrelationState, 'ys' | 'colors'>): Map<string, string> {
  const map = new Map<string, string>();
  state.ys.forEach((pv, i) => {
    if (map.has(pv)) return;
    const pinned = Object.prototype.hasOwnProperty.call(state.colors, pv)
      ? state.colors[pv]
      : undefined;
    map.set(pv, pinned ?? autoYColor(i));
  });
  return map;
}
