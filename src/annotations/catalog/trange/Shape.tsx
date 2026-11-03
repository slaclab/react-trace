import type { ShapeProps } from '../types';

/** Renders a time range's band, edges and label (the layer draws outline, hits and handles). */
export function TrangeShape({ geometry }: ShapeProps) {
  return <>{geometry.body}</>;
}
