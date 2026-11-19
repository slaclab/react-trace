// The V-line's render component: its geometry's visible marks. The drawing
// layer keeps the selection outline, hit targets, handles and lock glyph.
import type { ShapeProps } from '../types';

export function VlineShape({ geometry }: ShapeProps) {
  return <>{geometry.body}</>;
}
