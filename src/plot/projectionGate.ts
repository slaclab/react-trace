// The projection bump gate. ECharts fires `finished` after every frame's
// `setOption`; bumping the projection store on each would re-render the overlay
// every frame. The gate compares what a projection depends on — the chart
// size, each grid's rect and each axis extent — with the signature of the last
// bump, and bumps only when it differs. Pure; reaches ECharts only through a
// duck-typed instance.
import type { GridRect } from './geometry';

/** What a projection depends on, read after a frame's layout. */
export interface ProjectionFrame {
  width: number;
  height: number;
  /** Each grid's rect, by grid index. */
  grids?: readonly (GridRect | null | undefined)[];
  /** Each axis extent `[min, max]` (x axes then y axes, in a fixed order). */
  extents: readonly (readonly [number, number] | null | undefined)[];
}

export interface ProjectionGate {
  /** Bump when `frame` differs from the last bumped (or primed) frame; returns whether it bumped. */
  offer(frame: ProjectionFrame): boolean;
  /** Record `frame` as current without bumping (e.g. after an unconditional bump). */
  prime(frame: ProjectionFrame): void;
  /** Forget the last frame, so the next offer bumps. */
  reset(): void;
}

function signature(frame: ProjectionFrame): number[] {
  const out: number[] = [frame.width, frame.height, frame.grids?.length ?? 0];
  for (const r of frame.grids ?? []) {
    if (r) out.push(1, r.left, r.top, r.width, r.height);
    else out.push(0);
  }
  out.push(frame.extents.length);
  for (const e of frame.extents) {
    if (e) out.push(1, e[0], e[1]);
    else out.push(0);
  }
  return out;
}

function same(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** A gate in front of `bump`. The first offer always bumps. */
export function createProjectionGate(bump: () => void): ProjectionGate {
  let last: number[] | null = null;
  return {
    offer(frame) {
      const sig = signature(frame);
      if (last && same(last, sig)) return false;
      last = sig;
      bump();
      return true;
    },
    prime(frame) {
      last = signature(frame);
    },
    reset() {
      last = null;
    },
  };
}

/** The slice of an ECharts instance {@link readProjectionFrame} reads. */
export interface GateInstance {
  getWidth(): number;
  getHeight(): number;
  getModel?(): unknown;
}

interface ModelLike {
  getComponent?(type: string, idx: number): unknown;
}

function component(model: ModelLike | null | undefined, type: string, idx: number): unknown {
  try {
    return model?.getComponent?.(type, idx);
  } catch {
    return undefined;
  }
}

function extentOf(cmp: unknown): [number, number] | null {
  try {
    const e = (
      cmp as { axis?: { scale?: { getExtent?(): unknown } } } | undefined
    )?.axis?.scale?.getExtent?.();
    if (Array.isArray(e) && typeof e[0] === 'number' && typeof e[1] === 'number') {
      return [e[0], e[1]];
    }
  } catch {
    // An axis not laid out yet reads as missing.
  }
  return null;
}

function rectOf(cmp: unknown): GridRect | null {
  try {
    const r = (
      cmp as { coordinateSystem?: { getRect?(): unknown } } | undefined
    )?.coordinateSystem?.getRect?.() as
      | { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
      | undefined;
    if (
      r &&
      typeof r.x === 'number' &&
      typeof r.y === 'number' &&
      typeof r.width === 'number' &&
      typeof r.height === 'number'
    ) {
      return { left: r.x, top: r.y, width: r.width, height: r.height };
    }
  } catch {
    // A grid not laid out yet reads as missing.
  }
  return null;
}

/**
 * Read a {@link ProjectionFrame} from a laid-out instance: its size, the rects
 * of grids `0..counts.grids-1` and the extents of x axes `0..counts.xAxes-1`
 * then y axes `0..counts.yAxes-1`. Anything the model cannot answer reads as
 * missing (`null`), which still compares stably.
 */
export function readProjectionFrame(
  instance: GateInstance,
  counts: { grids: number; xAxes: number; yAxes: number }
): ProjectionFrame {
  let model: ModelLike | null | undefined;
  try {
    model = instance.getModel?.() as ModelLike | null | undefined;
  } catch {
    model = undefined;
  }
  const grids: (GridRect | null)[] = [];
  for (let i = 0; i < counts.grids; i++) grids.push(rectOf(component(model, 'grid', i)));
  const extents: ([number, number] | null)[] = [];
  for (let i = 0; i < counts.xAxes; i++) extents.push(extentOf(component(model, 'xAxis', i)));
  for (let i = 0; i < counts.yAxes; i++) extents.push(extentOf(component(model, 'yAxis', i)));
  return { width: instance.getWidth(), height: instance.getHeight(), grids, extents };
}
