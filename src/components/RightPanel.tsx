import { useState } from 'react';
import { Settings, Radio, Archive, ChevronRight } from '@carbon/icons-react';
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
import type { SelectedItem } from './TraceApp';
import { DEFAULT_OPTIMIZED_BINS, type ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import { ArchiverPicker } from './ArchiverPicker';
import { usePVSearch } from '../hooks/usePVSearch';

interface RightPanelProps {
  selectedItem: SelectedItem;
  activePlot: Plot;
  archiveResults: Map<string, ArchiveSeriesResult>;
  globalArchiver: string | undefined;
  onUpdateTrace: (traceId: string, updates: Partial<PVTrace>) => void;
  onUpdateAxis: (axisId: string, updates: Partial<Axis>) => void;
  onUpdatePlot: (updates: Partial<Plot>) => void;
  onCollapse: () => void;
}

export function RightPanel({
  selectedItem,
  activePlot,
  archiveResults,
  globalArchiver,
  onUpdateTrace,
  onUpdateAxis,
  onUpdatePlot,
  onCollapse,
}: RightPanelProps) {
  const selectedTrace =
    selectedItem?.type === 'trace' ? activePlot.traces.find((t) => t.id === selectedItem.id) : null;
  const selectedTraceArchive = selectedTrace ? archiveResults.get(selectedTrace.id) : undefined;
  const selectedAxis =
    selectedItem?.type === 'axis' ? activePlot.axes.find((a) => a.id === selectedItem.id) : null;
  const isPlotSelected = selectedItem?.type === 'plot';

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

      <Tabs>
        <TabList aria-label="Properties tabs" className="properties-panel__tabs">
          <Tab>General</Tab>
          <Tab>Line</Tab>
          <Tab>Symbol</Tab>
          <Tab>Code</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <div className="properties-panel__content">
              {selectedTrace && (
                <TraceGeneralTab
                  trace={selectedTrace}
                  axes={activePlot.axes}
                  archiveResult={selectedTraceArchive}
                  globalArchiver={globalArchiver}
                  onUpdate={(u) => onUpdateTrace(selectedTrace.id, u)}
                />
              )}
              {selectedAxis && !selectedTrace && (
                <AxisGeneralTab
                  axis={selectedAxis}
                  onUpdate={(u) => onUpdateAxis(selectedAxis.id, u)}
                />
              )}
              {isPlotSelected && !selectedTrace && !selectedAxis && (
                <PlotGeneralTab plot={activePlot} onUpdate={onUpdatePlot} />
              )}
              {!selectedTrace && !selectedAxis && !isPlotSelected && (
                <p className="properties-panel__empty">
                  Select a trace, axis, or plot to view properties.
                </p>
              )}
            </div>
          </TabPanel>

          <TabPanel>
            <div className="properties-panel__content">
              {selectedTrace && (
                <TraceLineTab
                  trace={selectedTrace}
                  onUpdate={(u) => onUpdateTrace(selectedTrace.id, u)}
                />
              )}
              {selectedAxis && !selectedTrace && (
                <AxisLineTab
                  axis={selectedAxis}
                  onUpdate={(u) => onUpdateAxis(selectedAxis.id, u)}
                />
              )}
              {isPlotSelected && !selectedTrace && !selectedAxis && (
                <PlotLineTab plot={activePlot} onUpdate={onUpdatePlot} />
              )}
              {!selectedTrace && !selectedAxis && !isPlotSelected && (
                <p className="properties-panel__empty">Select an item to edit line settings.</p>
              )}
            </div>
          </TabPanel>

          <TabPanel>
            <div className="properties-panel__content">
              {selectedTrace && (
                <TraceSymbolTab
                  trace={selectedTrace}
                  onUpdate={(u) => onUpdateTrace(selectedTrace.id, u)}
                />
              )}
              {!selectedTrace && (
                <p className="properties-panel__empty">Select a trace to edit symbol settings.</p>
              )}
            </div>
          </TabPanel>

          <TabPanel>
            <div className="properties-panel__content">
              {selectedTrace && <TraceCodeTab trace={selectedTrace} />}
              {selectedAxis && !selectedTrace && <AxisCodeTab axis={selectedAxis} />}
              {!selectedTrace && !selectedAxis && (
                <p className="properties-panel__empty">Select a trace or axis to view config.</p>
              )}
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}

// ── Trace tabs ────────────────────────────────────────────────────────────────

function TraceGeneralTab({
  trace,
  axes,
  archiveResult,
  globalArchiver,
  onUpdate,
}: {
  trace: PVTrace;
  axes: Axis[];
  archiveResult: ArchiveSeriesResult | undefined;
  globalArchiver: string | undefined;
  onUpdate: (u: Partial<PVTrace>) => void;
}) {
  const [pvQuery, setPvQuery] = useState<string>(trace.pvName);
  const search = usePVSearch(pvQuery, trace.archiver ?? globalArchiver);
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
  let archiveStatusLabel: string;
  let archiveStatusColor: string;
  if (!trace.useArchive) {
    archiveStatusLabel = 'Disabled';
    archiveStatusColor = '#6f6f6f';
  } else if (!archiveResult || archiveResult.status === 'idle') {
    archiveStatusLabel = 'Idle';
    archiveStatusColor = '#8d8d8d';
  } else if (archiveResult.status === 'loading') {
    archiveStatusLabel = 'Loading…';
    archiveStatusColor = '#0f62fe';
  } else if (archiveResult.status === 'error') {
    archiveStatusLabel = archiveResult.error?.code ?? 'Error';
    archiveStatusColor = '#ff8389';
  } else {
    archiveStatusLabel = `Loaded${archiveResult.mode === 'binned' ? ' (binned)' : ' (raw)'}${archiveResult.decimated ? ' · decimated' : ''}`;
    archiveStatusColor = '#42be65';
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
              setPvQuery(text);
              if (text) onUpdate({ pvName: text });
            }}
            onChange={({ selectedItem }: { selectedItem?: string | null }) => {
              if (selectedItem) {
                setPvQuery(selectedItem);
                onUpdate({
                  pvName: selectedItem,
                  displayName:
                    !trace.displayName ||
                    trace.displayName === trace.pvName ||
                    trace.displayName === 'New Trace'
                      ? selectedItem
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
        <p style={{ fontSize: 11, color: '#8d8d8d', marginBottom: 10 }}>
          Apply a mathematical transformation to trace data.
        </p>
        <div style={{ marginBottom: 8 }}>
          <label style={{ display: 'block', fontSize: 11, color: '#8d8d8d', marginBottom: 4 }}>
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
          <p style={{ fontSize: 11, fontWeight: 600, color: '#c6c6c6', marginBottom: 6 }}>
            Available variables:
          </p>
          <div style={{ fontSize: 11, color: '#8d8d8d', lineHeight: 1.8 }}>
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
              color: '#c6c6c6',
            }}
          >
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: 2,
                borderRadius: 2,
                backgroundColor: 'rgba(66,190,101,0.2)',
                color: '#42be65',
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
              size="sm"
            >
              <SelectItem value="monitor" text="Monitor (fastest)" />
              <SelectItem value="1hz" text="1 Hz" />
              <SelectItem value="10hz" text="10 Hz" />
              <SelectItem value="on-change" text="On Change" />
            </Select>
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
              color: '#c6c6c6',
            }}
          >
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: 2,
                borderRadius: 2,
                backgroundColor: 'rgba(141,141,141,0.2)',
                color: '#8d8d8d',
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
            <Select
              id="archive-time-range"
              labelText="Time Range"
              value={trace.archiveTimeRange}
              onChange={(e) => onUpdate({ archiveTimeRange: e.target.value })}
              size="sm"
            >
              <SelectItem value="-1h" text="Last Hour" />
              <SelectItem value="-4h" text="Last 4 Hours" />
              <SelectItem value="-1d" text="Last 24 Hours" />
              <SelectItem value="-1w" text="Last Week" />
              <SelectItem value="custom" text="Custom Range…" />
            </Select>
          </div>
        )}
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
              value={trace.optimizedDataBins ?? ''}
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
        <div style={{ marginTop: 8, fontSize: 11, color: '#6f6f6f' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Data points:</span>
            <span style={{ color: '#c6c6c6' }}>
              {trace.useArchive ? archivePointCount : trace.data.length}
            </span>
          </div>
          {trace.useLive && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
              <span>Live Status:</span>
              <span style={{ color: '#42be65' }}>Connected</span>
            </div>
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
                  <span style={{ color: '#c6c6c6' }}>{archiveResult.archiver}</span>
                </div>
              )}
              {archiveResult?.status === 'error' && archiveResult.error?.detail && (
                <div style={{ marginTop: 4, color: '#ff8389' }}>{archiveResult.error.detail}</div>
              )}
            </>
          )}
        </div>
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
          <label style={{ display: 'block', fontSize: 12, color: '#c6c6c6', marginBottom: 6 }}>
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
                backgroundColor: '#393939',
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
          <NumberInput
            id="line-width"
            label="Line Width"
            value={trace.lineWidth}
            min={1}
            max={10}
            onChange={(_e, { value }) => {
              if (typeof value === 'number') onUpdate({ lineWidth: value });
            }}
            size="sm"
          />
        </div>
        <div className="prop-row">
          <Select
            id="line-style"
            labelText="Line Style"
            value={trace.lineStyle}
            onChange={(e) => onUpdate({ lineStyle: e.target.value as PVTrace['lineStyle'] })}
            size="sm"
          >
            <SelectItem value="solid" text="Solid" />
            <SelectItem value="dashed" text="Dashed" />
            <SelectItem value="dotted" text="Dotted" />
          </Select>
        </div>
      </div>
    </div>
  );
}

function TraceSymbolTab({ trace }: { trace: PVTrace; onUpdate: (u: Partial<PVTrace>) => void }) {
  const [showSymbols, setShowSymbols] = useState(false);
  const [symbolType, setSymbolType] = useState('circle');
  const [symbolSize, setSymbolSize] = useState(4);
  const [fillColor, setFillColor] = useState(trace.color);

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
            toggled={showSymbols}
            onToggle={setShowSymbols}
            size="sm"
          />
        </div>
        {showSymbols && (
          <>
            <div className="prop-row">
              <Select
                id="symbol-type"
                labelText="Symbol Type"
                value={symbolType}
                onChange={(e) => setSymbolType(e.target.value)}
                size="sm"
              >
                <SelectItem value="circle" text="Circle" />
                <SelectItem value="rect" text="Square" />
                <SelectItem value="diamond" text="Diamond" />
                <SelectItem value="triangle" text="Triangle" />
                <SelectItem value="pin" text="Pin" />
              </Select>
            </div>
            <div className="prop-row">
              <NumberInput
                id="symbol-size"
                label="Symbol Size"
                value={symbolSize}
                min={1}
                max={20}
                onChange={(_e, { value }) => {
                  if (typeof value === 'number') setSymbolSize(value);
                }}
                size="sm"
              />
            </div>
            <div className="prop-row">
              <label style={{ display: 'block', fontSize: 12, color: '#c6c6c6', marginBottom: 6 }}>
                Fill Color
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="color"
                  value={fillColor}
                  onChange={(e) => setFillColor(e.target.value)}
                  style={{
                    width: 36,
                    height: 32,
                    padding: 2,
                    border: '1px solid #525252',
                    borderRadius: 2,
                    backgroundColor: '#393939',
                    cursor: 'pointer',
                  }}
                />
                <TextInput
                  id="symbol-fill-color-hex"
                  labelText=""
                  hideLabel
                  value={fillColor}
                  onChange={(e) => setFillColor(e.target.value)}
                  size="sm"
                  style={{ flex: 1 }}
                />
              </div>
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

  // Line Style
  lineStyle: {
    color: '${trace.color}',
    width: ${trace.lineWidth},
    type: '${trace.lineStyle}'
  },

  // Symbol
  symbol: 'none',
  symbolSize: 4,
  showSymbol: false,

  // Sampling
  sampling: 'lttb',

  // Animation
  animation: false
}`;

  return (
    <div>
      <div className="prop-section">
        <div className="prop-section__title">ECharts Series Config</div>
        <p style={{ fontSize: 11, color: '#6f6f6f', marginBottom: 8 }}>
          Direct ECharts series configuration for this trace.
        </p>
        <textarea className="prop-code-area" defaultValue={config} rows={20} spellCheck={false} />
        <div className="prop-code-actions">
          <button
            style={{
              flex: 1,
              padding: '6px 12px',
              fontSize: 12,
              backgroundColor: '#0f62fe',
              color: '#ffffff',
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
              backgroundColor: '#393939',
              color: '#f4f4f4',
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

function AxisGeneralTab({ axis, onUpdate }: { axis: Axis; onUpdate: (u: Partial<Axis>) => void }) {
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
            onToggle={(checked) => onUpdate({ autoScale: checked })}
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

function AxisLineTab({ axis }: { axis: Axis; onUpdate: (u: Partial<Axis>) => void }) {
  const [showGrid, setShowGrid] = useState(axis.visible);
  const [gridStyle, setGridStyle] = useState('solid');

  return (
    <div>
      <div className="prop-section">
        <div className="prop-section__title">Grid Lines</div>
        <div className="prop-row prop-row--inline">
          <Toggle
            id="show-grid"
            labelText="Show Grid Lines"
            labelA="Off"
            labelB="On"
            toggled={showGrid}
            onToggle={setShowGrid}
            size="sm"
          />
        </div>
        {showGrid && (
          <div className="prop-row">
            <Select
              id="grid-style"
              labelText="Grid Style"
              value={gridStyle}
              onChange={(e) => setGridStyle(e.target.value)}
              size="sm"
            >
              <SelectItem value="solid" text="Solid" />
              <SelectItem value="dashed" text="Dashed" />
              <SelectItem value="dotted" text="Dotted" />
            </Select>
          </div>
        )}
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

  // Grid
  splitLine: {
    show: true,
    lineStyle: {
      color: '#393939',
      type: 'solid'
    }
  },

  // Labels
  axisLabel: {
    color: '#c6c6c6',
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
              backgroundColor: '#0f62fe',
              color: '#ffffff',
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
          <label style={{ display: 'block', fontSize: 12, color: '#c6c6c6', marginBottom: 6 }}>
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
                backgroundColor: '#393939',
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

function PlotLineTab({ plot, onUpdate }: { plot: Plot; onUpdate: (u: Partial<Plot>) => void }) {
  return (
    <div>
      <div className="prop-section">
        <div className="prop-section__title">Grid Settings</div>
        <div className="prop-row prop-row--inline">
          <Toggle
            id="plot-gridlines"
            labelText="Show Grid Lines"
            labelA="Off"
            labelB="On"
            toggled={plot.showGridlines}
            onToggle={(checked) => onUpdate({ showGridlines: checked })}
            size="sm"
          />
        </div>
      </div>
    </div>
  );
}
