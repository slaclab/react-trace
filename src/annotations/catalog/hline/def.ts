// The horizontal line: every H-line fact in one place. Imports only
// `catalog/types`, `shapeKit` and `format`.
import { createElement, Fragment } from 'react';
import { HorizontalLineIcon } from '../../icons';
import type { DrawingFieldSpec, DrawingTool, ShapeProps } from '../types';
import { finite, hitPath, label, strokeOf } from '../shapeKit';
import { axisUnit, fmtValue, withUnit } from '../format';
import { HLineShape } from './Shape';

type Annotation = ShapeProps['annotation'];

const LONG = 'Horizontal line';

/** Inspector field: the line's value (today's id `annotation-value`). */
const VALUE_FIELD: DrawingFieldSpec = {
  id: 'annotation-value',
  label: 'Value',
  kind: 'number',
  get: (a) => a.points[0]?.v ?? null,
  set: (a: Annotation, v: number | null): Annotation => {
    if (v === null || !Number.isFinite(v)) return a;
    const [p0, ...rest] = a.points;
    if (p0 === undefined || p0.v === v) return a;
    return { ...a, points: [{ ...p0, v }, ...rest] };
  },
};

export const HLINE_TOOL: DrawingTool = {
  kind: 'hline',
  code: 0,
  label: { long: LONG, short: 'H-line' },
  icon: HorizontalLineIcon,

  arity: 1,
  axes: 'y',
  key: 'h',
  railGroup: 'line',
  menuAdd: { label: 'Add horizontal line here' },

  shapePoint: (p) => ({ t: 0, v: p.v }),

  geometry(a, grid, ctx) {
    const { left, width } = grid.gridRect;
    const right = left + width;
    if (a.points.length === 0) return null;
    if (!grid.axisIds.includes(a.axisId)) return null;
    const xs = a.points.map((p) => grid.tToX(p.t));
    if (!finite(...xs)) return null;
    const ys = a.points.map((p) => grid.vToY(p.v, a.axisId));
    if (!finite(...ys)) return null;

    const y = ys[0];
    const d = `M${left} ${y}H${right}`;
    const mid = (left + right) / 2;
    return {
      body: createElement(
        Fragment,
        null,
        createElement('path', { key: 'line', d, ...strokeOf(a) }),
        createElement(
          Fragment,
          { key: 'label' },
          label(ctx.theme, left + 6, y - 4, a.text, a.color)
        )
      ),
      outline: [d],
      hits: hitPath(d, 'h0'),
      handles: [[mid, y]],
      lockAt: [mid, y],
    };
  },
  Shape: HLineShape,

  objName(a, ctx) {
    return `H-line ${withUnit(fmtValue(a.points[0].v), axisUnit(ctx.axis))}`;
  },
  hint: () => `${LONG}: click to place`,

  fields: [VALUE_FIELD],
  codec: { layout: 'v' },
};
