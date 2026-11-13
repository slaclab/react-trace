import type React from 'react';
import { useState, useEffect } from 'react';
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
  Slider,
} from '@carbon/react';
import type { SliderProps } from '@carbon/react';
import type { Plot, PVTrace, Axis } from '../types';
import { traceLabel } from '../traceLabel';
import {
  LINE_TYPE_OPTIONS,
  LINE_STYLE_OPTIONS,
  SYMBOL_OPTIONS,
  echartsLineType,
  echartsSymbol,
} from '../curveStyle';
import { PALETTES, getPalette } from '../palettes';
import { usePaletteId } from '../state/paletteStore';
import type { SelectedItem } from './TraceApp';
import { parseSpanMs, resolveTimeWindow } from '../api/time';
import { DEFAULT_OPTIMIZED_BINS, type ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import { LIVE_RETENTION_DEFAULT_MS, type LiveSeriesResult } from '../hooks/useLiveSeries';
import {
  DEFAULT_REFRESH_INTERVAL_S,
  MIN_REFRESH_S,
  MAX_REFRESH_S,
  clampInterval,
  refreshIntervalMs,
} from '../hooks/useAutoScrollTimers';
import { ArchiverPicker } from './ArchiverPicker';
import { usePVSearch } from '../hooks/usePVSearch';
import { PanelRail } from './PanelRail';
import { useCanopyConnection } from '@slaclab/canopy-react';
import { errorInfo } from '../api/errorInfo';
import { validateFormula } from '../api/formulaEngine';
import { extractFormulaVars, resolveBindings } from '../formula';

interface RightPanelProps {
  selectedItem: SelectedItem;
  activePlot: Plot;
  // The active plot's clock ("now" for its time range); see useAutoScrollTimers.
  nowMs: number;
  archiveResults: Map<string, ArchiveSeriesResult>;
  liveResults: Map<string, LiveSeriesResult>;
  collapsed: boolean;
  onUpdateTrace: (traceId: string, updates: Partial<PVTrace>) => void;
  // Fired when the user picks a concrete PV for a trace; triggers units-based
  // axis assignment in the parent.
  onSelectPv: (traceId: string, pvName: string) => void;
  onUpdateAxis: (axisId: string, updates: Partial<Axis>) => void;
  onUpdatePlot: (updates: Partial<Plot>) => void;
  onApplyPalette: (paletteId: string, scope: { plotId: string; axisId?: string }) => void;
  onInspectTrace: (traceId: string) => void;
  onCreateFormula: (sourceTraceId: string) => void;
  onCollapse: () => void;
  onExpand: () => void;
  getAxisRange: (axisId: string) => [number, number] | undefined;
}

export function RightPanel({
  selectedItem,
  activePlot,
  nowMs,
  archiveResults,
  liveResults,
  collapsed,
  onUpdateTrace,
  onSelectPv,
  onUpdateAxis,
  onUpdatePlot,
  onApplyPalette,
  onInspectTrace,
  onCreateFormula,
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
      render: () =>
        selectedTrace.kind === 'formula' ? (
          <FormulaGeneralTab
            trace={selectedTrace}
            axes={activePlot.axes}
            bindableTraces={activePlot.traces.filter(
              (t) => t.id !== selectedTrace.id && t.kind !== 'formula' && !!t.pvName
            )}
            onUpdate={(u) => onUpdateTrace(selectedTrace.id, u)}
          />
        ) : (
          <TraceGeneralTab
            trace={selectedTrace}
            plotTraces={activePlot.traces}
            axes={activePlot.axes}
            archiveResult={selectedTraceArchive}
            liveResult={selectedTraceLive}
            plotArchiver={activePlot.archiver}
            onUpdate={(u) => onUpdateTrace(selectedTrace.id, u)}
            onSelectPv={(pv) => onSelectPv(selectedTrace.id, pv)}
            onInspect={() => onInspectTrace(selectedTrace.id)}
            onCreateFormula={() => onCreateFormula(selectedTrace.id)}
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
    tabs.push({
      label: 'Code',
      render: () => (
        <TraceCodeTab trace={selectedTrace} label={traceLabel(selectedTrace, activePlot.traces)} />
      ),
    });
  } else if (selectedAxis) {
    tabs.push({
      label: 'General',
      render: () => (
        <AxisGeneralTab
          axis={selectedAxis}
          plotId={activePlot.id}
          getAxisRange={getAxisRange}
          onUpdate={(u) => onUpdateAxis(selectedAxis.id, u)}
          onApplyPalette={onApplyPalette}
        />
      ),
    });
    tabs.push({ label: 'Code', render: () => <AxisCodeTab axis={selectedAxis} /> });
  } else if (isPlotSelected) {
    tabs.push({
      label: 'General',
      render: () => (
        <PlotGeneralTab
          plot={activePlot}
          nowMs={nowMs}
          onUpdate={onUpdatePlot}
          onApplyPalette={onApplyPalette}
        />
      ),
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

// Editor for a formula curve: an expression over {var} placeholders plus a
// binding table mapping each variable to a PV-backed curve on the same plot.
// Replaces PV traces' "PV Name + Data Sources" with formula-specific controls.
function FormulaGeneralTab({
  trace,
  axes,
  bindableTraces,
  onUpdate,
}: {
  trace: PVTrace;
  axes: Axis[];
  bindableTraces: PVTrace[];
  onUpdate: (u: Partial<PVTrace>) => void;
}) {
  const expression = trace.expression ?? '';
  const bindings = trace.bindings ?? {};
  const vars = extractFormulaVars(expression);
  const unbound = vars.filter((v) => !bindings[v]);
  const hasExpr = expression.trim().length > 0;

  // Debounced live validation via the Formula Engine. Sends whatever bindings are resolved so
  // far, so the server red-lines bad syntax (and missing bindings) as you type.
  const canopy = useCanopyConnection();
  const [validation, setValidation] = useState<{ valid: boolean; errors: string[] } | null>(null);
  // Resolve to actual PV names here and key the effect on the result. Keying on
  // the raw bindings object alone would miss a bound curve's pvName changing
  // while its target id stays the same, leaving validation to fire against stale
  // PV names read from the closure.
  const resolvedBindings = resolveBindings(trace, bindableTraces);
  const resolvedKey = JSON.stringify(resolvedBindings);
  useEffect(() => {
    const expr = expression.trim();
    if (!expr) return;
    const ac = new AbortController();
    const handle = setTimeout(() => {
      validateFormula(
        canopy,
        { kind: 'timeseries', expression: expr, bindings: resolvedBindings },
        ac.signal
      )
        .then((r) => {
          if (!ac.signal.aborted) setValidation({ valid: r.valid, errors: r.errors });
        })
        .catch((err: unknown) => {
          if (ac.signal.aborted || (err as { name?: string }).name === 'AbortError') return;
          setValidation({ valid: false, errors: [errorInfo(err).detail] });
        });
    }, 400);
    return () => {
      clearTimeout(handle);
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- expression + resolved bindings capture the inputs
  }, [canopy, expression, resolvedKey]);

  return (
    <div>
      <div className="prop-section">
        <div className="prop-section__title">Identity</div>
        <div className="prop-row">
          <TextInput
            id="formula-display-name"
            labelText="Display Name"
            value={trace.displayName}
            onChange={(e) => onUpdate({ displayName: e.target.value })}
            size="sm"
          />
        </div>
        <div className="prop-row">
          <Select
            id="formula-y-axis"
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
            id="formula-visible"
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
        <div className="prop-section__title">Formula</div>
        <p style={{ fontSize: 11, color: 'var(--cds-text-helper)', marginBottom: 8 }}>
          Combine curves with <code style={{ color: 'var(--cds-link-primary)' }}>{'{x1}'}</code>
          -style variables, e.g.{' '}
          <code style={{ color: 'var(--cds-link-primary)' }}>{'{x1} + {x2}'}</code>. Supports
          arithmetic and math functions (<code>mean</code>, <code>ln</code>, <code>abs</code>,{' '}
          <code>sqrt</code>, …).
        </p>
        <textarea
          className="prop-code-area"
          placeholder="{x1} + {x2}"
          rows={3}
          style={{ width: '100%' }}
          value={expression}
          onChange={(e) => onUpdate({ expression: e.target.value })}
          spellCheck={false}
        />
        {hasExpr && validation && !validation.valid && validation.errors.length > 0 && (
          <div style={{ fontSize: 11, color: 'var(--cds-text-error)', marginTop: 6 }}>
            {validation.errors.join('; ')}
          </div>
        )}
        {hasExpr && validation && validation.valid && unbound.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--cds-support-success)', marginTop: 6 }}>
            Valid
          </div>
        )}
      </div>

      <div className="prop-divider" />

      <div className="prop-section">
        <div className="prop-section__title">Variables</div>
        {vars.length === 0 ? (
          <p style={{ fontSize: 11, color: 'var(--cds-text-helper)' }}>
            Add a <code style={{ color: 'var(--cds-link-primary)' }}>{'{var}'}</code> to the formula
            to bind it to a curve.
          </p>
        ) : bindableTraces.length === 0 ? (
          <p style={{ fontSize: 11, color: 'var(--cds-text-helper)' }}>
            No PV curves on this plot to reference. Add a PV trace first.
          </p>
        ) : (
          vars.map((v) => (
            <div className="prop-row" key={v}>
              <Select
                id={`formula-bind-${v}`}
                labelText={`{${v}}`}
                value={bindings[v] ?? ''}
                onChange={(e) => onUpdate({ bindings: { ...bindings, [v]: e.target.value } })}
                size="sm"
                invalid={!bindings[v]}
                invalidText="Unbound variable"
              >
                <SelectItem value="" text="— select curve —" />
                {bindableTraces.map((bt) => (
                  <SelectItem key={bt.id} value={bt.id} text={bt.displayName || bt.pvName} />
                ))}
              </Select>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TraceGeneralTab({
  trace,
  plotTraces,
  axes,
  archiveResult,
  liveResult,
  plotArchiver,
  onUpdate,
  onSelectPv,
  onInspect,
  onCreateFormula,
}: {
  trace: PVTrace;
  plotTraces: PVTrace[];
  axes: Axis[];
  archiveResult: ArchiveSeriesResult | undefined;
  liveResult: LiveSeriesResult | undefined;
  plotArchiver: string | undefined;
  onUpdate: (u: Partial<PVTrace>) => void;
  onSelectPv: (pv: string) => void;
  onInspect: () => void;
  onCreateFormula: () => void;
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
    archiveStatusLabel =
      archiveResult.error?.code === 'pv_not_found_in_archiver'
        ? 'Not in archiver'
        : (archiveResult.error?.code ?? 'Error');
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
                // displayName is left alone: while it's blank the label falls
                // back to the PV name (traceLabel), and a user-set name wins.
                onUpdate({ pvName: pv });
                // Auto-assign only when the PV actually changed. Carbon fires
                // onChange on a bare Enter too, and re-running the assign would
                // revert a manual axis override the user made after selecting.
                if (pv !== trace.pvName) onSelectPv(pv);
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
            placeholder={traceLabel({ ...trace, displayName: '' }, plotTraces)}
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
        <div className="prop-section__title">Derived</div>
        <p style={{ fontSize: 11, color: 'var(--cds-text-helper)', marginBottom: 10 }}>
          Create a formula curve seeded with this curve as <code>{'{x1}'}</code>, then edit the
          expression (e.g. <code>{'{x1} * 1.5 + 10'}</code>).
        </p>
        <Button
          kind="tertiary"
          size="sm"
          onClick={onCreateFormula}
          disabled={!trace.pvName}
          style={{ width: '100%', maxWidth: 'none' }}
        >
          Create formula from this curve
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

function TraceCodeTab({ trace, label }: { trace: PVTrace; label: string }) {
  const config = `{
  name: '${label}',
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

// Horizontal strip previewing a palette's colors, shown under the picker.
function PaletteSwatches({ colors }: { colors: string[] }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 1,
        marginTop: 6,
        borderRadius: 2,
        overflow: 'hidden',
        border: '1px solid var(--cds-border-subtle)',
      }}
    >
      {colors.map((c, i) => (
        <div key={`${c}-${i}`} title={c} style={{ flex: 1, height: 14, backgroundColor: c }} />
      ))}
    </div>
  );
}

// Palette dropdown + live swatch preview. Carbon's Select can't render a color
// swatch per option, so the preview strip sits beneath it.
function PalettePicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (paletteId: string) => void;
}) {
  return (
    <>
      <Select
        id={id}
        labelText="Palette"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        size="sm"
      >
        {PALETTES.map((p) => (
          <SelectItem key={p.id} value={p.id} text={p.label} />
        ))}
      </Select>
      <PaletteSwatches colors={getPalette(value).colors} />
    </>
  );
}

function AxisGeneralTab({
  axis,
  plotId,
  getAxisRange,
  onUpdate,
  onApplyPalette,
}: {
  axis: Axis;
  plotId: string;
  getAxisRange: (axisId: string) => [number, number] | undefined;
  onUpdate: (u: Partial<Axis>) => void;
  onApplyPalette: (paletteId: string, scope: { plotId: string; axisId?: string }) => void;
}) {
  // Which palette the "Apply to this axis" action uses. Seeded from the global
  // default; changing it here is local to this apply action (it does not change
  // the default new traces get).
  const { paletteId: defaultPaletteId } = usePaletteId();
  const [palette, setPalette] = useState(defaultPaletteId);
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

      <div className="prop-divider" />

      <div className="prop-section">
        <div className="prop-section__title">Color Palette</div>
        <div className="prop-row">
          <PalettePicker id="axis-palette" value={palette} onChange={setPalette} />
        </div>
        <Button
          kind="tertiary"
          size="sm"
          onClick={() => onApplyPalette(palette, { plotId, axisId: axis.id })}
        >
          Apply to this axis
        </Button>
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

/**
 * A Carbon Slider whose `value` comes from the store that its onChange writes.
 *
 * Carbon's Slider copies `value` into its own state in one effect and reports
 * that state through onChange in another. Passing each store update straight
 * back as `value` can loop: when a keypress renders in the same batch as the
 * store update for the previous key, Carbon reports the keypress while also
 * resetting itself to the older store value, then reports that value while
 * resetting to the newer one, and so on, swapping two steps forever.
 *
 * So `value` only reaches Carbon when it changes from outside (another plot,
 * a loaded file): that remounts the slider at the new value. When the store
 * just catches up with what the slider reported, Carbon's `value` stays put.
 * This relies on onChange writing the store in the same update; a deferred
 * write (a transition, a debounce) would look like an outside change.
 *
 * Single handle only.
 */
function StoreSlider({
  value,
  min,
  max,
  onChange,
  ...props
}: Omit<SliderProps, 'unstable_valueUpper'>) {
  // `seed` is what Carbon was mounted with; `seen` is the latest value either
  // the store or the slider has reported. Carbon also resets itself to its
  // `value` prop when min or max change, so those remount it too, at the
  // current value rather than the stale seed.
  const [held, setHeld] = useState({ seed: value, seen: value, min, max, key: 0 });
  // Object.is so a NaN from a malformed workspace file doesn't reseed forever.
  if (!Object.is(value, held.seen) || min !== held.min || max !== held.max) {
    setHeld({ seed: value, seen: value, min, max, key: held.key + 1 });
  }
  return (
    <Slider
      key={held.key}
      {...props}
      min={min}
      max={max}
      value={held.seed}
      onChange={(data) => {
        setHeld((prev) => ({ ...prev, seen: data.value }));
        onChange?.(data);
      }}
    />
  );
}

function PlotGeneralTab({
  plot,
  nowMs,
  onUpdate,
  onApplyPalette,
}: {
  plot: Plot;
  nowMs: number;
  onUpdate: (u: Partial<Plot>) => void;
  onApplyPalette: (paletteId: string, scope: { plotId: string; axisId?: string }) => void;
}) {
  // The Plot-tab picker controls the global default palette (persisted), so new
  // traces follow it; the button additionally recolors existing traces now.
  const { paletteId, setPaletteId } = usePaletteId();
  // Free-text span field (e.g. "30s", "90m", "1.5h"). Seeded from the relative range
  // minus its leading "-"; commits a normalized "-<span>" range on Enter/blur.
  const isCustom = plot.xAxis.timeRange === 'custom';
  const spanFromRange = isCustom ? '' : plot.xAxis.timeRange.replace(/^-/, '');
  const [spanText, setSpanText] = useState(spanFromRange);
  const [spanError, setSpanError] = useState<string | undefined>(undefined);
  // Re-sync when timeRange changes externally (workspace load, undo, etc.).
  // Without this, spanText keeps its mount-time value, and a focus/blur without
  // typing fires commitSpan and overwrites the loaded range with stale text. We
  // derive during render (React's recommended pattern over an effect) and track
  // the range we last synced from so genuine typing between renders isn't lost.
  const [syncedFrom, setSyncedFrom] = useState(plot.xAxis.timeRange);
  if (plot.xAxis.timeRange !== syncedFrom) {
    setSyncedFrom(plot.xAxis.timeRange);
    setSpanText(spanFromRange);
    setSpanError(undefined);
  }
  const commitSpan = () => {
    const trimmed = spanText.trim();
    if (trimmed === '') {
      setSpanError(undefined);
      return;
    }
    if (parseSpanMs(trimmed) === null) {
      setSpanError('Use a number plus s, m, h, d, w, or M (e.g. 30s, 90m, 1.5h, 2w).');
      return;
    }
    setSpanError(undefined);
    onUpdate({ xAxis: { ...plot.xAxis, timeRange: `-${trimmed}` } });
  };
  const customError = isCustom ? resolveTimeWindow(plot.xAxis, nowMs).error : undefined;
  // A relative range that isn't one of the dropdown presets (e.g. "-30m") needs
  // its own option, or the native Select would mislead by showing the first item.
  const PRESETS = [
    '-30s',
    '-1m',
    '-5m',
    '-15m',
    '-1h',
    '-4h',
    '-1d',
    '-2d',
    '-1w',
    '-1M',
    'custom',
  ];
  const isPresetRange = PRESETS.includes(plot.xAxis.timeRange);
  // A short span caps the refresh interval (see refreshIntervalMs); say so,
  // since the field still shows the interval the user set.
  const refreshMs = refreshIntervalMs(plot);
  const refreshCapped = refreshMs < clampInterval(plot.refreshIntervalS) * 1000;
  const refreshHelp = refreshCapped
    ? `Archive and formula data refresh every ${+(refreshMs / 1000).toFixed(1)} s at this span (at most a sixth of it), so the scrolling axis doesn't outrun them.`
    : 'How often archive and formula data refresh. The axis scrolls continuously.';
  const gridOpacityPct = Math.round(plot.gridOpacity * 100);
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
            id="show-legend"
            labelText="Show Legend"
            labelA="Off"
            labelB="On"
            toggled={plot.showLegend}
            onToggle={(checked) => onUpdate({ showLegend: checked })}
            size="sm"
          />
        </div>
        <div className="prop-row prop-row--inline">
          <Toggle
            id="show-x-gridlines"
            labelText="Show X Gridlines"
            labelA="Off"
            labelB="On"
            toggled={plot.showXGridlines}
            onToggle={(checked) => onUpdate({ showXGridlines: checked })}
            size="sm"
          />
        </div>
        <div className="prop-row prop-row--inline">
          <Toggle
            id="show-y-gridlines"
            labelText="Show Y Gridlines"
            labelA="Off"
            labelB="On"
            toggled={plot.showYGridlines}
            onToggle={(checked) => onUpdate({ showYGridlines: checked })}
            size="sm"
          />
        </div>
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
        <div className="prop-row">
          {/* No number input: it doesn't fit beside the track at the default
              panel width, so the value goes in the label instead. */}
          <StoreSlider
            id="grid-opacity"
            labelText={`Gridline Opacity (${gridOpacityPct}%)`}
            hideTextInput
            min={0}
            max={100}
            step={5}
            value={gridOpacityPct}
            onChange={({ value }) => onUpdate({ gridOpacity: value / 100 })}
          />
        </div>
        <div className="prop-row">
          <NumberInput
            id="tick-font-size"
            label="Tick Font Size (px)"
            min={6}
            max={24}
            step={1}
            value={plot.tickFontSize}
            onChange={(_e, { value }) => {
              const n = typeof value === 'number' ? value : parseInt(String(value), 10);
              if (!Number.isNaN(n)) onUpdate({ tickFontSize: n });
            }}
            size="sm"
          />
        </div>
        <div className="prop-row prop-row--inline">
          <Toggle
            id="show-crosshair"
            labelText="Show Crosshair"
            labelA="Off"
            labelB="On"
            toggled={plot.showCrosshair}
            onToggle={(checked) => onUpdate({ showCrosshair: checked })}
            size="sm"
          />
        </div>
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
        <div className="prop-section__title">Color Palette</div>
        <div className="prop-row">
          <PalettePicker id="plot-palette" value={paletteId} onChange={setPaletteId} />
        </div>
        <p style={{ fontSize: 11, color: 'var(--cds-text-helper)', margin: '0 0 8px' }}>
          New traces are colored from this palette.
        </p>
        <Button
          kind="tertiary"
          size="sm"
          onClick={() => onApplyPalette(paletteId, { plotId: plot.id })}
        >
          Apply to all traces
        </Button>
      </div>

      <div className="prop-divider" />

      <div className="prop-section">
        <div className="prop-section__title">X-Axis (Time)</div>
        <div className="prop-row">
          <Select
            id="time-range"
            labelText="Time Range"
            value={plot.xAxis.timeRange}
            onChange={(e) => {
              const next = e.target.value;
              if (next !== 'custom') setSpanText(next.replace(/^-/, ''));
              setSpanError(undefined);
              onUpdate({ xAxis: { ...plot.xAxis, timeRange: next } });
            }}
            size="sm"
          >
            <SelectItem value="-30s" text="Last 30 Seconds" />
            <SelectItem value="-1m" text="Last 1 Minute" />
            <SelectItem value="-5m" text="Last 5 Minutes" />
            <SelectItem value="-15m" text="Last 15 Minutes" />
            <SelectItem value="-1h" text="Last 1 Hour" />
            <SelectItem value="-4h" text="Last 4 Hours" />
            <SelectItem value="-1d" text="Last 1 Day" />
            <SelectItem value="-2d" text="Last 2 Days" />
            <SelectItem value="-1w" text="Last 1 Week" />
            <SelectItem value="-1M" text="Last 1 Month" />
            {!isPresetRange && (
              <SelectItem
                value={plot.xAxis.timeRange}
                text={`Last ${plot.xAxis.timeRange.replace(/^-/, '')}`}
              />
            )}
            <SelectItem value="custom" text="Custom Range..." />
          </Select>
        </div>
        {!isCustom && (
          <>
            <div className="prop-row">
              <TextInput
                id="time-span"
                labelText="Span (e.g. 30s, 90m, 1.5h, 2w)"
                value={spanText}
                invalid={!!spanError}
                invalidText={spanError}
                onChange={(e) => setSpanText(e.target.value)}
                onBlur={commitSpan}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitSpan();
                }}
                size="sm"
              />
            </div>
            <div className="prop-row">
              <Toggle
                id="autoscroll"
                labelText="Autoscroll (track now)"
                labelA="Off"
                labelB="On"
                toggled={plot.autoScroll !== false}
                onToggle={(checked) => onUpdate({ autoScroll: checked })}
                size="sm"
              />
            </div>
            <div className="prop-row">
              <NumberInput
                id="refresh-interval"
                label="Refresh interval (s)"
                helperText={refreshHelp}
                min={MIN_REFRESH_S}
                max={MAX_REFRESH_S}
                step={1}
                value={plot.refreshIntervalS ?? DEFAULT_REFRESH_INTERVAL_S}
                disabled={plot.autoScroll === false}
                onChange={(_e, { value }) => {
                  if (value === '' || value === undefined) return;
                  onUpdate({ refreshIntervalS: clampInterval(Number(value)) });
                }}
                size="sm"
              />
            </div>
          </>
        )}
        {isCustom && (
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
                labelText="To (blank = now)"
                type="datetime-local"
                value={plot.xAxis.timeTo ?? ''}
                onChange={(e) => onUpdate({ xAxis: { ...plot.xAxis, timeTo: e.target.value } })}
                size="sm"
              />
            </div>
            {customError && (
              <div
                className="prop-row"
                style={{ fontSize: 12, color: 'var(--cds-text-error, #da1e28)' }}
              >
                {customError}
              </div>
            )}
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

  // Grid (X = vertical time lines; Y = horizontal lines from the primary axis)
  splitLine: {
    showX: ${plot.showXGridlines},
    showY: ${plot.showYGridlines},
    lineStyle: { type: '${plot.gridStyle}', opacity: ${plot.gridOpacity} }
  },

  // Legend
  legend: { show: ${plot.showLegend} },

  // Crosshair
  axisPointer: { type: '${plot.showCrosshair ? 'cross' : 'none'}' },

  // Axis tick labels
  axisLabel: { fontSize: ${plot.tickFontSize} },

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
