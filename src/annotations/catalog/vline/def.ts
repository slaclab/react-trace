// The V-line tool: one x, drawn the full height of its grid. Every
// V-line fact lives here; it uses no value axis, so it draws on any grid.
import { createElement, Fragment } from 'react';
import { VerticalLineIcon } from '../../icons';
import type { DrawingTool } from '../types';
import { finite, hitPath, label, strokeOf } from '../shapeKit';
import { VlineShape } from './Shape';

export const VLINE_TOOL: DrawingTool = {
  kind: 'vline',
  code: 1,
  label: { long: 'Vertical line', short: 'V-line' },
  icon: VerticalLineIcon,

  arity: 1,
  axes: 'x',
  key: 'v',
  railGroup: 'line',
  menuAdd: { label: 'Add vertical line here' },

  shapePoint: (p) => ({ t: p.t, v: 0 }),

  geometry(a, grid, ctx) {
    if (a.points.length === 0) return null;
    const x = grid.tToX(a.points[0].t);
    if (!finite(x)) return null;
    const { top, height } = grid.gridRect;
    const bot = top + height;
    const midY = (top + bot) / 2;
    const d = `M${x} ${top}V${bot}`;
    return {
      body: createElement(
        Fragment,
        null,
        createElement('path', { d, ...strokeOf(a) }),
        label(ctx.theme, x + 4, top + 12, a.text, a.color)
      ),
      outline: [d],
      hits: hitPath(d, 'h0'),
      handles: [[x, midY]],
      lockAt: [x, midY],
    };
  },
  Shape: VlineShape,

  objName: (a, ctx) => `V-line ${ctx.xAxis.format(a.points[0].t, 'name')}`,
  hint: () => 'Vertical line: click to place',

  fields: [],
  codec: { layout: 't' },
};
