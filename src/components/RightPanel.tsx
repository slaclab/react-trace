import type React from 'react';
import { useState } from 'react';
import { Settings, Radio, Archive, ChevronRight, DataTable } from '@carbon/icons-react';
import {
  Button,
  Tabs,
  TabList,
  Tab,
  TabPanels,
  TabPanel,
  TextInput,
  Select,
  SelectItem,
  Toggle,
  NumberInput,
  ComboBox,
} from '@carbon/react';
import type { Plot, PVTrace, Axis } from '../types';
import {
  LINE_TYPE_OPTIONS,
  LINE_STYLE_OPTIONS,
  SYMBOL_OPTIONS,
  echartsLineType,
  echartsSymbol,
} from '../curveStyle';
import type { SelectedItem } from './TraceApp';
import { DEFAULT_OPTIMIZED_BINS, type ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import { LIVE_RETENTION_DEFAULT_MS, type LiveSeriesResult } from '../hooks/useLiveSeries';
import { ArchiverPicker } from './ArchiverPicker';
import { usePVSearch } from '../hooks/usePVSearch';
import { PanelRail } from './PanelRail';

interface RightPanelProps {
  selectedItem: SelectedItem;
  activePlot: Plot;
  archiveResults: Map<string, ArchiveSeriesResult>;
  liveResults: Map<string, LiveSeriesResult>;
  collapsed: boolean;
  onUpdateTrace: (traceId: string, updates: Partial<PVTrace>) => void;
  onUpdateAxis: (axisId: string, updates: Partial<Axis>) => void;
  onUpdatePlot: (updates: Partial<Plot>) => void;
  onInspectTrace: (traceId: string) => void;
  onCollapse: () => void;
  onExpand: () => void;
  getAxisRange: (axisId: string) => [number, number] | undefined;
}

export function RightPanel({
  selectedItem,
  activePlot,
  archiveResults,
  liveResults,
  collapsed,
  onUpdateTrace,
  onUpdateAxis,
  onUpdatePlot,
  onInspectTrace,
  onCollapse,
  onExpand,
  getAxisRange,
}: RightPanelProps) {
  if (collapsed) {
    return (
      <PanelRail
        side="right"
        label="Properties"
        icon={<Settings size={16} />}
        onExpand={onExpand}
      />
    );
  }
  const selectedTrace =
    selectedItem?.type === 'trace' ? activePlot.traces.find((t) => t.id === selectedItem.id) : null;
  const selectedTraceArchive = selectedTrace ? archiveResults.get(selectedTrace.id) : undefined;
  const selectedTraceLive = selectedTrace ? liveResults.get(selectedTrace.id) : undefined;
  const selectedAxis =
    selectedItem?.type === 'axis' ? activePlot.axes.find((a) => a.id === selectedItem.id) : null;
  const isPlotSelected = selectedItem?.type === 'plot';

  // Build the tab set based on what's selected. Plot has only General; axis
  // adds Line + Code; trace adds Symbol on top of those. Carbon Tabs needs
  // matching Tab/TabPanel counts, so we keyed the wrapper on selection type
  // — the component fully resets when the selection changes, which dodges
  // mismatched-index warnings.
  const tabs: { label: string; render: () => React.ReactNode }[] = [];

  if (selectedTrace) {
    tabs.push({
      label: 'General',
      render: () => (
        <TraceGeneralTab
          trace={selectedTrace}
          axes={activePlot.axes}
          archiveResult={selectedTraceArchive}
          liveResult={selectedTraceLive}
          plotArchiver={activePlot.archiver}
          onUpdate={(u) => onUpdateTrace(selectedTrace.id, u)}
          onInspect={() => onInspectTrace(selectedTrace.id)}
        />
      ),
    });
    tabs.push({
      label: 'Line',
      render: () => (
        <TraceLineTab trace={selectedTrace} onUpdate={(u) => onUpdateTrace(selectedTrace.id, u)} />
      ),
    });
    tabs.push({
      label: 'Symbol',
      render: () => (
        <TraceSymbolTab
          trace={selectedTrace}
          onUpdate={(u) => onUpdateTrace(selectedTrace.id, u)}
        />
      ),
    });
    tabs.push({ label: 'Code', render: () => <TraceCodeTab trace={selectedTrace} /> });
  } else if (selectedAxis) {
    tabs.push({
      label: 'General',
      render: () => (
        <AxisGeneralTab
          axis={selectedAxis}
          getAxisRange={getAxisRange}
          onUpdate={(u) => onUpdateAxis(selectedAxis.id, u)}
        />
      ),
    });
    tabs.push({ label: 'Code', render: () => <AxisCodeTab axis={selectedAxis} /> });
  } else if (isPlotSelected) {
    tabs.push({
      label: 'General',
      render: () => <PlotGeneralTab plot={activePlot} onUpdate={onUpdatePlot} />,
    });
    tabs.push({ label: 'Code', render: () => <PlotCodeTab plot={activePlot} /> });
  }

  const tabsKey = selectedTrace
    ? 'trace'
    : selectedAxis
      ? 'axis'
      : isPlotSelected
        ? 'plot'
        : 'empty';

  return (
    <div className="properties-panel">
      <div className="properties-panel__header">
        <Settings size={16} />
        <span className="properties-panel__title">Properties</span>
        <button
          className="panel-collapse-btn"
          title="Collapse panel"
          onClick={onCollapse}
          style={{ marginLeft: 'auto' }}
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {tabs.length === 0 ? (
        <div className="properties-panel__content">
          <p className="properties-panel__empty">
            Select a trace, axis, or plot to view properties.
          </p>
        </div>
      ) : (
        <Tabs key={tabsKey}>
          <TabList aria-label="Properties tabs" className="properties-panel__tabs">
            {tabs.map((t) => (
              <Tab key={t.label}>{t.label}</Tab>
            ))}
          </TabList>
          <TabPanels>
            {tabs.map((t) => (
              <TabPanel key={t.label}>
                <div className="properties-panel__content">{t.render()}</div>
              </TabPanel>
            ))}
          </TabPanels>
        </Tabs>
      )}
    </div>
  );
}

// ── Trace tabs ────────────────────────────────────────────────────────────────

function TraceGeneralTab({
  trace,
  axes,
  archiveResult,
  liveResult,
  plotArchiver,
  onUpdate,
  onInspect,
}: {
  trace: PVTrace;
  axes: Axis[];
  archiveResult: ArchiveSeriesResult | undefined;
  liveResult: LiveSeriesResult | undefined;
  plotArchiver: string | undefined;
  onUpdate: (u: Partial<PVTrace>) => void;
  onInspect: () => void;
}) {
  const [pvQuery, setPvQuery] = useState<string>(trace.pvName);
  // Reset the local query when the panel switches to a different trace, so the
  // previous trace's typed-but-uncommitted text doesn't leak across. (useState
  // only seeds on first mount; switching traces reuses the same component.)
  const [prevTraceId, setPrevTraceId] = useState(trace.id);
  if (trace.id !== prevTraceId) {
    setPrevTraceId(trace.id);
    setPvQuery(trace.pvName);
  }
  // While the query still equals the committed PV name (i.e. the user hasn't
  // typed anything new), don't search; an empty pattern keeps us from
  // re-fetching matches for the already-selected PV on every focus.
  const searchPattern = pvQuery === trace.pvName ? '' : pvQuery;
  const search = usePVSearch(searchPattern, trace.archiver ?? plotArchiver);
  const items: string[] = (() => {
    const seen = new Set<string>();
    const out: string[] = [];
    if (trace.pvName) {
      seen.add(trace.pvName);
      out.push(trace.pvName);
    }
    for (const pv of search.pvs) {
      if (!seen.has(pv)) {
        seen.add(pv);
        out.push(pv);
      }
    }
    return out;
  })();
  const archivePointCount = archiveResult?.mean.length ?? 0;
  const livePointCount = liveResult?.points.length ?? 0;
  const liveStatus = liveResult?.status ?? 'idle';
  const liveConnected = liveResult?.connected ?? false;
  const liveSeverity = liveResult?.severity ?? null;
  const liveError = liveResult?.error ?? null;
  const liveStatusLabel = !trace.useLive
    ? 'Disabled'
    : liveStatus === 'connecting'
      ? 'Connecting…'
      : liveStatus === 'connected' && liveConnected
        ? 'Connected'
        : liveStatus === 'connected'
          ? 'Waiting for value'
          : 'Disconnected';
  const liveStatusColor = !trace.useLive
    ? 'var(--cds-text-helper)'
    : liveStatus === 'connected' && liveConnected
      ? 'var(--cds-support-success)'
      : liveStatus === 'connecting'
        ? 'var(--cds-link-primary)'
        : 'var(--cds-text-error)';
  const severityColor = (s: typeof liveSeverity): string => {
    switch (s) {
      case 'NO_ALARM':
        return 'var(--cds-support-success)';
      case 'MINOR':
        return 'var(--cds-support-warning)';
      case 'MAJOR':
        return 'var(--cds-support-error)';
      case 'INVALID':
        return 'var(--cds-support-info)';
      default:
        return 'var(--cds-text-helper)';
    }
  };
  let archiveStatusLabel: string;
  let archiveStatusColor: string;
  if (!trace.useArchive) {
    archiveStatusLabel = 'Disabled';
    archiveStatusColor = 'var(--cds-text-helper)';
  } else if (!archiveResult || archiveResult.status === 'idle') {
    archiveStatusLabel = 'Idle';
    archiveStatusColor = 'var(--cds-text-helper)';
  } else if (archiveResult.status === 'loading') {
    archiveStatusLabel = 'Loading…';
    archiveStatusColor = 'var(--cds-link-primary)';
  } else if (archiveResult.status === 'error') {
    archiveStatusLabel = archiveResult.error?.code ?? 'Error';
    archiveStatusColor = 'var(--cds-text-error)';
  } else {
    archiveStatusLabel = `Loaded${archiveResult.mode === 'binned' ? ' (binned)' : ' (raw)'}${archiveResult.decimated ? ' · decimated' : ''}`;
    archiveStatusColor = 'var(--cds-support-success)';
  }
  return (
    <div>
      <div className="prop-section">
        <div className="prop-section__title">Identity</div>
        <div className="prop-row">
          <ComboBox
            id="pv-name"
            titleText="PV Name"
            placeholder="Type to search PVs"
            items={items}
            itemToString={(item: string | null | undefined) => item ?? ''}
            selectedItem={trace.pvName || null}
            onInputChange={(text: string) => {
              // Track keystrokes locally to drive the search dropdown only.
              // Committing pvName here would fire an archive fetch + live
              // subscription for every partial string (`c`, `ca`, ...), flooding
              // the backend with lookups for nonexistent PVs. We commit on
              // selection / Enter instead (onChange).
              setPvQuery(text);
            }}
            onChange={({ selectedItem }: { selectedItem?: string | null }) => {
              // Carbon fires onChange on selection and on Enter with a custom
              // value. Fall back to the trimmed typed query for the latter.
              const pv = (selectedItem || pvQuery).trim();
              if (pv) {
                setPvQuery(pv);
                onUpdate({
                  pvName: pv,
                  displayName:
                    !trace.displayName ||
                    trace.displayName === trace.pvName ||
                    trace.displayName === 'New Trace'
                      ? pv
                      : trace.displayName,
                });
              }
            }}
            allowCustomValue
            helperText={
              search.status === 'loading'
                ? 'Searching…'
                : search.status === 'error'
                  ? `Search failed: ${search.error?.code ?? 'unknown'}`
                  : search.status === 'ready' && pvQuery
                    ? `${search.pvs.length} match${search.pvs.length === 1 ? '' : 'es'}`
                    : ''
            }
            size="sm"
          />
        </div>
        <div className="prop-row">
          <TextInput
            id="display-name"
            labelText="Display Name"
            value={trace.displayName}
            onChange={(e) => onUpdate({ displayName: e.target.value })}
            size="sm"
          />
        </div>
        <div className="prop-row">
          <Select
            id="y-axis"
            labelText="Y-Axis"
            value={trace.axisId}
            onChange={(e) => onUpdate({ axisId: e.target.value })}
            size="sm"
          >
            {axes.map((axis) => (
              <SelectItem key={axis.id} value={axis.id} text={axis.name} />
            ))}
          </Select>
        </div>
        <div className="prop-row prop-row--inline">
          <Toggle
            id="trace-visible"
            labelText="Visible"
            labelA="Hidden"
            labelB="Visible"
            toggled={trace.visible}
            onToggle={(checked) => onUpdate({ visible: checked })}
            size="sm"
          />
        </div>
      </div>

      <div className="prop-divider" />

      <div className="prop-section">
        <div className="prop-section__title">Formula / Transform</div>
        <p style={{ fontSize: 11, color: 'var(--cds-text-helper)', marginBottom: 10 }}>
          Apply a mathematical transformation to trace data.
        </p>
        <div style={{ marginBottom: 8 }}>
          <label
            style={{
              display: 'block',
              fontSize: 11,
              color: 'var(--cds-text-helper)',
              marginBottom: 4,
            }}
          >
            Formula
          </label>
          <textarea
            className="prop-code-area"
            placeholder="e.g., y * 1.5 + 10"
            rows={3}
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <p
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--cds-text-secondary)',
              marginBottom: 6,
            }}
          >
            Available variables:
          </p>
          <div style={{ fontSize: 11, color: 'var(--cds-text-helper)', lineHeight: 1.8 }}>
            <div>
              <code style={{ color: '#78a9ff', fontSize: 12 }}>y</code>
              {' — '}Current value
            </div>
            <div>
              <code style={{ color: '#78a9ff', fontSize: 12 }}>t</code>
              {' — '}Timestamp (ms)
            </div>
          </div>
        </div>
        <Button kind="primary" size="sm" style={{ width: '100%', maxWidth: 'none' }}>
          Apply Transform
        </Button>
      </div>

      <div className="prop-divider" />

      <div className="prop-section">
        <div className="prop-section__title">Data Sources</div>

        {/* Live Data */}
        <div className="prop-row prop-row--inline">
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--cds-text-secondary)',
            }}
          >
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: 2,
                borderRadius: 2,
                backgroundColor: 'rgba(66,190,101,0.2)',
                color: 'var(--cds-support-success)',
              }}
            >
              <Radio size={12} />
            </span>
            Live Data
          </span>
          <Toggle
            id="use-live"
            labelText=""
            labelA="Off"
            labelB="On"
            toggled={trace.useLive}
            onToggle={(checked) => onUpdate({ useLive: checked })}
            size="sm"
            hideLabel
          />
        </div>
        {trace.useLive && (
          <div className="prop-row prop-subsection">
            <Select
              id="update-rate"
              labelText="Update Rate"
              value={trace.updateRate}
              onChange={(e) => onUpdate({ updateRate: e.target.value })}
              disabled
              helperText="Server-batched monitor stream; per-trace rate selection is planned."
              title="Server-batched monitor stream; per-trace rate selection is planned."
              size="sm"
            >
              <SelectItem value="monitor" text="Monitor (fastest)" />
              <SelectItem value="1hz" text="1 Hz" />
              <SelectItem value="10hz" text="10 Hz" />
              <SelectItem value="on-change" text="On Change" />
            </Select>
          </div>
        )}
        {trace.useLive && (
          <div className="prop-row prop-subsection">
            <NumberInput
              id="live-retention"
              label="Live retention (s)"
              helperText={`How long live samples are kept (default ${LIVE_RETENTION_DEFAULT_MS / 1000}s)`}
              min={5}
              max={1800}
              step={5}
              value={(trace.liveRetentionMs ?? LIVE_RETENTION_DEFAULT_MS) / 1000}
              onChange={(_, { value }) => {
                if (value === '' || value === undefined) {
                  onUpdate({ liveRetentionMs: undefined });
                  return;
                }
                onUpdate({ liveRetentionMs: Math.round(Number(value) * 1000) });
              }}
              size="sm"
              allowEmpty
            />
          </div>
        )}

        {/* Archive Data */}
        <div className="prop-row prop-row--inline" style={{ marginTop: 8 }}>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--cds-text-secondary)',
            }}
          >
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: 2,
                borderRadius: 2,
                backgroundColor: 'rgba(141,141,141,0.2)',
                color: 'var(--cds-text-helper)',
              }}
            >
              <Archive size={12} />
            </span>
            Archive Data
          </span>
          <Toggle
            id="use-archive"
            labelText=""
            labelA="Off"
            labelB="On"
            toggled={trace.useArchive}
            onToggle={(checked) => onUpdate({ useArchive: checked })}
            size="sm"
            hideLabel
          />
        </div>
        {trace.useArchive && (
          <div className="prop-row prop-subsection">
            <ArchiverPicker
              value={trace.archiver}
              onChange={(next) => onUpdate({ archiver: next })}
              includeGlobalOption
              label="Archiver"
            />
          </div>
        )}
        {trace.useArchive && (
          <div className="prop-row prop-subsection prop-row--inline">
            <Toggle
              id="show-archive-band"
              labelText="Show min/max band"
              labelA="Off"
              labelB="On"
              toggled={trace.showArchiveBand !== false}
              onToggle={(checked) => onUpdate({ showArchiveBand: checked })}
              size="sm"
            />
          </div>
        )}
        {trace.useArchive && (
          <div className="prop-row prop-subsection">
            <NumberInput
              id="optimized-bins"
              label="Optimized bin count"
              helperText={`Default ${DEFAULT_OPTIMIZED_BINS}`}
              min={1}
              max={100000}
              step={100}
              value={trace.optimizedDataBins ?? DEFAULT_OPTIMIZED_BINS}
              onChange={(_, { value }) => {
                const next = value === '' || value === undefined ? undefined : Number(value);
                onUpdate({ optimizedDataBins: next });
              }}
              size="sm"
              allowEmpty
            />
          </div>
        )}

        {/* Footer stats */}
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--cds-text-helper)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Data points:</span>
            <span style={{ color: 'var(--cds-text-secondary)' }}>
              {trace.useArchive
                ? archivePointCount
                : trace.useLive
                  ? livePointCount
                  : trace.data.length}
            </span>
          </div>
          {trace.useLive && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                <span>Live Status:</span>
                <span style={{ color: liveStatusColor }}>{liveStatusLabel}</span>
              </div>
              {liveSeverity && liveConnected && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                  <span>Severity:</span>
                  <span style={{ color: severityColor(liveSeverity) }}>{liveSeverity}</span>
                </div>
              )}
              {liveError && (
                <div style={{ marginTop: 4, color: 'var(--cds-text-error)' }}>
                  {liveError.message}
                </div>
              )}
            </>
          )}
          {trace.useArchive && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                <span>Archive Status:</span>
                <span style={{ color: archiveStatusColor }}>{archiveStatusLabel}</span>
              </div>
              {archiveResult?.archiver && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                  <span>Source:</span>
                  <span style={{ color: 'var(--cds-text-secondary)' }}>
                    {archiveResult.archiver}
                  </span>
                </div>
              )}
              {archiveResult?.status === 'error' && archiveResult.error?.detail && (
                <div style={{ marginTop: 4, color: 'var(--cds-text-error)' }}>
                  {archiveResult.error.detail}
                </div>
              )}
            </>
          )}
        </div>
        <Button
          kind="ghost"
          size="sm"
          renderIcon={DataTable}
          onClick={onInspect}
          disabled={!trace.pvName}
          style={{ marginTop: 8 }}
        >
          Inspect data
        </Button>
      </div>
    </div>
  );
}

function TraceLineTab({
  trace,
  onUpdate,
}: {
  trace: PVTrace;
  onUpdate: (u: Partial<PVTrace>) => void;
}) {
  return (
    <div>
      <div className="prop-section">
        <div className="prop-section__title">Line Style</div>
        <div className="prop-row">
          <label
            style={{
              display: 'block',
              fontSize: 12,
              color: 'var(--cds-text-secondary)',
              marginBottom: 6,
            }}
          >
            Color
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="color"
              value={trace.color}
              onChange={(e) => onUpdate({ color: e.target.value })}
              style={{
                width: 36,
                height: 32,
                padding: 2,
                border: '1px solid #525252',
                borderRadius: 2,
                backgroundColor: 'var(--cds-field)',
                cursor: 'pointer',
              }}
            />
            <TextInput
              id="line-color-hex"
              labelText=""
              hideLabel
              value={trace.color}
              onChange={(e) => onUpdate({ color: e.target.value })}
              size="sm"
              style={{ flex: 1 }}
            />
          </div>
        </div>
        <div className="prop-row">
          <Select
            id="line-type"
            labelText="Type"
            value={trace.lineType}
            onChange={(e) => onUpdate({ lineType: e.target.value as PVTrace['lineType'] })}
            size="sm"
          >
            {LINE_TYPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value} text={o.label} />
            ))}
          </Select>
        </div>
        <div className="prop-row">
          <NumberInput
            id="line-width"
            label="Line Width"
            value={trace.lineWidth}
            min={1}
            max={5}
            onChange={(_e, { value }) => {
              if (typeof value === 'number') onUpdate({ lineWidth: value });
            }}
            size="sm"
          />
        </div>
        <div className="prop-row">
          <Select
            id="line-style"
            labelText="Style"
            value={trace.lineStyle}
            onChange={(e) => onUpdate({ lineStyle: e.target.value as PVTrace['lineStyle'] })}
            size="sm"
          >
            {LINE_STYLE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value} text={o.label} />
            ))}
          </Select>
        </div>
        <div className="prop-row prop-row--inline">
          <Toggle
            id="extend-to-now"
            labelText="Extend to current time"
            labelA="Off"
            labelB="On"
            toggled={trace.showExtensionLine !== false}
            onToggle={(checked) => onUpdate({ showExtensionLine: checked })}
            size="sm"
          />
        </div>
      </div>
    </div>
  );
}

function TraceSymbolTab({
  trace,
  onUpdate,
}: {
  trace: PVTrace;
  onUpdate: (u: Partial<PVTrace>) => void;
}) {
  return (
    <div>
      <div className="prop-section">
        <div className="prop-section__title">Symbol Settings</div>
        <div className="prop-row prop-row--inline">
          <Toggle
            id="show-symbols"
            labelText="Show Symbols"
            labelA="Off"
            labelB="On"
            toggled={trace.showSymbol}
            onToggle={(checked) => onUpdate({ showSymbol: checked })}
            size="sm"
          />
        </div>
        {trace.showSymbol && (
          <>
            <div className="prop-row">
              <Select
                id="symbol-shape"
                labelText="Shape"
                value={trace.symbolShape}
                onChange={(e) =>
                  onUpdate({ symbolShape: e.target.value as PVTrace['symbolShape'] })
                }
                size="sm"
              >
                {SYMBOL_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value} text={o.label} />
                ))}
              </Select>
            </div>
            <div className="prop-row">
              <NumberInput
                id="symbol-size"
                label="Size"
                value={trace.symbolSize}
                min={1}
                max={25}
                onChange={(_e, { value }) => {
                  if (typeof value === 'number') onUpdate({ symbolSize: value });
                }}
                size="sm"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TraceCodeTab({ trace }: { trace: PVTrace }) {
  const config = `{
  name: '${trace.displayName}',
  type: 'line',
  step: ${trace.lineType === 'step' ? "'end'" : 'false'},

  // Line Style
  lineStyle: {
    color: '${trace.color}',
    width: ${trace.lineWidth},
    type: ${JSON.stringify(echartsLineType(trace.lineStyle))},
    opacity: ${trace.lineStyle === 'none' ? 0 : 1}
  },

  // Symbol
  symbol: '${trace.showSymbol ? echartsSymbol(trace.symbolShape) : 'none'}',
  symbolSize: ${trace.symbolSize},
  showSymbol: ${trace.showSymbol},

  // Sampling
  sampling: 'lttb',

  // Animation
  animation: false
}`;

  return (
    <div>
      <div className="prop-section">
        <div className="prop-section__title">ECharts Series Config</div>
        <p style={{ fontSize: 11, color: 'var(--cds-text-helper)', marginBottom: 8 }}>
          Direct ECharts series configuration for this trace.
        </p>
        <textarea className="prop-code-area" defaultValue={config} rows={20} spellCheck={false} />
        <div className="prop-code-actions">
          <button
            style={{
              flex: 1,
              padding: '6px 12px',
              fontSize: 12,
              backgroundColor: 'var(--cds-button-primary)',
              color: 'var(--cds-text-on-color)',
              border: 'none',
              borderRadius: 2,
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Apply Changes
          </button>
          <button
            style={{
              padding: '6px 12px',
              fontSize: 12,
              backgroundColor: 'var(--cds-button-secondary)',
              color: 'var(--cds-text-on-color)',
              border: 'none',
              borderRadius: 2,
              cursor: 'pointer',
            }}
          >
            Format
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Axis tabs ─────────────────────────────────────────────────────────────────

function AxisGeneralTab({
  axis,
  getAxisRange,
  onUpdate,
}: {
  axis: Axis;
  getAxisRange: (axisId: string) => [number, number] | undefined;
  onUpdate: (u: Partial<Axis>) => void;
}) {
  // Toggling auto-scale off should leave the user on the same range they were
  // already seeing. Seed min/max from the displayed range only when the axis
  // has none yet, so re-toggling later doesn't clobber edited values.
  const handleAutoScaleToggle = (checked: boolean) => {
    if (!checked && axis.min === undefined && axis.max === undefined) {
      const range = getAxisRange(axis.id);
      if (range) {
        onUpdate({ autoScale: false, min: range[0], max: range[1] });
        return;
      }
    }
    onUpdate({ autoScale: checked });
  };
  return (
    <div>
      <div className="prop-section">
        <div className="prop-section__title">Axis Settings</div>
        <div className="prop-row">
          <TextInput
            id="axis-label"
            labelText="Label"
            value={axis.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
            size="sm"
          />
        </div>
        <div className="prop-row">
          <Select
            id="axis-orientation"
            labelText="Orientation"
            value={axis.orientation}
            onChange={(e) => onUpdate({ orientation: e.target.value as Axis['orientation'] })}
            size="sm"
          >
            <SelectItem value="left" text="Left" />
            <SelectItem value="right" text="Right" />
          </Select>
        </div>
        <div className="prop-row prop-row--inline">
          <Toggle
            id="axis-visible"
            labelText="Visible"
            labelA="Hidden"
            labelB="Visible"
            toggled={axis.visible}
            onToggle={(checked) => onUpdate({ visible: checked })}
            size="sm"
          />
        </div>
        <div className="prop-row prop-row--inline">
          <Toggle
            id="axis-autoscale"
            labelText="Auto Scale"
            labelA="Manual"
            labelB="Auto"
            toggled={axis.autoScale}
            onToggle={handleAutoScaleToggle}
            size="sm"
          />
        </div>
        {!axis.autoScale && (
          <>
            <div className="prop-row">
              <NumberInput
                id="axis-min"
                label="Min Value"
                value={axis.min ?? 0}
                onChange={(_e, { value }) => {
                  if (typeof value === 'number') onUpdate({ min: value });
                }}
                size="sm"
              />
            </div>
            <div className="prop-row">
              <NumberInput
                id="axis-max"
                label="Max Value"
                value={axis.max ?? 100}
                onChange={(_e, { value }) => {
                  if (typeof value === 'number') onUpdate({ max: value });
                }}
                size="sm"
              />
            </div>
          </>
        )}
        <div className="prop-row prop-row--inline">
          <Toggle
            id="axis-logscale"
            labelText="Log Scale"
            labelA="Linear"
            labelB="Log"
            toggled={axis.logScale}
            onToggle={(checked) => onUpdate({ logScale: checked })}
            size="sm"
          />
        </div>
      </div>
    </div>
  );
}

function AxisCodeTab({ axis }: { axis: Axis }) {
  const config = `{
  type: '${axis.logScale ? 'log' : 'value'}',
  name: '${axis.name}',
  position: '${axis.orientation}',

  // Scale
  min: ${axis.autoScale ? 'null' : (axis.min ?? 0)},
  max: ${axis.autoScale ? 'null' : (axis.max ?? 100)},
  scale: ${axis.autoScale},

  // Labels
  axisLabel: {
    color: 'var(--cds-text-secondary)',
    fontSize: 11
  }
}`;

  return (
    <div>
      <div className="prop-section">
        <div className="prop-section__title">ECharts Axis Config</div>
        <textarea className="prop-code-area" defaultValue={config} rows={20} spellCheck={false} />
        <div className="prop-code-actions">
          <button
            style={{
              flex: 1,
              padding: '6px 12px',
              fontSize: 12,
              backgroundColor: 'var(--cds-button-primary)',
              color: 'var(--cds-text-on-color)',
              border: 'none',
              borderRadius: 2,
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Apply Changes
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Plot tabs ─────────────────────────────────────────────────────────────────

function PlotGeneralTab({ plot, onUpdate }: { plot: Plot; onUpdate: (u: Partial<Plot>) => void }) {
  return (
    <div>
      <div className="prop-section">
        <div className="prop-section__title">Plot Settings</div>
        <div className="prop-row">
          <TextInput
            id="plot-title"
            labelText="Title"
            value={plot.title}
            onChange={(e) => onUpdate({ title: e.target.value })}
            size="sm"
          />
        </div>
        <div className="prop-row">
          <label
            style={{
              display: 'block',
              fontSize: 12,
              color: 'var(--cds-text-secondary)',
              marginBottom: 6,
            }}
          >
            Background Color
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="color"
              value={plot.backgroundColor}
              onChange={(e) => onUpdate({ backgroundColor: e.target.value })}
              style={{
                width: 36,
                height: 32,
                padding: 2,
                border: '1px solid #525252',
                borderRadius: 2,
                backgroundColor: 'var(--cds-field)',
                cursor: 'pointer',
              }}
            />
            <TextInput
              id="plot-bg-hex"
              labelText=""
              hideLabel
              value={plot.backgroundColor}
              onChange={(e) => onUpdate({ backgroundColor: e.target.value })}
              size="sm"
              style={{ flex: 1 }}
            />
          </div>
        </div>
        <div className="prop-row prop-row--inline">
          <Toggle
            id="show-gridlines"
            labelText="Show Gridlines"
            labelA="Off"
            labelB="On"
            toggled={plot.showGridlines}
            onToggle={(checked) => onUpdate({ showGridlines: checked })}
            size="sm"
          />
        </div>
        {plot.showGridlines && (
          <div className="prop-row">
            <Select
              id="grid-style"
              labelText="Grid Style"
              value={plot.gridStyle}
              onChange={(e) => onUpdate({ gridStyle: e.target.value as Plot['gridStyle'] })}
              size="sm"
            >
              <SelectItem value="solid" text="Solid" />
              <SelectItem value="dashed" text="Dashed" />
              <SelectItem value="dotted" text="Dotted" />
            </Select>
          </div>
        )}
        <div className="prop-row">
          <ArchiverPicker
            value={plot.archiver}
            onChange={(next) => onUpdate({ archiver: next })}
            label="Default Archiver"
            width="100%"
          />
        </div>
      </div>

      <div className="prop-divider" />

      <div className="prop-section">
        <div className="prop-section__title">X-Axis (Time)</div>
        <div className="prop-row">
          <Select
            id="time-range"
            labelText="Time Range"
            value={plot.xAxis.timeRange}
            onChange={(e) => onUpdate({ xAxis: { ...plot.xAxis, timeRange: e.target.value } })}
            size="sm"
          >
            <SelectItem value="-1h" text="Last 1 Hour" />
            <SelectItem value="-4h" text="Last 4 Hours" />
            <SelectItem value="-1d" text="Last 1 Day" />
            <SelectItem value="-2d" text="Last 2 Days" />
            <SelectItem value="-1w" text="Last 1 Week" />
            <SelectItem value="-1m" text="Last 1 Month" />
            <SelectItem value="custom" text="Custom Range..." />
          </Select>
        </div>
        {plot.xAxis.timeRange === 'custom' && (
          <>
            <div className="prop-row">
              <TextInput
                id="time-from"
                labelText="From"
                type="datetime-local"
                value={plot.xAxis.timeFrom ?? ''}
                onChange={(e) => onUpdate({ xAxis: { ...plot.xAxis, timeFrom: e.target.value } })}
                size="sm"
              />
            </div>
            <div className="prop-row">
              <TextInput
                id="time-to"
                labelText="To"
                type="datetime-local"
                value={plot.xAxis.timeTo ?? ''}
                onChange={(e) => onUpdate({ xAxis: { ...plot.xAxis, timeTo: e.target.value } })}
                size="sm"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PlotCodeTab({ plot }: { plot: Plot }) {
  const config = `{
  // Plot
  title: '${plot.title}',
  backgroundColor: '${plot.backgroundColor}',
  defaultArchiver: ${plot.archiver ? `'${plot.archiver}'` : 'backend default'},

  // X-axis (time)
  xAxis: {
    type: 'time',
    timeRange: '${plot.xAxis.timeRange}'${plot.xAxis.timeFrom ? `,\n    timeFrom: '${plot.xAxis.timeFrom}'` : ''}${plot.xAxis.timeTo ? `,\n    timeTo: '${plot.xAxis.timeTo}'` : ''}
  },

  // Grid
  splitLine: {
    show: ${plot.showGridlines},
    lineStyle: { type: '${plot.gridStyle}' }
  },

  // Composition
  axes: ${plot.axes.length},
  traces: ${plot.traces.length}
}`;

  return (
    <div>
      <div className="prop-section">
        <div className="prop-section__title">ECharts Plot Config</div>
        <p style={{ fontSize: 11, color: 'var(--cds-text-helper)', marginBottom: 8 }}>
          Top-level ECharts option for this plot.
        </p>
        <textarea className="prop-code-area" defaultValue={config} rows={20} spellCheck={false} />
        <div className="prop-code-actions">
          <button
            style={{
              flex: 1,
              padding: '6px 12px',
              fontSize: 12,
              backgroundColor: 'var(--cds-button-primary)',
              color: 'var(--cds-text-on-color)',
              border: 'none',
              borderRadius: 2,
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Apply Changes
          </button>
        </div>
      </div>
    </div>
  );
}
