// The trend line: every Trend fact in one place, including its `extend`
// property (Inspector field, link flags, file validation). Imports only
// `catalog/types`, `shapeKit` and `format`.
import { createElement, Fragment } from 'react';
import { TrendLineIcon } from '../../icons';
import type { CodecFlags, DrawingFieldSpec, DrawingTool, ShapeProps } from '../types';
import { EXTEND_PX, finite, hitPath, label, strokeOf } from '../shapeKit';
import { TrendShape } from './Shape';

type Annotation = ShapeProps['annotation'];
type Extend = NonNullable<Annotation['extend']>;

const LONG = 'Trend line';

const EXTEND_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'right', label: 'Right' },
  { value: 'both', label: 'Both' },
];

const isExtend = (v: unknown): v is Extend => v === 'right' || v === 'both';

/** `a` with `extend` set to `value`, or without the key when undefined; same reference when unchanged. */
function withExtend(a: Annotation, value: Extend | undefined): Annotation {
  if (a.extend === value) return a;
  const out = { ...a };
  if (value === undefined) delete out.extend;
  else out.extend = value;
  return out;
}

/** Inspector field: how far the line runs past its points (today's id `annotation-extend`). */
const EXTEND_FIELD: DrawingFieldSpec = {
  id: 'annotation-extend',
  label: 'Extend',
  kind: 'select',
  options: () => EXTEND_OPTIONS,
  get: (a) => a.extend ?? 'none',
  set: (a, value) => {
    if (value === 'none') return withExtend(a, undefined);
    if (isExtend(value)) return withExtend(a, value);
    return a;
  },
};

/** Link flags: `r` extends right, `b` both ways; the last of them wins, other letters are ignored. */
const EXTEND_FLAGS: CodecFlags = {
  encode: (a) => (a.extend === 'right' ? 'r' : a.extend === 'both' ? 'b' : ''),
  decode(flags, a) {
    let extend: Extend | undefined;
    for (const ch of flags) {
      if (ch === 'r') extend = 'right';
      else if (ch === 'b') extend = 'both';
    }
    return extend === undefined ? a : withExtend(a, extend);
  },
};

export const TREND_TOOL: DrawingTool = {
  kind: 'trend',
  code: 3,
  label: { long: LONG, short: 'Trend' },
  icon: TrendLineIcon,

  arity: 2,
  axes: 'xy',
  key: 'l',
  railGroup: 'line',

  shapePoint: (p) => p,

  geometry(a, grid, ctx) {
    if (a.points.length === 0) return null;
    if (!grid.axisIds.includes(a.axisId)) return null;
    const xs = a.points.map((p) => grid.tToX(p.t));
    if (!finite(...xs)) return null;
    const ys = a.points.map((p) => grid.vToY(p.v, a.axisId));
    if (!finite(...ys)) return null;

    const [x0, x1] = xs;
    const [y0, y1] = ys;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const k = EXTEND_PX / (Math.hypot(dx, dy) || 1);
    let ex0 = x0;
    let ey0 = y0;
    let ex1 = x1;
    let ey1 = y1;
    if (a.extend === 'right' || a.extend === 'both') {
      ex1 = x1 + dx * k;
      ey1 = y1 + dy * k;
    }
    if (a.extend === 'both') {
      ex0 = x0 - dx * k;
      ey0 = y0 - dy * k;
    }
    const d = `M${ex0} ${ey0}L${ex1} ${ey1}`;
    return {
      body: createElement(
        Fragment,
        null,
        createElement('path', { key: 'line', d, ...strokeOf(a) }),
        createElement(
          Fragment,
          { key: 'label' },
          label(ctx.theme, (x0 + x1) / 2 + 6, (y0 + y1) / 2 - 6, a.text, a.color)
        )
      ),
      outline: [d],
      hits: hitPath(d, 'h0'),
      handles: [
        [x0, y0],
        [x1, y1],
      ],
      lockAt: [x0, y0],
    };
  },
  Shape: TrendShape,

  objName: (_a, ctx) => (ctx.axis?.name ? `Trend (${ctx.axis.name})` : 'Trend'),
  hint: () => `${LONG}: drag or click twice`,

  fields: [EXTEND_FIELD],
  validate: (raw, base) => (isExtend(raw.extend) ? withExtend(base, raw.extend) : base),
  codec: { layout: 'tvtv', flags: EXTEND_FLAGS },
};
