import { useState } from 'react';
import { Select, SelectItem, OverflowMenu, OverflowMenuItem } from '@carbon/react';
import { Renew, Download, Launch, Subtract, Close } from '@carbon/icons-react';
import type { Plot } from '../types';
import type { TimeWindowNs } from '../api/time';
import { useInsightData } from '../hooks/useInsightData';
import { buildInsightCsv, buildInsightJson } from '../io/exportInsight';
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
  plot: Plot;
  windowNs: TimeWindowNs;
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
  plot,
  windowNs,
  selectedPv,
  onSelectPv,
  detached = false,
  onClose,
  onMinimize,
  onDetach,
  onReattach,
}: DataInsightToolProps) {
  const inspectable = plot.traces.filter((t) => t.pvName);
  const selectedTrace = plot.traces.find((t) => t.id === selectedPv) ?? inspectable[0];
  const pv = selectedTrace?.pvName;
  const archiver = selectedTrace?.archiver ?? plot.archiver;

  const { rows, meta, status, error, decimated, refetch } = useInsightData(pv, archiver, windowNs);

  const totalPages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const [page, setPage] = useState(0);
  // Reset the page to 0 whenever the underlying row set changes (new PV, new
  // window, refetch). Comparing the previous rows reference during render and
  // calling setState is the idiomatic React pattern for resetting state from
  // a prop change without an effect.
  const [prevRows, setPrevRows] = useState(rows);
  if (prevRows !== rows) {
    setPrevRows(rows);
    setPage(0);
  }
  const safePage = Math.min(page, totalPages - 1);
  const startIdx = safePage * ROWS_PER_PAGE;
  const endIdx = Math.min(startIdx + ROWS_PER_PAGE, rows.length);
  const shown = rows.slice(startIdx, endIdx);

  const handleExport = (fmt: 'csv' | 'json') => {
    if (!meta || rows.length === 0) return;
    const base = safeName(meta.pv);
    if (fmt === 'csv') {
      downloadBlob(`${base}.csv`, 'text/csv', buildInsightCsv(meta, rows));
    } else {
      downloadBlob(`${base}.json`, 'application/json', buildInsightJson(meta, rows));
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
          value={selectedTrace?.id ?? ''}
          onChange={(e) => onSelectPv(e.target.value)}
          className="insight-tool__pv"
        >
          {inspectable.length === 0 && <SelectItem value="" text="No PVs on plot" />}
          {inspectable.map((t) => (
            <SelectItem key={t.id} value={t.id} text={t.pvName} />
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
            disabled={!pv || status === 'loading'}
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
