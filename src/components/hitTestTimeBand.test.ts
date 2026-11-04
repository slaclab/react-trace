// Pins the time-band hit test: only the X tick-label strip directly below the
// plot grid counts as the time band; the legend row beneath it and the margins
// left/right of the grid do not.
import { describe, expect, it } from 'vitest';
import { hitTestTimeBand, X_BAND_PX, type GridBand } from './axisHitTest';

const WIDTH = 800;
const HEIGHT = 400;
const grid: GridBand = { top: 40, bottom: 60, left: 70, right: 20 };
// Bottom edge of the plot grid in canvas pixels (340).
const GRID_BOTTOM_Y = HEIGHT - grid.bottom;

describe('hitTestTimeBand', () => {
  it('exports a 26px band height', () => {
    expect(X_BAND_PX).toBe(26);
  });

  it('hits a point inside the tick-label strip', () => {
    expect(hitTestTimeBand(400, GRID_BOTTOM_Y + 10, WIDTH, HEIGHT, grid)).toBe(true);
    // Lower edge of the strip is inclusive.
    expect(hitTestTimeBand(400, GRID_BOTTOM_Y + X_BAND_PX, WIDTH, HEIGHT, grid)).toBe(true);
  });

  it('excludes the grid bottom edge itself (that belongs to the plot)', () => {
    expect(hitTestTimeBand(400, GRID_BOTTOM_Y, WIDTH, HEIGHT, grid)).toBe(false);
    expect(hitTestTimeBand(400, 200, WIDTH, HEIGHT, grid)).toBe(false);
  });

  it('returns false at legend height below the strip', () => {
    expect(hitTestTimeBand(400, GRID_BOTTOM_Y + X_BAND_PX + 1, WIDTH, HEIGHT, grid)).toBe(false);
    expect(hitTestTimeBand(400, HEIGHT - 10, WIDTH, HEIGHT, grid)).toBe(false);
  });

  it('returns false left of the grid', () => {
    expect(hitTestTimeBand(grid.left - 1, GRID_BOTTOM_Y + 10, WIDTH, HEIGHT, grid)).toBe(false);
    expect(hitTestTimeBand(10, GRID_BOTTOM_Y + 10, WIDTH, HEIGHT, grid)).toBe(false);
  });

  it('returns false right of the grid', () => {
    const right = WIDTH - grid.right;
    expect(hitTestTimeBand(right + 1, GRID_BOTTOM_Y + 10, WIDTH, HEIGHT, grid)).toBe(false);
    expect(hitTestTimeBand(795, GRID_BOTTOM_Y + 10, WIDTH, HEIGHT, grid)).toBe(false);
  });

  it('includes the grid left and right edges', () => {
    expect(hitTestTimeBand(grid.left, GRID_BOTTOM_Y + 10, WIDTH, HEIGHT, grid)).toBe(true);
    expect(hitTestTimeBand(WIDTH - grid.right, GRID_BOTTOM_Y + 10, WIDTH, HEIGHT, grid)).toBe(true);
  });
});
