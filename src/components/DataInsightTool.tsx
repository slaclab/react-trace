import { useState } from 'react';
import { Select, SelectItem, OverflowMenu, OverflowMenuItem } from '@carbon/react';
import { Renew, Download, Launch, Subtract, Close } from '@carbon/icons-react';
import type { Plot } from '../types';
import type { TimeWindowNs } from '../api/time';
import { useInsightData } from '../hooks/useInsightData';
import { buildInsightCsv, buildInsightJson, buildInsightMat } from '../io/exportInsight';
import { downloadBlob } from '../io/download';

// Page size for the interactive table; export still writes everything.
const ROWS_PER_PAGE = 2000;

// 24h date format, ms precision. Matches the plot tooltip's hour-format and
// preserves sub-second resolution which is the inspector's main job.
const DATETIME_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hour12: false,
};

interface DataInsightToolProps {
  /** Plots whose PVs can be inspected (all visible plots in grid view). */
  plots: Plot[];
  /** Each plot's current time window, keyed by plot id. */
  windowByPlotId: Map<string, TimeWindowNs>;
  /** Trace id of the selected PV. */
  selectedPv: string;
  onSelectPv: (traceId: string) => void;
  detached?: boolean;
  onClose: () => void;
  onMinimize?: () => void;
  onDetach?: () => void;
  onReattach?: () => void;
}

function safeName(s: string): string {
  return s.replace(/[/\\?%*:|"<>]/g, '_') || 'pv';
}

export function DataInsightTool({
  plots,
  windowByPlotId,
  selectedPv,
  onSelectPv,
  detached = false,
  onClose,
  onMinimize,
  onDetach,
  onReattach,
}: DataInsightToolProps) {
  // Inspectable PVs across every provided plot, each tagged with its plot so we
  // can resolve the right archiver and time window when it's selected.
  const inspectable = plots.flatMap((p) =>
    p.traces.filter((t) => t.pvName).map((trace) => ({ trace, plot: p }))
  );
  const multiPlot = plots.length > 1;
  const selected = inspectable.find((x) => x.trace.id === selectedPv) ?? inspectable[0];
  const pv = selected?.trace.pvName;
  const traceId = selected?.trace.id;
  const archiver = selected?.trace.archiver ?? selected?.plot.archiver;
  const windowNs = selected ? windowByPlotId.get(selected.plot.id) : undefined;

  const { rows, meta, status, error, decimated, refreshing, refetch } = useInsightData(
    pv,
    archiver,
    windowNs,
    traceId
  );

  const totalPages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const [page, setPage] = useState(0);
  // Reset to the first page when the selected PV changes — not when the row set
  // merely grows from streaming live samples, which would otherwise yank the
  // user back to page 1 on every incoming sample. Comparing the previous value
  // during render and calling setState is the idiomatic React pattern for
  // resetting state from a prop change without an effect.
  const [prevTraceId, setPrevTraceId] = useState(traceId);
  if (prevTraceId !== traceId) {
    setPrevTraceId(traceId);
    setPage(0);
  }
  const safePage = Math.min(page, totalPages - 1);
  const startIdx = safePage * ROWS_PER_PAGE;
  const endIdx = Math.min(startIdx + ROWS_PER_PAGE, rows.length);
  const shown = rows.slice(startIdx, endIdx);

  const handleExport = (fmt: 'csv' | 'json' | 'mat') => {
    if (!meta || rows.length === 0) return;
    const base = safeName(meta.pv);
    if (fmt === 'csv') {
      downloadBlob(`${base}.csv`, 'text/csv', buildInsightCsv(meta, rows));
    } else if (fmt === 'json') {
      downloadBlob(`${base}.json`, 'application/json', buildInsightJson(meta, rows));
    } else {
      downloadBlob(`${base}.mat`, 'application/octet-stream', buildInsightMat(meta, rows));
    }
  };

  const metaLine = [meta?.units, meta?.description].filter(Boolean).join(' · ');

  return (
    <div className="insight-tool">
      <div className="insight-tool__bar">
        <Select
          id="insight-pv"
          labelText=""
          hideLabel
          size="sm"
          value={selected?.trace.id ?? ''}
          onChange={(e) => onSelectPv(e.target.value)}
          className="insight-tool__pv"
        >
          {inspectable.length === 0 && <SelectItem value="" text="No PVs on plot" />}
          {inspectable.map(({ trace, plot }) => (
            <SelectItem
              key={trace.id}
              value={trace.id}
              text={multiPlot ? `${plot.title} · ${trace.pvName}` : trace.pvName}
            />
          ))}
        </Select>

        {status === 'loading' && <span className="insight-tool__status">Loading…</span>}
        {status === 'ready' && (
          <span className="insight-tool__status">
            {rows.length.toLocaleString()} rows
            {decimated ? ' (decimated)' : ''}
            {rows.length > ROWS_PER_PAGE
              ? ` · showing ${(startIdx + 1).toLocaleString()}-${endIdx.toLocaleString()}`
              : ''}
          </span>
        )}
        {status === 'ready' && rows.length > ROWS_PER_PAGE && (
          <span className="insight-tool__pager">
            <button
              className="insight-tool__btn"
              title="Previous page"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
            >
              ‹
            </button>
            <span className="insight-tool__pager-label">
              Page {safePage + 1} of {totalPages}
            </span>
            <button
              className="insight-tool__btn"
              title="Next page"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
            >
              ›
            </button>
          </span>
        )}

        <div className="insight-tool__actions">
          <button
            className="insight-tool__btn"
            title="Refresh"
            onClick={refetch}
            disabled={!pv || status === 'loading' || refreshing}
          >
            <Renew size={16} />
          </button>
          <OverflowMenu
            renderIcon={Download}
            size="sm"
            flipped
            iconDescription="Export"
            disabled={status !== 'ready' || rows.length === 0}
          >
            <OverflowMenuItem itemText="Export CSV" onClick={() => handleExport('csv')} />
            <OverflowMenuItem itemText="Export JSON" onClick={() => handleExport('json')} />
            <OverflowMenuItem itemText="Export MAT" onClick={() => handleExport('mat')} />
          </OverflowMenu>
          {!detached && onDetach && (
            <button className="insight-tool__btn" title="Pop out to window" onClick={onDetach}>
              <Launch size={16} />
            </button>
          )}
          {!detached && onMinimize && (
            <button className="insight-tool__btn" title="Minimize" onClick={onMinimize}>
              <Subtract size={16} />
            </button>
          )}
          {detached && onReattach && (
            <button className="insight-tool__btn" title="Reattach" onClick={onReattach}>
              <Launch size={16} />
            </button>
          )}
          <button className="insight-tool__btn" title="Close" onClick={onClose}>
            <Close size={16} />
          </button>
        </div>
      </div>

      <div className="insight-tool__meta">{metaLine || (pv ? ' ' : 'Select a PV')}</div>

      <div className="insight-tool__table-wrap">
        {status === 'error' ? (
          <div className="insight-tool__empty insight-tool__empty--error">{error}</div>
        ) : status === 'ready' && rows.length === 0 ? (
          <div className="insight-tool__empty">No data in the plot's time range.</div>
        ) : status === 'idle' ? (
          <div className="insight-tool__empty">Add a PV to the plot to inspect its data.</div>
        ) : (
          <table className="insight-tool__table">
            <thead>
              <tr>
                <th>Datetime</th>
                <th>Value</th>
                <th>Severity</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={`${r.tsNs}-${i}`}>
                  <td>{new Date(r.tsNs / 1e6).toLocaleString(undefined, DATETIME_FORMAT)}</td>
                  <td>{r.value === null ? '' : String(r.value)}</td>
                  <td>{r.severity}</td>
                  <td>{r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
