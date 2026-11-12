import type { ShapeProps } from '../types';

/** Renders a measure's box and diagonal (the layer draws outline, hits, handles and the card). */
export function MeasureShape({ geometry }: ShapeProps) {
  return <>{geometry.body}</>;
}
