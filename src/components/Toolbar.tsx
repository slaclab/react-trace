import {
  Save,
  Printer,
  Upload,
  Download,
  Asleep,
  Light,
  Debug,
  Help,
  DataTable,
  Renew,
} from '@carbon/icons-react';
import { HeaderGlobalAction } from '@carbon/react';
import type { ColorMode } from '../state/themeStore';

interface ToolbarProps {
  colorMode: ColorMode;
  onSave: () => void;
  onPrint: () => void;
  onImport: () => void;
  onExport: () => void;
  onToggleTheme: () => void;
  onReportBug: () => void;
  onOpenDocs: () => void;
  onOpenDataInsight: () => void;
  onRefreshArchive: () => void;
}

// Carbon HeaderGlobalAction gives us hover/tooltip/keyboard handling for free
// and styles itself based on the surrounding <Theme>. The header above stays
// in g100 (dark brand bar) regardless of body theme — same convention as
// react-squirrel.
export function Toolbar({
  colorMode,
  onSave,
  onPrint,
  onImport,
  onExport,
  onToggleTheme,
  onReportBug,
  onOpenDocs,
  onOpenDataInsight,
  onRefreshArchive,
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
        aria-label="Data Insight"
        tooltipAlignment="end"
        onClick={onOpenDataInsight}
      >
        <DataTable size={20} />
      </HeaderGlobalAction>
      <HeaderGlobalAction aria-label="Save" tooltipAlignment="end" onClick={onSave}>
        <Save size={20} />
      </HeaderGlobalAction>
      <HeaderGlobalAction aria-label="Print" tooltipAlignment="end" onClick={onPrint}>
        <Printer size={20} />
      </HeaderGlobalAction>
      <HeaderGlobalAction aria-label="Import" tooltipAlignment="end" onClick={onImport}>
        <Upload size={20} />
      </HeaderGlobalAction>
      <HeaderGlobalAction aria-label="Export CSV" tooltipAlignment="end" onClick={onExport}>
        <Download size={20} />
      </HeaderGlobalAction>
      <HeaderGlobalAction
        aria-label={colorMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        tooltipAlignment="end"
        onClick={onToggleTheme}
      >
        {colorMode === 'dark' ? <Light size={20} /> : <Asleep size={20} />}
      </HeaderGlobalAction>
      <HeaderGlobalAction aria-label="Report a bug" tooltipAlignment="end" onClick={onReportBug}>
        <Debug size={20} />
      </HeaderGlobalAction>
      <HeaderGlobalAction aria-label="Docs" tooltipAlignment="end" onClick={onOpenDocs}>
        <Help size={20} />
      </HeaderGlobalAction>
    </>
  );
}
