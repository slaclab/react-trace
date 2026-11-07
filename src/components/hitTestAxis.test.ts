import { describe, expect, it } from 'vitest';
import { hitTestAxis, panExtent, zoomExtent, type AxisHitZone, type GridBand } from './axisHitTest';

const WIDTH = 800;
const HEIGHT = 400;

function zone(over: Partial<AxisHitZone>): AxisHitZone {
  return {
    axisId: 'a',
    yAxisIndex: 0,
    logScale: false,
    autoScale: true,
    side: 'left',
    sideIndex: 0,
    ...over,
  };
}

describe('hitTestAxis', () => {
  // Single left axis: grid left inset 70, right inset 20 (no right axes).
  const singleLeftGrid: GridBand = { top: 40, bottom: 60, left: 70, right: 20 };
  const singleLeft = [zone({ axisId: 'left0', side: 'left', sideIndex: 0 })];

  it('hits the left axis anywhere in the left margin', () => {
    // Cursor near the left edge, vertically inside the plot band.
    expect(hitTestAxis(10, 200, WIDTH, HEIGHT, singleLeftGrid, singleLeft)?.axisId).toBe('left0');
    // Just inside the left margin (x < 70).
    expect(hitTestAxis(69, 200, WIDTH, HEIGHT, singleLeftGrid, singleLeft)?.axisId).toBe('left0');
  });

  it('returns null inside the plot grid so X pan/zoom keeps it', () => {
    expect(hitTestAxis(400, 200, WIDTH, HEIGHT, singleLeftGrid, singleLeft)).toBeNull();
    // Exactly at the grid-left boundary is inside the grid, not the margin.
    expect(hitTestAxis(70, 200, WIDTH, HEIGHT, singleLeftGrid, singleLeft)).toBeNull();
  });

  it('returns null outside the vertical grid band (top/bottom margins)', () => {
    expect(hitTestAxis(10, 10, WIDTH, HEIGHT, singleLeftGrid, singleLeft)).toBeNull();
    expect(hitTestAxis(10, 390, WIDTH, HEIGHT, singleLeftGrid, singleLeft)).toBeNull();
  });

  it('returns null in the right margin when there is no right axis', () => {
    expect(hitTestAxis(795, 200, WIDTH, HEIGHT, singleLeftGrid, singleLeft)).toBeNull();
  });

  // One left axis + one right axis: both sides have a 70px inset.
  const leftRightGrid: GridBand = { top: 40, bottom: 60, left: 70, right: 70 };
  const leftRight = [
    zone({ axisId: 'left0', side: 'left', sideIndex: 0 }),
    zone({ axisId: 'right0', side: 'right', sideIndex: 0 }),
  ];

  it('routes left margin to the left axis and right margin to the right axis', () => {
    expect(hitTestAxis(20, 200, WIDTH, HEIGHT, leftRightGrid, leftRight)?.axisId).toBe('left0');
    expect(hitTestAxis(790, 200, WIDTH, HEIGHT, leftRightGrid, leftRight)?.axisId).toBe('right0');
  });

  // Two stacked left axes: inner at slot 0 (0..80 from grid), outer at slot 1.
  const stackedGrid: GridBand = { top: 40, bottom: 60, left: 150, right: 20 };
  const stackedLeft = [
    zone({ axisId: 'inner', side: 'left', sideIndex: 0 }),
    zone({ axisId: 'outer', side: 'left', sideIndex: 1 }),
  ];

  it('slots stacked left axes by distance from the grid', () => {
    // 30px in from grid-left (150) -> slot 0 -> inner.
    expect(hitTestAxis(120, 200, WIDTH, HEIGHT, stackedGrid, stackedLeft)?.axisId).toBe('inner');
    // 100px in from grid-left -> slot 1 -> outer.
    expect(hitTestAxis(50, 200, WIDTH, HEIGHT, stackedGrid, stackedLeft)?.axisId).toBe('outer');
  });
});

describe('panExtent', () => {
  // [0, 100] over a 300px-tall grid: min at pixel 340 (bottom), max at 40 (top).
  const linear = { min: 0, max: 100, pxMin: 340, pxMax: 40, logScale: false };

  it('dragging DOWN raises min/max so the curves follow the cursor down', () => {
    // +30px of a 300px span shifts the window by +10 data units.
    const [min, max] = panExtent(linear, 30)!;
    expect(min).toBeCloseTo(10, 10);
    expect(max).toBeCloseTo(110, 10);
  });

  it('dragging UP lowers min/max so the curves follow the cursor up', () => {
    const [min, max] = panExtent(linear, -30)!;
    expect(min).toBeCloseTo(-10, 10);
    expect(max).toBeCloseTo(90, 10);
  });

  it('keeps the grabbed value glued to the cursor', () => {
    // Value at pixel p under the frozen mapping: v(p) = min + (max-min)*(pxMin-p)/span.
    // Grab pixel 190 (value 50), drag +45px; the NEW mapping (same pixel span,
    // shifted window) must put value 50 at pixel 235.
    const [min2, max2] = panExtent(linear, 45)!;
    const vAt = (p: number) => min2 + (max2 - min2) * ((340 - p) / 300);
    expect(vAt(190 + 45)).toBeCloseTo(50, 10);
  });

  it('pans log axes in log space, preserving the min:max ratio', () => {
    const log = { min: 1, max: 100, pxMin: 340, pxMax: 40, logScale: true };
    // Half the pixel span = half the log range = one decade up.
    const [min2, max2] = panExtent(log, 150)!;
    expect(min2).toBeCloseTo(10, 10);
    expect(max2).toBeCloseTo(1000, 10);
  });

  it('returns null for a degenerate zero-height mapping', () => {
    expect(panExtent({ ...linear, pxMax: 340 }, 30)).toBeNull();
  });
});

describe('zoomExtent', () => {
  it('zooms out around the anchor with factor > 1', () => {
    const [min, max] = zoomExtent(0, 100, 50, 1.1, false);
    expect(min).toBeCloseTo(-5, 10);
    expect(max).toBeCloseTo(105, 10);
  });

  it('zooms in around the anchor with factor < 1 and keeps the anchor fixed', () => {
    const [min, max] = zoomExtent(0, 100, 25, 1 / 1.1, false);
    // Anchor stays put: its relative position in the window is unchanged.
    expect((25 - min) / (max - min)).toBeCloseTo(25 / 100, 10);
    expect(max - min).toBeCloseTo(100 / 1.1, 10);
  });

  it('zooms log axes by a constant ratio about the anchor', () => {
    const [min, max] = zoomExtent(1, 100, 10, 2, true);
    // Doubling in log space squares each bound's ratio to the anchor.
    expect(min).toBeCloseTo(0.1, 10);
    expect(max).toBeCloseTo(1000, 10);
  });
});
