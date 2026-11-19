// The density view: a hex-bin of X against one Y (`dy`, default the
// first Y), drawn as an ECharts custom series on the same axes as the scatter.
//
// X and Y usually differ by orders of magnitude (amperes against metres), so
// hexes are laid out in a normalised space where each axis spans its own data
// extent; a hex is then regular on screen whatever the units. Cells are
// pointy-top, axial coordinates with cube rounding, matching the reference
// implementation. Only occupied cells are returned.
//
// On a log axis the hexes are binned in that axis's scale: the values are
// log10'd before binning (points ≤ 0 are left out: a log axis cannot show
// them) and centres and vertices are mapped back, so the hexes are regular on
// screen there too.

import type { CustomSeriesOption } from 'echarts';

export const DENSITY_COLUMNS = 24;

export interface HexCell {
  /** Centre in data units. */
  x: number;
  y: number;
  count: number;
}

export interface HexBins {
  cells: HexCell[];
  /** Circumradius in normalised units (the axis extents are 1). */
  radius: number;
  /** Data units per normalised unit, per axis. */
  spanX: number;
  spanY: number;
  maxCount: number;
  /** The log axes the hexes were binned for; absent on linear axes. */
  log?: HexLogAxes;
}

/** Which axes are logarithmic. */
export interface HexLogAxes {
  x?: boolean;
  y?: boolean;
}

/** A value in an axis's scale: log10 on a log axis, null where that cannot be drawn. */
function toScale(v: number, log: boolean | undefined): number | null {
  if (!log) return v;
  return v > 0 ? Math.log10(v) : null;
}

function fromScale(v: number, log: boolean | undefined): number {
  return log ? 10 ** v : v;
}

const SQRT3 = Math.sqrt(3);

function roundAxial(q: number, r: number): [number, number] {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return [rq, rr];
}

/**
 * Bin the pairwise non-null, finite (x, y) pairs into hexes, in each axis's
 * scale (`log`).
 */
export function hexBin(
  xCells: (number | null)[],
  yCells: (number | null)[],
  columns = DENSITY_COLUMNS,
  log: HexLogAxes = {}
): HexBins {
  const logged = log.x === true || log.y === true ? { log: { x: log.x, y: log.y } } : {};
  const xs: number[] = [];
  const ys: number[] = [];
  const len = Math.min(xCells.length, yCells.length);
  for (let i = 0; i < len; i++) {
    const x = xCells[i];
    const y = yCells[i];
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const sx = toScale(x, log.x);
    const sy = toScale(y, log.y);
    if (sx === null || sy === null) continue;
    xs.push(sx);
    ys.push(sy);
  }
  if (xs.length === 0) return { cells: [], radius: 0, spanX: 1, spanY: 1, maxCount: 0, ...logged };

  let minX = xs[0];
  let maxX = xs[0];
  let minY = ys[0];
  let maxY = ys[0];
  for (let i = 1; i < xs.length; i++) {
    minX = Math.min(minX, xs[i]);
    maxX = Math.max(maxX, xs[i]);
    minY = Math.min(minY, ys[i]);
    maxY = Math.max(maxY, ys[i]);
  }
  // A column with no spread gets a unit extent: one row of hexes, finite size.
  const spanX = maxX > minX ? maxX - minX : Math.abs(minX) || 1;
  const spanY = maxY > minY ? maxY - minY : Math.abs(minY) || 1;
  const radius = 1 / (Math.max(1, columns) * SQRT3);

  const counts = new Map<string, { q: number; r: number; count: number }>();
  for (let i = 0; i < xs.length; i++) {
    const px = (xs[i] - minX) / spanX;
    const py = (ys[i] - minY) / spanY;
    const [q, r] = roundAxial(((SQRT3 / 3) * px - py / 3) / radius, ((2 / 3) * py) / radius);
    const key = `${q},${r}`;
    const cell = counts.get(key);
    if (cell) cell.count++;
    else counts.set(key, { q, r, count: 1 });
  }

  let maxCount = 0;
  const cells: HexCell[] = [];
  for (const { q, r, count } of counts.values()) {
    const cx = radius * SQRT3 * (q + r / 2);
    const cy = radius * 1.5 * r;
    cells.push({
      x: fromScale(minX + cx * spanX, log.x),
      y: fromScale(minY + cy * spanY, log.y),
      count,
    });
    maxCount = Math.max(maxCount, count);
  }
  return { cells, radius, spanX, spanY, maxCount, ...logged };
}

/** The six vertices of a pointy-top hex around a centre, in data units (laid out in the axes' scales). */
export function hexVertices(cell: HexCell, bins: HexBins): [number, number][] {
  const log = bins.log ?? {};
  // The centre in the axes' scales (cells are only where a log axis can draw).
  const cx = log.x ? Math.log10(cell.x) : cell.x;
  const cy = log.y ? Math.log10(cell.y) : cell.y;
  const out: [number, number][] = [];
  for (let k = 0; k < 6; k++) {
    const angle = (Math.PI / 180) * (60 * k - 30);
    out.push([
      fromScale(cx + bins.radius * Math.cos(angle) * bins.spanX, log.x),
      fromScale(cy + bins.radius * Math.sin(angle) * bins.spanY, log.y),
    ]);
  }
  return out;
}

/** Cell colour: count mapped onto a light-to-dark ramp of `color`'s opacity. */
function cellOpacity(count: number, max: number): number {
  return max <= 0 ? 0 : 0.15 + 0.85 * (count / max);
}

/** The ECharts custom series drawing `bins` on the plot's shared axes. */
export function densitySeries(bins: HexBins, name: string, color: string): CustomSeriesOption {
  return {
    type: 'custom',
    name,
    animation: false,
    silent: false,
    data: bins.cells.map((c) => [c.x, c.y, c.count]),
    encode: { x: 0, y: 1, tooltip: 2 },
    renderItem: (params, api) => {
      const cell = bins.cells[params.dataIndex];
      if (cell === undefined) return null;
      const points = hexVertices(cell, bins).map((p) => api.coord(p) as number[]);
      return {
        type: 'polygon',
        shape: { points },
        style: { fill: color, opacity: cellOpacity(cell.count, bins.maxCount), stroke: 'none' },
      };
    },
  };
}
