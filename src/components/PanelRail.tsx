import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from '@carbon/icons-react';

interface PanelRailProps {
  side: 'left' | 'right';
  label: string;
  icon: ReactNode;
  onExpand: () => void;
}

// Thin vertical strip shown in place of a collapsed Layers / Properties panel.
// The whole rail is the click target (chevron + section icon + rotated label),
// so the user can re-open the panel without aiming at a single button.
export function PanelRail({ side, label, icon, onExpand }: PanelRailProps) {
  const Chevron = side === 'left' ? ChevronRight : ChevronLeft;
  return (
    <button
      type="button"
      className={`panel-rail panel-rail--${side}`}
      onClick={onExpand}
      title={`Expand ${label} panel`}
      aria-label={`Expand ${label} panel`}
    >
      <span className="panel-rail__chevron">
        <Chevron size={16} />
      </span>
      <span className="panel-rail__icon">{icon}</span>
      <span className="panel-rail__label">{label}</span>
    </button>
  );
}
