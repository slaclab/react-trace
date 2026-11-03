// The plot strip's own icons (magnet, keep drawing, data tooltip) and the
// icon frame every strip and rail icon is drawn in: a 16-unit grid, fine
// strokes in `currentColor`, the same weight as the drawings themselves.
//
// No colour literals here (src/plot is literal-guarded).
import type { ReactNode } from 'react';

export interface IconProps {
  size?: number;
}

export function Icon({ size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Snap to data: a horseshoe magnet. */
export function MagnetIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M4 2.5v5.5a4 4 0 0 0 8 0V2.5" />
      <path d="M4 5.5h2.5M9.5 5.5H12" />
      <path d="M6.5 2.5v5.5a1.5 1.5 0 0 0 3 0V2.5" />
    </Icon>
  );
}

/** Keep drawing: a pencil with a loop, the tool stays armed after each drawing. */
export function KeepDrawingIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M2.5 13.5 3.2 11 9.5 4.7l1.8 1.8L5 12.8z" />
      <path d="M8.5 5.7l1.8 1.8" />
      <path d="M11.5 10.5a2.5 2.5 0 1 0 2-3.6" />
      <path d="M13.5 5.2v1.8h-1.8" />
    </Icon>
  );
}

/** The data tooltip: a cursor's cross with the read-out box beside it. */
export function DataTooltipIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M5 6.5v8M1 10.5h8" />
      <rect x={8.5} y={1.5} width={6} height={5} rx={0.8} />
      <path d="M10 3.5h3M10 5h2" strokeWidth={0.9} />
    </Icon>
  );
}
