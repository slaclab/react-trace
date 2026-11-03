// The H-line's render component: it draws the geometry's visible marks.
// The layer keeps the selection outline, hit targets, handles and lock glyph.
import type { ShapeProps } from '../types';

export function HLineShape({ geometry }: ShapeProps) {
  return <>{geometry.body}</>;
}
