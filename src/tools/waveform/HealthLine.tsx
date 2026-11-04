// The Waveform canvas health line: one line on the
// canvas for the Hare connection status, on Correlation's pattern. Per-PV
// status (disconnected, empty, refused, length mismatch) stays on the Outline
// rows; this line only says whether the page's live data path is up.

import type { HareConnectionStatus } from '@slaclab/canopy-client';

const HEALTH_TEXT: Readonly<Record<HareConnectionStatus, string>> = {
  idle: 'Not connected to live data',
  connecting: 'Connecting to live data…',
  connected: 'Live data connected',
  disconnected: 'Live data connection lost — reconnecting…',
};

/** The line's text for a Hare connection status. */
function healthText(status: HareConnectionStatus): string {
  return HEALTH_TEXT[status];
}

export interface WaveformHealthLineProps {
  status: HareConnectionStatus;
}

export function WaveformHealthLine({ status }: WaveformHealthLineProps) {
  return (
    <p
      className="waveform-health"
      data-kind={status}
      role="status"
      aria-label="Health"
      data-testid="waveform-health"
    >
      {healthText(status)}
    </p>
  );
}
