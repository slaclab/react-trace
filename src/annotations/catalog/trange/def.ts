// The Time-range tool: a band across the full grid height between two
// x positions. Trace only; no other catalog includes it.
import { createElement, Fragment } from 'react';
import { TimeRangeIcon } from '../../icons';
import type { Annotation, AnnotationPoint } from '../../model';
import type {
  DrawingTextContext,
  DrawingTool,
  Geometry,
  GeometryContext,
  GridProjection,
} from '../types';
import { finite, hitPath, hitRect, label, RANGE_FILL, rectPath, strokeOf } from '../shapeKit';
import { TrangeShape } from './Shape';

/** The span between a range's two points, as the x axis writes a span. */
function spanText(a: Annotation, ctx: { xAxis: DrawingTextContext['xAxis'] }): string {
  return ctx.xAxis.formatSpan(a.points[1].t - a.points[0].t);
}

function geometry(a: Annotation, grid: GridProjection, ctx: GeometryContext): Geometry | null {
  const { top, height } = grid.gridRect;
  const bot = top + height;
  const midY = (top + bot) / 2;
  if (a.points.length < 2) return null;
  const xs = a.points.map((p) => grid.tToX(p.t));
  if (!finite(...xs)) return null;

  const x0 = Math.min(xs[0], xs[1]);
  const x1 = Math.max(xs[0], xs[1]);
  const edges = `M${x0} ${top}V${bot}M${x1} ${top}V${bot}`;
  const text = a.text || spanText(a, ctx);
  return {
    body: createElement(
      Fragment,
      null,
      createElement('rect', {
        x: x0,
        y: top,
        width: x1 - x0,
        height: bot - top,
        fill: a.color,
        fillOpacity: RANGE_FILL,
        pointerEvents: 'none',
      }),
      createElement('path', { d: edges, ...strokeOf(a) }),
      label(ctx.theme, (x0 + x1) / 2, top + 12, text, a.color, 'middle')
    ),
    outline: [rectPath(x0, top, x1 - x0, bot - top)],
    hits: createElement(
      Fragment,
      null,
      hitRect(x0, top, x1 - x0, bot - top, 'f'),
      hitPath(`M${x0} ${top}V${bot}`, 'e0'),
      hitPath(`M${x1} ${top}V${bot}`, 'e1')
    ),
    handles: [
      [xs[0], midY],
      [xs[1], midY],
    ],
    lockAt: [x0, midY],
  };
}

const LONG = 'Time range';

export const TRANGE_TOOL: DrawingTool = {
  kind: 'trange',
  code: 2,
  label: { long: LONG, short: 'Range' },
  icon: TimeRangeIcon,
  arity: 2,
  axes: 'x',
  key: 'r',
  railGroup: 'area',
  shapePoint: (p: AnnotationPoint): AnnotationPoint => ({ t: p.t, v: 0 }),
  geometry,
  Shape: TrangeShape,
  objName: (a, ctx) => `Range ${spanText(a, ctx)}`,
  hint: () => `${LONG}: drag or click twice`,
  fields: [],
  codec: { layout: 'tt' },
};
