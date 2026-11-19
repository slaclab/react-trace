// The drawing rail's own icons: each one draws what its tool leaves on the
// plot (a line across, a band, a box, a measured box with its diagonal, a
// note's leader), so the icon says what the tool does. Each is drawn in the
// plot icon frame (`plot/icons`).
//
// No colour literals here (src/annotations is literal-guarded).
import { Icon, type IconProps } from '../plot/icons';

/** A dot marking where a drawing is anchored. */
const Dot = ({ cx, cy }: { cx: number; cy: number }) => (
  <circle cx={cx} cy={cy} r={1.3} fill="currentColor" stroke="none" />
);

export function TrendLineIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M3 12.5 13 3.5" />
      <Dot cx={3} cy={12.5} />
      <Dot cx={13} cy={3.5} />
    </Icon>
  );
}

export function HorizontalLineIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M1.5 8h13" />
      <Dot cx={8} cy={8} />
    </Icon>
  );
}

export function VerticalLineIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M8 1.5v13" />
      <Dot cx={8} cy={8} />
    </Icon>
  );
}

export function TimeRangeIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <rect
        x={4.5}
        y={2}
        width={7}
        height={12}
        fill="currentColor"
        fillOpacity={0.2}
        stroke="none"
      />
      <path d="M4.5 2v12M11.5 2v12" />
    </Icon>
  );
}

export function BoxIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x={2.5} y={4} width={11} height={8} />
    </Icon>
  );
}

export function MeasureIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x={2.5} y={4} width={11} height={8} strokeDasharray="1.6 1.6" />
      <path d="M2.5 12 13.5 4" />
    </Icon>
  );
}

export function NoteIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <Dot cx={3} cy={13} />
      <path d="M3 13 6.5 9.5" />
      <path d="M7.5 6h6M7.5 9h4" />
    </Icon>
  );
}
