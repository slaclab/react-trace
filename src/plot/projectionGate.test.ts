// Pins the projection bump gate: ECharts fires `finished` on every frame,
// and the overlay must re-render only when the size, a grid rect or an axis
// extent actually moved.
import { describe, expect, it, vi } from 'vitest';
import { createProjectionGate, readProjectionFrame, type ProjectionFrame } from './projectionGate';

const frame = (yMax = 100): ProjectionFrame => ({
  width: 800,
  height: 400,
  grids: [{ left: 70, top: 40, width: 710, height: 300 }],
  extents: [
    [0, 1000],
    [0, yMax],
  ],
});

describe('createProjectionGate', () => {
  it('bumps zero times over 20 identical frames once settled', () => {
    const bump = vi.fn();
    const gate = createProjectionGate(bump);
    gate.prime(frame());
    for (let i = 0; i < 20; i++) expect(gate.offer(frame())).toBe(false);
    expect(bump).not.toHaveBeenCalled();
  });

  it('bumps the first offer, then not again for identical frames', () => {
    const bump = vi.fn();
    const gate = createProjectionGate(bump);
    for (let i = 0; i < 20; i++) gate.offer(frame());
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('bumps once on an extent change, then settles', () => {
    const bump = vi.fn();
    const gate = createProjectionGate(bump);
    gate.prime(frame());
    for (let i = 0; i < 5; i++) gate.offer(frame(200));
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('bumps on a size or grid rect change, and after reset', () => {
    const bump = vi.fn();
    const gate = createProjectionGate(bump);
    gate.prime(frame());
    expect(gate.offer({ ...frame(), width: 801 })).toBe(true);
    expect(
      gate.offer({
        ...frame(),
        width: 801,
        grids: [{ left: 70, top: 41, width: 710, height: 300 }],
      })
    ).toBe(true);
    gate.reset();
    expect(gate.offer(frame())).toBe(true);
    expect(bump).toHaveBeenCalledTimes(3);
  });

  it('compares NaN and missing extents stably', () => {
    const bump = vi.fn();
    const gate = createProjectionGate(bump);
    const odd: ProjectionFrame = { width: NaN, height: 1, extents: [null, [NaN, 1]] };
    gate.prime(odd);
    expect(gate.offer({ width: NaN, height: 1, extents: [null, [NaN, 1]] })).toBe(false);
    expect(
      gate.offer({
        width: NaN,
        height: 1,
        extents: [
          [0, 0],
          [NaN, 1],
        ],
      })
    ).toBe(true);
  });
});

describe('readProjectionFrame', () => {
  it('reads size, grid rects and x-then-y extents from the model', () => {
    const extents: Record<string, [number, number]> = {
      xAxis0: [1, 2],
      yAxis0: [3, 4],
      yAxis1: [5, 6],
    };
    const inst = {
      getWidth: () => 800,
      getHeight: () => 400,
      getModel: () => ({
        getComponent: (type: string, i: number) =>
          type === 'grid'
            ? { coordinateSystem: { getRect: () => ({ x: 1, y: 2, width: 3, height: 4 }) } }
            : { axis: { scale: { getExtent: () => extents[`${type}${i}`] } } },
      }),
    };
    expect(readProjectionFrame(inst, { grids: 1, xAxes: 1, yAxes: 2 })).toEqual({
      width: 800,
      height: 400,
      grids: [{ left: 1, top: 2, width: 3, height: 4 }],
      extents: [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
    });
  });

  it('reads anything the model cannot answer as missing', () => {
    const inst = {
      getWidth: () => 10,
      getHeight: () => 20,
      getModel: () => {
        throw new Error('not laid out');
      },
    };
    expect(readProjectionFrame(inst, { grids: 1, xAxes: 1, yAxes: 0 })).toEqual({
      width: 10,
      height: 20,
      grids: [null],
      extents: [null],
    });
  });
});
