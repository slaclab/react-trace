// A test-only drawing tool: a crosshair marking one
// full point. It exists to prove a new tool is one module plus one catalog
// line: everything the drawing core needs (identity, placement, geometry,
// text, its own Inspector field, link layout) lives here, and nothing outside
// this directory knows the kind `cross`. Code 900+ is the test-only range.
import { createElement, Fragment } from 'react';
import { Add } from '@carbon/icons-react';
import type { DrawingFieldSpec, DrawingTool } from '../../types';
import { finite, hitPath, label, strokeOf } from '../../shapeKit';
import { CrossShape } from './Shape';

/** Half the length of each crosshair arm, in px. */
export const CROSS_ARM = 6;

/** The tool's own Inspector field: the crosshair's x, edited as a number. */
export const CROSS_X_FIELD: DrawingFieldSpec = {
  id: 'cross-x',
  label: 'Cross X',
  kind: 'number',
  get: (a) => a.points[0]?.t ?? null,
  set: (a, value) => {
    const p = a.points[0];
    if (value === null || p === undefined || p.t === value) return a;
    return { ...a, points: [{ ...p, t: value }] };
  },
};

export const CROSS_TOOL: DrawingTool = {
  kind: 'cross',
  code: 900,
  label: { long: 'Crosshair', short: 'Cross' },
  icon: Add,

  arity: 1,
  axes: 'xy',
  key: 'x',

  shapePoint: (p) => ({ t: p.t, v: p.v }),

  geometry(a, grid, ctx) {
    if (a.points.length === 0) return null;
    const x = grid.tToX(a.points[0].t);
    const y = grid.vToY(a.points[0].v, a.axisId);
    if (!finite(x, y)) return null;
    const d = `M${x - CROSS_ARM} ${y}H${x + CROSS_ARM}M${x} ${y - CROSS_ARM}V${y + CROSS_ARM}`;
    return {
      body: createElement(
        Fragment,
        null,
        createElement('path', { key: 'cross', d, ...strokeOf(a) }),
        createElement(
          Fragment,
          { key: 'label' },
          label(ctx.theme, x + CROSS_ARM + 2, y - CROSS_ARM, a.text, a.color)
        )
      ),
      outline: [d],
      hits: hitPath(d, 'h0'),
      handles: [[x, y]],
      lockAt: [x, y],
    };
  },
  Shape: CrossShape,

  objName: (a, ctx) => `Cross ${ctx.xAxis.format(a.points[0].t, 'name')}`,
  hint: () => 'Crosshair: click to place',

  fields: [CROSS_X_FIELD],
  codec: { layout: 'tv' },
};
