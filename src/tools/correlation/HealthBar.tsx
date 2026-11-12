// The health line as shown in the tab: the state's text, each suffix of
// the latest frame, and a Retry action after a non-retryable error. The line
// itself is computed in health.ts; this only draws it.

import { Button } from '@carbon/react';
import type { HealthLine } from './health';

export interface HealthBarProps {
  health: HealthLine;
  /** Re-subscribe after a non-retryable error. */
  onRetry: () => void;
}

export function HealthBar({ health, onRetry }: HealthBarProps) {
  const retry = health.retry && (
    <Button type="button" kind="tertiary" size="sm" onClick={onRetry}>
      Retry
    </Button>
  );
  return (
    <div className="correlation-health" data-kind={health.kind}>
      <p
        className="correlation-health__line"
        role="status"
        aria-label="Health"
        data-testid="correlation-health"
      >
        <span className="correlation-health__text" data-testid="health-text">
          {health.text}
        </span>
        {health.suffixes.map((suffix) => (
          <span key={suffix} className="correlation-health__suffix">
            <span aria-hidden="true"> · </span>
            <span data-testid="health-suffix">{suffix}</span>
          </span>
        ))}
      </p>
      {retry}
    </div>
  );
}
