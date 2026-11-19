// The note: every note fact in one place — text anchored at one point by
// a thin leader line, typed on the plot, in place. Like a figure label it has
// no card: the text sits on a halo of the plot's colour. Imports only
// `catalog/types`, `shapeKit` and `format`.
import { createElement, Fragment } from 'react';
import { NoteIcon } from '../../icons';
import type { DrawingTool } from '../types';
import { ANCHOR_R, finite, hitRect, LEADER_WIDTH, labelProps, noteCallout } from '../shapeKit';
import { NoteShape } from './Shape';

const LONG = 'Note';
/** Longest note body shown in its object name before it is cut with an ellipsis. */
const NOTE_MAX = 24;

export const NOTE_TOOL: DrawingTool = {
  kind: 'note',
  code: 5,
  // `short` is also the noun of its commit labels: Draw / Move / Edit / Delete Note.
  label: { long: LONG, short: 'Note' },
  icon: NoteIcon,

  arity: 1,
  axes: 'xy',
  key: 'n',
  railGroup: 'mark',
  menuAdd: { label: 'Add note here' },
  inlineText: true,

  shapePoint: (p) => p,

  geometry(a, grid, ctx) {
    const { left, width } = grid.gridRect;
    const right = left + width;
    if (a.points.length === 0) return null;
    if (!grid.axisIds.includes(a.axisId)) return null;
    const xs = a.points.map((p) => grid.tToX(p.t));
    if (!finite(...xs)) return null;
    const ys = a.points.map((p) => grid.vToY(p.v, a.axisId));
    if (!finite(...ys)) return null;

    const x = xs[0];
    const y = ys[0];
    const { bx, by, w, h } = noteCallout(x, y, a.text, right);
    const flip = bx < x;
    // The leader runs from the anchor to the near end of the text's baseline.
    const lx = flip ? x - 14 : x + 14;
    const leader = `M${x} ${y}L${lx} ${y - 14}`;
    return {
      body: createElement(
        Fragment,
        null,
        createElement('path', {
          key: 'leader',
          d: leader,
          stroke: a.color,
          strokeWidth: LEADER_WIDTH,
          fill: 'none',
          pointerEvents: 'none',
        }),
        createElement('circle', {
          key: 'anchor',
          cx: x,
          cy: y,
          r: ANCHOR_R,
          fill: a.color,
          pointerEvents: 'none',
        }),
        createElement(
          'text',
          {
            key: 'text',
            x: flip ? lx - 2 : lx + 2,
            y: by + 14,
            textAnchor: flip ? 'end' : 'start',
            ...labelProps(ctx.theme, a.color),
          },
          a.text
        )
      ),
      outline: [leader],
      hits: createElement(
        Fragment,
        null,
        hitRect(bx, by, w, h, 'f'),
        createElement('circle', {
          key: 'a',
          cx: x,
          cy: y,
          r: 8,
          fill: 'transparent',
          pointerEvents: 'all',
          'data-annotation-hit': '',
        })
      ),
      handles: [[x, y]],
      lockAt: [bx + w, by],
    };
  },
  Shape: NoteShape,

  objName(a) {
    const body = a.text.replace(/\s+/g, ' ').trim();
    if (body === '') return 'Note';
    const short = body.length > NOTE_MAX ? `${body.slice(0, NOTE_MAX - 1)}…` : body;
    return `Note “${short}”`;
  },
  hint: () => `${LONG}: click to place, then type`,

  fields: [],
  codec: { layout: 'tv' },
};
