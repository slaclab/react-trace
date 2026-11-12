import type { ReactNode } from 'react';
import { AppHeader } from '@slaclab/canopy-shell';
import { formatShortcut } from '../hooks/useKeyboardShortcuts';

const BUG_REPORT_URL = 'https://forms.office.com/r/qV7BmK2xi9';
const DOCS_URL = 'https://fuzzy-adventure-4qvly8m.pages.github.io/';

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
