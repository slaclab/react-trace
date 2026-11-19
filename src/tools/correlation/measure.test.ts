// Correlation's measure provider: Δx Δy, the slope of the
// drawn diagonal, and n / mean / σ of the owning Y's points inside the box,
// read through a frame getter.
import { describe, expect, it } from 'vitest';
import type { TableResultDTO } from '@slaclab/canopy-client';
import { VALUE_X_AXIS } from '../../annotations/catalog/xAxis';
import type { Annotation } from '../../annotations/model';
import {
  correlationMeasureLines,
  correlationMeasureReadout,
  createCorrelationMeasure,
} from './measure';
import type { FrameLike } from './stats';

const PVS = { x: 'X:PV', y1: 'Y1:PV', y2: 'Y2:PV' };

// x = 0..9; y1 = 2x + 1; y2 = -x; one row with a null y1.
function frame(): FrameLike {
  const xs = Array.from({ length: 10 }, (_, i) => i);
  const table: TableResultDTO = {
    tsNs: xs.map((i) => i * 1e9),
    columns: {
      x: xs,
      y1: xs.map((x) => (x === 5 ? null : 2 * x + 1)),
      y2: xs.map((x) => -x),
    },
    inputs: {},
    totalRows: xs.length,
  };
  return { table, columnPvs: PVS };
}

function measure(axisId: string, t0: number, v0: number, t1: number, v1: number): Annotation {
  return {
    id: 'm1',
    kind: 'measure',
    points: [
      { t: t0, v: v0 },
      { t: t1, v: v1 },
    ],
    axisId,
    color: '#000',
    width: 1.5,
    text: '',
  };
}

describe('correlationMeasureReadout', () => {
  it('reports Δx, Δy and the slope of the drawn diagonal', () => {
    const r = correlationMeasureReadout(measure('Y1:PV', 2, 5, 6, 13), frame());
    expect(r.dx).toBe(4);
    expect(r.dy).toBe(8);
    expect(r.slope).toBe(2);
  });

  it("counts only the owning Y's points inside the box, in x and in y", () => {
    // x in [2, 6], y in [5, 13]: y1 at x = 2, 3, 4, 6 (x = 5 is a gap).
    const r = correlationMeasureReadout(measure('Y1:PV', 2, 5, 6, 13), frame());
    expect(r.n).toBe(4);
    expect(r.mean).toBeCloseTo((5 + 7 + 9 + 13) / 4);
    // y bounds cut too: y in [5, 8] keeps x = 2, 3 only.
    expect(correlationMeasureReadout(measure('Y1:PV', 2, 5, 6, 8), frame()).n).toBe(2);
  });

  it('accepts the corners in either order', () => {
    const a = correlationMeasureReadout(measure('Y2:PV', 1, -1, 4, -4), frame());
    const b = correlationMeasureReadout(measure('Y2:PV', 4, -4, 1, -1), frame());
    expect(a.n).toBe(4);
    expect(b.n).toBe(4);
    expect(a.mean).toBeCloseTo(-2.5);
    expect(b.std).toBeCloseTo(a.std ?? NaN);
  });

  it('a vertical diagonal has no slope; one point has no σ', () => {
    const r = correlationMeasureReadout(measure('Y2:PV', 3, -3, 3, -3), frame());
    expect(r.slope).toBeNull();
    expect(r.n).toBe(1);
    expect(r.std).toBeNull();
  });

  it('no frame, or a Y not in the frame: Δ only', () => {
    expect(correlationMeasureReadout(measure('Y1:PV', 0, 0, 1, 1), null).n).toBeNull();
    const gone = correlationMeasureReadout(measure('GONE:PV', 0, 0, 1, 1), frame());
    expect(gone.n).toBeNull();
    expect(gone.dx).toBe(1);
  });
});

describe('correlationMeasureLines', () => {
  it('prints the terms as a figure does: units after Δy, ȳ and σ, a true minus, dashes for missing values', () => {
    expect(
      correlationMeasureLines({ dx: 4, dy: -8, slope: 2, n: 3, mean: 7, std: 2 }, 'mm')
    ).toEqual(['Δx = 4\u2003Δy = \u22128 mm\u2003Δy/Δx = 2', 'n = 3\u2003ȳ = 7 mm\u2003σ = 2 mm']);
    expect(
      correlationMeasureLines({ dx: 0, dy: NaN, slope: null, n: null, mean: null, std: null })
    ).toEqual(['Δx = 0\u2003Δy = —\u2003Δy/Δx = —', 'n = —\u2003ȳ = —\u2003σ = —']);
  });
});

describe('createCorrelationMeasure', () => {
  it('reads the frame through the getter at call time', () => {
    let current: FrameLike | null = null;
    const provider = createCorrelationMeasure(() => current);
    const a = measure('Y1:PV', 2, 5, 6, 13);
    const ctx = { xAxis: VALUE_X_AXIS, axis: { id: 'Y1:PV', name: 'Y1:PV', units: 'mm' } };
    expect(provider.card(a, ctx)[1]).toMatch(/^n = —/);
    current = frame();
    expect(provider.card(a, ctx)).toEqual([
      'Δx = 4\u2003Δy = 8 mm\u2003Δy/Δx = 2',
      expect.stringMatching(/^n = 4\u2003ȳ = 8.5 mm\u2003σ = [\d.]+ mm$/),
    ]);
  });
});
