import type { ReactNode } from 'react';
import { AppHeader } from '@slaclab/canopy-shell';
import { formatShortcut } from '../hooks/useKeyboardShortcuts';

// Where the header's bug and help buttons go. A deployment points them at its own
// feedback form and docs site with these build-time variables.
const BUG_REPORT_URL =
  (import.meta.env.VITE_BUG_REPORT_URL as string | undefined) ||
  'https://github.com/slaclab/react-trace/issues/new/choose';
const DOCS_URL =
  (import.meta.env.VITE_DOCS_URL as string | undefined) || 'https://slaclab.github.io/react-trace/';

interface TraceHeaderProps {
  /** Live / archive trace counts of the active plot, shown in the middle slot. */
  liveCount: number;
  archiveCount: number;
  /** Trace's own actions (the Toolbar), rendered before the standard ones. */
  actions: ReactNode;
}

/**
 * The SLAC standard header from @slaclab/canopy-shell: "SLAC Trace" in brand
 * red, following the page theme, with the trailing actions in the standard
 * order (app actions, theme toggle, report a bug, docs). In-flow, not fixed:
 * trace is a single-screen app laid out as a flex column.
 *
 * The theme toggle shows the Alt/Option+T shortcut that useKeyboardShortcuts
 * binds; the skip link targets #main-content (the panel group in TraceApp).
 */
export function TraceHeader({ liveCount, archiveCount, actions }: TraceHeaderProps) {
  return (
    <AppHeader
      productName="Trace"
      actions={actions}
      themeToggle={{ shortcut: formatShortcut('alt', 'T') }}
      bugReportUrl={BUG_REPORT_URL}
      helpUrl={DOCS_URL}
      helpLabel="Docs"
    >
      <div className="trace-header__archiver">
        <span className="trace-header__counts">
          {liveCount} Live &bull; {archiveCount} Archive
        </span>
      </div>
    </AppHeader>
  );
}
