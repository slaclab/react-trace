// Post to e-log for a single-chart tool (Correlation, Waveform): Canopy's
// e-log config decides whether the action shows, a click captures the
// chart as a PNG and opens the post dialog, and "Attach config" attaches the
// page address that reopens the tool's state. The PNG source is either an
// ECharts instance (sync getDataURL) or a composer that resolves the chart
// with its drawings on top (async).

import { useState, type ReactNode } from 'react';
import { PostToElogModal } from '../components/PostToElogModal';
import { useElogConfig } from '../hooks/useElogConfig';
import type { CapturedPlot } from '../io/exportPlotImage';

/** Options a capture passes to its PNG source. */
export interface PngSourceOptions {
  type: 'png';
  pixelRatio: number;
  backgroundColor: string;
}

/**
 * What a capture needs of the chart: an ECharts instance (sync data URL), or
 * an async source that composes the drawings over the chart.
 */
export interface PngSource {
  getDataURL(opts: PngSourceOptions): string | Promise<string>;
}

/** The "Attach config" file: the page address that reopens `query`. */
export function pageConfigFile(query: string, fileName: string): File {
  const url = `${window.location.origin}${window.location.pathname}${query ? `?${query}` : ''}`;
  return new File([url], fileName, { type: 'text/plain' });
}

export interface ChartElogPostOptions {
  /** The captured plot's id and title in the post dialog. */
  id: string;
  title: string;
  /** Builds the "Attach config" file; called when the post is sent. */
  buildConfigFile(): File;
}

export interface ChartElogPost {
  /** Canopy's e-log config says enabled: Post to e-log is shown. */
  elog: boolean;
  /** Capture `chart` over `backgroundColor` and open the dialog; nothing when e-log is off or without a chart. */
  post(chart: PngSource | null | undefined, backgroundColor: string): void;
  /** The dialog, to render beside the workbench; null when e-log is off. */
  modal: ReactNode;
}

export function useChartElogPost({
  id,
  title,
  buildConfigFile,
}: ChartElogPostOptions): ChartElogPost {
  const elogConfig = useElogConfig();
  const elog = elogConfig?.enabled ?? false;
  const [dialog, setDialog] = useState<{ open: boolean; captured: CapturedPlot[] }>({
    open: false,
    captured: [],
  });

  const post = (chart: PngSource | null | undefined, backgroundColor: string) => {
    if (!elog || !chart) return;
    const open = (dataUrl: string | null | undefined) =>
      setDialog({
        open: true,
        captured: dataUrl?.startsWith('data:') ? [{ id, title, dataUrl }] : [],
      });
    const result = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor });
    // A sync source opens the dialog in the same event, as before; an async
    // one opens it once the composed image resolves (a failure posts no image).
    if (typeof result === 'string') open(result);
    else result.then(open, () => open(null));
  };

  const modal = elogConfig?.enabled ? (
    <PostToElogModal
      open={dialog.open}
      captured={dialog.captured}
      defaultLogbookIds={elogConfig.defaultLogbookIds}
      buildConfigFile={buildConfigFile}
      onClose={() => setDialog((p) => ({ ...p, open: false }))}
    />
  ) : null;

  return { elog, post, modal };
}
