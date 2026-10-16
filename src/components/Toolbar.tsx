import {
  Save,
  Printer,
  Upload,
  Download,
  Image,
  DataTable,
  Renew,
  SendAlt,
} from '@carbon/icons-react';
import { HeaderGlobalAction } from '@carbon/react';
import { formatShortcut } from '../hooks/useKeyboardShortcuts';

interface ToolbarProps {
  onSave: () => void;
  onPrint: () => void;
  onImport: () => void;
  onExport: () => void;
  onExportImage: () => void;
  onOpenDataInsight: () => void;
  onRefreshArchive: () => void;
  /** When set, shows a "Post to E-Log" action. Hidden when e-log is unconfigured. */
  onPostElog?: () => void;
}

// Trace's own header actions. AppHeader (see TraceHeader) renders them before
// the standard theme toggle, bug report and help actions. Carbon
// HeaderGlobalAction gives us hover/tooltip/keyboard handling for free and
// follows the header's theme.
export function Toolbar({
  onSave,
  onPrint,
  onImport,
  onExport,
  onExportImage,
  onOpenDataInsight,
  onRefreshArchive,
  onPostElog,
}: ToolbarProps) {
  return (
    <>
      <HeaderGlobalAction
        aria-label="Refresh archive data"
        tooltipAlignment="end"
        onClick={onRefreshArchive}
      >
        <Renew size={20} />
      </HeaderGlobalAction>
      <HeaderGlobalAction
        aria-label={`Data Insight (${formatShortcut('alt', 'D')})`}
        tooltipAlignment="end"
        onClick={onOpenDataInsight}
      >
        <DataTable size={20} />
      </HeaderGlobalAction>
      {onPostElog && (
        <HeaderGlobalAction
          aria-label={`Post to E-Log (${formatShortcut('primary', 'E')})`}
          tooltipAlignment="end"
          onClick={onPostElog}
        >
          <SendAlt size={20} />
        </HeaderGlobalAction>
      )}
      <HeaderGlobalAction
        aria-label={`Save (${formatShortcut('primary', 'S')})`}
        tooltipAlignment="end"
        onClick={onSave}
      >
        <Save size={20} />
      </HeaderGlobalAction>
      <HeaderGlobalAction
        aria-label={`Print (${formatShortcut('primary', 'P')})`}
        tooltipAlignment="end"
        onClick={onPrint}
      >
        <Printer size={20} />
      </HeaderGlobalAction>
      <HeaderGlobalAction
        aria-label={`Import (${formatShortcut('primary', 'O')})`}
        tooltipAlignment="end"
        onClick={onImport}
      >
        <Upload size={20} />
      </HeaderGlobalAction>
      <HeaderGlobalAction aria-label="Export CSV" tooltipAlignment="end" onClick={onExport}>
        <Download size={20} />
      </HeaderGlobalAction>
      <HeaderGlobalAction
        aria-label={`Export PNG (${formatShortcut('primary', 'I')})`}
        tooltipAlignment="end"
        onClick={onExportImage}
      >
        <Image size={20} />
      </HeaderGlobalAction>
    </>
  );
}
