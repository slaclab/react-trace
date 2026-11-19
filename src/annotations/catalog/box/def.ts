// The Box tool: an axis-aligned rectangle between two full points on one
// value axis.
import { createElement, Fragment } from 'react';
import { BoxIcon } from '../../icons';
import type { Annotation, AnnotationPoint } from '../../model';
import type { DrawingTool, Geometry, GeometryContext, GridProjection } from '../types';
import { finite, hitPath, hitRect, label, rectPath, strokeOf } from '../shapeKit';
import { BoxShape } from './Shape';

function geometry(a: Annotation, grid: GridProjection, ctx: GeometryContext): Geometry | null {
  if (a.points.length < 2) return null;
  if (!grid.axisIds.includes(a.axisId)) return null;
  const xs = a.points.map((p) => grid.tToX(p.t));
  if (!finite(...xs)) return null;
  const ys = a.points.map((p) => grid.vToY(p.v, a.axisId));
  if (!finite(...ys)) return null;

  const x0 = Math.min(xs[0], xs[1]);
  const x1 = Math.max(xs[0], xs[1]);
  const y0 = Math.min(ys[0], ys[1]);
  const y1 = Math.max(ys[0], ys[1]);
  const w = x1 - x0;
  const h = y1 - y0;
  return {
    body: createElement(
      Fragment,
      null,
      createElement('rect', {
        x: x0,
        y: y0,
        width: w,
        height: h,
        ...strokeOf(a),
      }),
      label(ctx.theme, x1, y1 + 13, a.text, a.color, 'end')
    ),
    outline: [rectPath(x0, y0, w, h)],
    hits: createElement(
      Fragment,
      null,
      hitRect(x0, y0, w, h, 'f'),
      hitPath(rectPath(x0, y0, w, h), 'e')
    ),
    handles: [
      [xs[0], ys[0]],
      [xs[1], ys[1]],
    ],
    lockAt: [x1, y0],
  };
}

const LONG = 'Box';

export const BOX_TOOL: DrawingTool = {
  kind: 'box',
  code: 4,
  label: { long: LONG, short: 'Box' },
  icon: BoxIcon,
  arity: 2,
  axes: 'xy',
  key: 'b',
  railGroup: 'area',
  shapePoint: (p: AnnotationPoint): AnnotationPoint => p,
  geometry,
  Shape: BoxShape,
  objName: (_a, ctx) => (ctx.axis?.name ? `Box (${ctx.axis.name})` : 'Box'),
  hint: () => `${LONG}: drag or click twice`,
  fields: [],
  codec: { layout: 'tvtv' },
};
