// The drawing status line: the plot's `StatusLine`
// over the host's stores, catalog and x axis, which also shows what the last
// link shed: "N drawings not saved in the link" while drawings were dropped,
// "Note text shortened in the link" when only note text was trimmed. The
// notice fills the line's trailing slot; with nothing shed the slot keeps its
// own content (Trace's embedded-tile notice).
//
// It reads the `ShedStore` through `useSyncExternalStore`, so a publish
// re-renders only this line; it never subscribes to `config.frames`.
import { useSyncExternalStore, type ReactNode } from 'react';
import { StatusLine } from '../StatusLine';
import { shedNoticeOf, type DrawingHost } from './useDrawingHost';

export interface DrawingStatusLineProps {
  host: DrawingHost;
  /** This plot's position in the plot list (Trace's embedded notice). */
  plotIndex?: number;
  /** The app runs embedded in a host tile (Trace's embedded notice). */
  embedded?: boolean;
  /** The selected or hovered drawing's axis: the value is read on it in its grid. */
  focusAxisId?: string | null;
  /** Replaces the armed tool's hint (Waveform's "waiting for the X source"). */
  toolHint?: ReactNode;
}

export function DrawingStatusLine({
  host,
  plotIndex,
  embedded,
  focusAxisId,
  toolHint,
}: DrawingStatusLineProps) {
  const { config, document: doc } = host;
  const shed = useSyncExternalStore(config.shed.subscribe, config.shed.get, config.shed.get);
  const notice = shedNoticeOf(shed);
  return (
    <StatusLine
      cursorStore={host.cursorStore}
      projectionStore={host.projectionStore}
      primaryAxisId={host.axes[0]?.id}
      tool={doc.prefs.tool}
      toolHint={toolHint}
      plotIndex={plotIndex}
      embedded={embedded}
      embeddedHint={notice === null ? undefined : <span data-status-shed-notice="">{notice}</span>}
      catalog={config.catalog}
      xAxis={config.xAxis}
      focusAxisId={focusAxisId}
    />
  );
}
