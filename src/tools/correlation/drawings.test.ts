import { describe, expect, it } from 'vitest';
import type { TableResultDTO } from '@slaclab/canopy-client';
import type { GridProjection, SnapHit } from '../../annotations/catalog/types';
import { CORRELATION_CATALOG } from '../../annotations/catalog';
import { projectionOf } from '../../plot/testUtils';
import type { Annotation } from '../../annotations/model';
import { correlationHiddenReason, correlationOwnerAxisAt } from './drawings';
import type { CorrelationAxisInput } from './plotOption';
import { defaultCorrelationState, type CorrelationState } from './query';
import type { FrameLike } from './stats';

const X = 'X:PV';
const Y1 = 'Y1:PV';
const Y2 = 'Y2:PV';
const Y3 = 'Y3:PV';
const PVS = { x: X, y1: Y1, y2: Y2, y3: Y3 };

// x = 1..10; y_k = (k + 1) * x + 1, so at x = 1: Y1 = 3, Y2 = 4, Y3 = 5.
function frame(): FrameLike {
  const tsNs = Array.from({ length: 10 }, (_, i) => i * 1e9);
  const columns: Record<string, (number | null)[]> = { x: tsNs.map((_, i) => i + 1) };
  ['y1', 'y2', 'y3'].forEach((c, k) => {
    columns[c] = tsNs.map((_, i) => (k + 2) * (i + 1) + 1);
  });
  const table: TableResultDTO = { tsNs, columns, inputs: {}, totalRows: 10 };
  return { table, columnPvs: PVS };
}

function layout(extra: Partial<CorrelationAxisInput> = {}): CorrelationAxisInput {
  return {
    frame: frame(),
    view: 'scatter',
    axes: 'shared',
    densityPv: '',
    hidden: new Set(),
    ...extra,
  };
}

// One grid at `rect`; x px = 10·x + left, y px = 500 − 10·v on every axis it holds.
function grid(axisIds: string[], left = 0): GridProjection {
  return {
    tToX: (t) => left + 10 * t,
    xToT: (x) => (x - left) / 10,
    vToY: (v, id) => (axisIds.includes(id) ? 500 - 10 * v : NaN),
    yToV: (y, id) => (axisIds.includes(id) ? (500 - y) / 10 : NaN),
    gridRect: { left, top: 0, width: 300, height: 500 },
    axisIds,
  };
}

const SHARED = projectionOf(grid([Y1, Y2, Y3]));

describe('correlationOwnerAxisAt', () => {
  it('shared: the magnet hit wins', () => {
    const hit: SnapHit = { t: 1, v: 5, axisId: Y3, traceId: Y3 };
    expect(correlationOwnerAxisAt(0, 0, hit, { layout: layout(), projection: SHARED })).toBe(Y3);
  });

  it('shared and overlay: else the Y with the nearest point within 24 px', () => {
    // (x = 1, Y2 = 4) is at px (10, 460).
    for (const axes of ['shared', 'overlay'] as const) {
      const ctx = { layout: layout({ axes }), projection: SHARED };
      expect(correlationOwnerAxisAt(10, 461, null, ctx)).toBe(Y2);
      expect(correlationOwnerAxisAt(10, 451, null, ctx)).toBe(Y3);
    }
  });

  it('a magnet hit on a hidden Y is ignored', () => {
    const hit: SnapHit = { t: 1, v: 3, axisId: Y1, traceId: Y1 };
    const ctx = { layout: layout({ hidden: new Set([Y1]) }), projection: SHARED };
    expect(correlationOwnerAxisAt(10, 461, hit, ctx)).toBe(Y2);
  });

  it('a hidden Y is never the nearest series', () => {
    const ctx = { layout: layout({ hidden: new Set([Y1]) }), projection: SHARED };
    // Right on Y1's (1, 3) at px (10, 470): Y2 (460) is 10 px away.
    expect(correlationOwnerAxisAt(10, 470, null, ctx)).toBe(Y2);
  });

  it('else the first visible Y', () => {
    const ctx = { layout: layout({ hidden: new Set([Y1]) }), projection: SHARED };
    expect(correlationOwnerAxisAt(250, 10, null, ctx)).toBe(Y2);
    expect(correlationOwnerAxisAt(250, 10, null, { ...ctx, projection: null })).toBe(Y2);
  });

  it('split: the Y of the grid under the pointer, null between grids', () => {
    const hidden = new Set([Y1]);
    const projection = projectionOf(grid([Y2], 0), grid([Y3], 400));
    const ctx = { layout: layout({ axes: 'split', hidden }), projection };
    // The magnet hit does not override the grid.
    const hit: SnapHit = { t: 1, v: 5, axisId: Y3, traceId: Y3 };
    expect(correlationOwnerAxisAt(100, 100, hit, ctx)).toBe(Y2);
    expect(correlationOwnerAxisAt(500, 100, null, ctx)).toBe(Y3);
    expect(correlationOwnerAxisAt(350, 100, null, ctx)).toBeNull();
    expect(correlationOwnerAxisAt(100, 100, null, { ...ctx, projection: null })).toBeNull();
  });

  it('density: the density Y, whatever is under the pointer', () => {
    const hit: SnapHit = { t: 1, v: 3, axisId: Y1, traceId: Y1 };
    const ctx = { layout: layout({ view: 'density', densityPv: Y3 }), projection: SHARED };
    expect(correlationOwnerAxisAt(10, 470, hit, ctx)).toBe(Y3);
    const fallback = {
      layout: layout({ view: 'density', axes: 'split', densityPv: Y1, hidden: new Set([Y1]) }),
      projection: SHARED,
    };
    expect(correlationOwnerAxisAt(10, 470, null, fallback)).toBe(Y2);
  });

  it('no visible Y places nothing', () => {
    const ctx = { layout: layout({ hidden: new Set([Y1, Y2, Y3]) }), projection: SHARED };
    expect(correlationOwnerAxisAt(10, 460, null, ctx)).toBeNull();
    expect(
      correlationOwnerAxisAt(10, 460, null, { layout: layout({ frame: null }), projection: null })
    ).toBeNull();
  });
});

const Y_TOOL = CORRELATION_CATALOG.tools.find((t) => t.axes === 'y');
const X_TOOLS = CORRELATION_CATALOG.tools.filter((t) => t.axes !== 'y');

function drawing(kind: string, over: Partial<Annotation> = {}): Annotation {
  return {
    id: 'd1',
    kind,
    points: [{ t: 1, v: 2 }],
    axisId: Y2,
    color: '#fff',
    width: 1.5,
    text: '',
    ...over,
  };
}

function state(over: Partial<CorrelationState> = {}): CorrelationState {
  return { ...defaultCorrelationState(), x: X, ys: [Y1, Y2, Y3], ...over };
}

describe('correlationHiddenReason', () => {
  it('the catalog has a y-only tool and tools that use x', () => {
    expect(Y_TOOL).toBeDefined();
    expect(X_TOOLS.length).toBeGreaterThan(0);
  });

  it('a drawing on a visible Y with its X drawn is shown', () => {
    for (const t of CORRELATION_CATALOG.tools) {
      expect(correlationHiddenReason(drawing(t.kind, { xRef: X }), state(), X)).toBeNull();
    }
  });

  it('series removed', () => {
    const d = drawing(X_TOOLS[0].kind, { axisId: 'GONE:PV' });
    expect(correlationHiddenReason(d, state(), X)).toBe('series removed');
  });

  it('series hidden', () => {
    const d = drawing(X_TOOLS[0].kind);
    expect(correlationHiddenReason(d, state({ hidden: { [Y2]: true } }), X)).toBe('series hidden');
  });

  it('not the density Y, with the first-visible-Y fallback', () => {
    const d = drawing(X_TOOLS[0].kind);
    expect(correlationHiddenReason(d, state({ view: 'density', dy: Y3 }), X)).toBe(
      'not the density Y'
    );
    expect(correlationHiddenReason(d, state({ view: 'density', dy: Y2 }), X)).toBeNull();
    // dy '' means the first Y.
    expect(correlationHiddenReason(d, state({ view: 'density' }), X)).toBe('not the density Y');
    // The density Y hidden: the first visible Y is drawn instead.
    const fallback = state({ view: 'density', dy: Y1, hidden: { [Y1]: true } });
    expect(correlationHiddenReason(d, fallback, X)).toBeNull();
  });

  it('x source changed, unless the tool uses y only', () => {
    for (const t of X_TOOLS) {
      const d = drawing(t.kind, { xRef: X });
      expect(correlationHiddenReason(d, state(), 'OTHER:PV')).toBe('x source changed');
    }
    const h = drawing((Y_TOOL as { kind: string }).kind, { xRef: X });
    expect(correlationHiddenReason(h, state(), 'OTHER:PV')).toBeNull();
  });

  it('a drawing without xRef is not bound to an X', () => {
    expect(correlationHiddenReason(drawing(X_TOOLS[0].kind), state(), 'OTHER:PV')).toBeNull();
  });

  it('returns when the drawn X matches again', () => {
    const d = drawing(X_TOOLS[0].kind, { xRef: X });
    expect(correlationHiddenReason(d, state(), 'OTHER:PV')).not.toBeNull();
    expect(correlationHiddenReason(d, state(), X)).toBeNull();
  });
});
