import type { ShapeProps } from '../types';

/** Renders a box's rectangle and label (the layer draws outline, hits and handles). */
export function BoxShape({ geometry }: ShapeProps) {
  return <>{geometry.body}</>;
}
