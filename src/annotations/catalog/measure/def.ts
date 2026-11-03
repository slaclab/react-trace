// The Measure tool: an unfilled box between two points with a dashed
// diagonal, in the drawing's colour like every tool; its readout rows come
// from the host's `MeasureProvider`. Armed by Alt+M, or placed with a
// shift-drag.
import { createElement, Fragment } from 'react';
import { MeasureIcon } from '../../icons';
import type { Annotation, AnnotationPoint } from '../../model';
import type { DrawingTool, Geometry, GridProjection } from '../types';
import { DASH_ARRAY, finite, hitRect, rectPath, strokeOf } from '../shapeKit';
import { axisUnit, fmtValue, withUnit } from '../format';
import { MeasureShape } from './Shape';

function geometry(a: Annotation, grid: GridProjection): Geometry | null {
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
  return {
    body: createElement(
      Fragment,
      null,
      createElement('rect', {
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
        ...strokeOf(a),
      }),
      createElement('path', {
        d: `M${xs[0]} ${ys[0]}L${xs[1]} ${ys[1]}`,
        ...strokeOf(a),
        strokeWidth: Math.min(a.width, 0.75),
        strokeDasharray: DASH_ARRAY,
        'data-annotation-diagonal': '',
      })
    ),
    outline: [rectPath(x0, y0, x1 - x0, y1 - y0)],
    hits: hitRect(x0, y0, x1 - x0, y1 - y0, 'f'),
    handles: [
      [xs[0], ys[0]],
      [xs[1], ys[1]],
    ],
    lockAt: [x1, y0],
  };
}

const LONG = 'Measure';

export const MEASURE_TOOL: DrawingTool = {
  kind: 'measure',
  code: 6,
  label: { long: LONG, short: 'Measure' },
  icon: MeasureIcon,
  arity: 2,
  axes: 'xy',
  key: 'm',
  railGroup: 'mark',
  shapePoint: (p: AnnotationPoint): AnnotationPoint => p,
  geometry,
  Shape: MeasureShape,
  objName: (a, ctx) => {
    const [p0, p1] = a.points;
    const dv = withUnit(fmtValue(p1.v - p0.v), axisUnit(ctx.axis));
    return `Measure ${ctx.binned ? '≈' : ''}Δ${dv} / ${ctx.xAxis.formatSpan(p1.t - p0.t)}`;
  },
  hint: () => `${LONG}: shift-drag to measure`,
  card: (a, ctx) => ctx.measure.card(a, ctx),
  modifierGesture: 'shift',
  fields: [],
  codec: { layout: 'tvtv' },
};
