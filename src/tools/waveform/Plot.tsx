// The Waveform canvas. Draws one ECharts instance from the option builder (plotOption.ts),
// the canvas state message, the health line and the statistics row.
//
// Rules:
//   - One `setOption` per publish, in merge mode. `replaceMerge: ['series', 'dataset']`
//     is passed only when the set of series ids changed since the last call
//     (a curve added or removed, persistence changed, the reference toggled),
//     so a steady stream of frames never rebuilds the series. The builder
//     omits keys rather than resetting them, so when a key the last option
//     carried is gone (y range back to auto, band to dashed, sampling off) the
//     option is set with notMerge instead. Animation is off (the builder sets
//     it on the option and on every series).
//   - The canvas state comes from the model, first match wins: "Add a
//     waveform PV"; the Δ message ("Δ needs a reference frame — waiting
//     for <ref>"); "No curve can be drawn — see the Waveforms list" with the
//     counts; "waiting for data". The chart stays mounted under the message so
//     the instance (and the PNG export) survive a state change.
//   - One health line for the Hare connection status; per-PV status stays
//     on the rows.
//   - Statistics (state `stats`, `metrics`): the shared panel (src/statistics)
//     docked under the chart — one row per drawn live curve over the element
//     range of the published frame (Δ applied when Δ is on), one column per
//     metric, strips on the publish clock (metrics.ts).
//   - Drawings: the host parts sit inside the stage — the
//     per-grid svgs, the rail, the note editor slot and the plot menu — with
//     the status line under it. The host config is memoized on the rendered x
//     source and Δ only; the snap (`nearestPoint` over the drawn curves) and
//     the measure card (measure.ts) read the latest publish through getters.
//     Each publish bumps the `frames` store (only the measure card listens);
//     the projection is bumped on ECharts `finished` through the gate, so a
//     publish that leaves the size, grid and extents alone re-renders no
//     drawing. A new drawing is stamped with the rendered x and Δ; while the
//     chosen X source is not drawn yet the rail stays armed but a press
//     places nothing, and the status line says why.

import { attachReadoutDrag, createReadoutDock, projectionArea } from '../../plot/readoutDock';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { init, type EChartsType } from 'echarts';
import type { HareConnectionStatus } from '@slaclab/canopy-client';
import { drawingThemeFor, type ChartDrawingTheme } from '../../annotationTheme';
import { WAVEFORM_CATALOG } from '../../annotations/catalog';
import type { HostConfig } from '../../annotations/catalog/types';
import { VALUE_X_AXIS } from '../../annotations/catalog/xAxis';
import { nearestPoint } from '../../plot/nearestPoint';
import { DrawingStatusLine } from '../../annotations/host/DrawingStatusLine';
import { DrawingLayers, DrawingRailFor } from '../../annotations/host/DrawingOverlay';
import { createFrameStore } from '../../annotations/host/frameStore';
import { createShedStore, type ShedStore } from '../../annotations/host/shedStore';
import type { PlotView } from '../../plot/plotToggles';
import {
  READ_ONLY_DOCUMENT,
  type DrawingDocument,
} from '../../annotations/host/useDrawingDocument';
import {
  type PlotPoint,
  useDrawingHost,
  useDrawingPlotMenu,
  useDrawingWrapperListeners,
  type DrawingHost,
} from '../../annotations/host/useDrawingHost';
import { useLatest } from '../../workbench/useLatest';
import { useContextMenu } from '../../workbench/contextMenu/context';
import { LegendMenu } from '../contextMenu';
import { waveformPointMenu } from './menu';
import { waveformItemId } from './schema';
import { groupOf } from './edit';
import {
  WAVEFORM_AXIS_ID,
  createWaveformProjection,
  waveformHiddenReason,
  type WaveformChartInstance,
} from './drawings';
import {
  X_SOURCE_PENDING_HINT,
  createWaveformMeasure,
  stampNewDrawings,
  waveformSnapSeries,
  type WaveformDrawingData,
  waveformSwatches,
} from './measure';
import type { WaveformModel } from './model';
import {
  WaveformPlotBuffers,
  renderedXSource,
  waveformPlotOption,
  type WaveformPlotFrames,
} from './plotOption';
import type { WaveformState } from './query';
import { WaveformHealthLine } from './HealthLine';
import { markRendered } from '../shared/renderMark';
import { useWaveformGestures } from './gestures';
import { StatisticsPanel } from '../../statistics/StatisticsPanel';
import { useStatistics } from '../../statistics/useStatistics';
import { WAVEFORM_METRICS, waveformStatFrame, waveformUnitOf } from './metrics';
import './waveform.css';

/**
 * The render benchmark mark, set on every ECharts `finished` while the page
 * URL carries `bench=1` (../shared/renderMark.ts); e2e/waveform-perf.e2e.ts
 * times frames against it.
 */
export const RENDERED_MARK = 'wf:rendered';

export interface WaveformPlotProps {
  state: WaveformState;
  model: WaveformModel;
  /** The controller's latest publish; `time` is the strips' clock. */
  frames: WaveformPlotFrames & { time?: number | null };
  /** The page's Hare connection status, for the health line. */
  hare: HareConnectionStatus;
  /** Chart colours; Trace's dark chart theme by default. */
  chartTheme?: ChartDrawingTheme;
  /** The chart's font family (the host contract), when known. */
  fontFamily?: string;
  /** Receives the ECharts instance after init and null on dispose (PNG export). */
  onChart?: (chart: EChartsType | null) => void;
  /**
   * The plot's drawing document: the app's drawings, selection, prefs and
   * Hide all. Absent, the plot shows an empty, read-only drawing layer.
   */
  drawingDocument?: DrawingDocument;
  /** Where the link's shed counts are published (the status line's notice); a private one when absent. */
  shed?: ShedStore;
  /**
   * The tool's writer (App's `update`): the strip's view toggles and the zoom
   * write through it. Absent, the strip shows no view toggles and gestures
   * write nothing. Keep its identity stable (the App memoizes the Plot).
   */
  update?: (fn: (state: WaveformState) => WaveformState) => void;
}

/** A slot for the laid-out chart the projection reads (set from events, never during render). */
function createChartSlot() {
  let current: WaveformChartInstance | null = null;
  return {
    get: () => current,
    set(next: WaveformChartInstance | null) {
      current = next;
    },
  };
}

/** The drawing status line, with the placing hint in the tool slot while placing is paused. */
const WaveformDrawingStatus = memo(function WaveformDrawingStatus({
  host,
  pendingHint,
}: {
  host: DrawingHost;
  pendingHint: string | null;
}) {
  const placing = pendingHint !== null && host.document.prefs.tool !== 'cursor';
  return (
    <DrawingStatusLine
      host={host}
      toolHint={placing ? <span data-status-pending-x="">{pendingHint}</span> : undefined}
    />
  );
});

const Layers = memo(DrawingLayers);
const Rail = memo(DrawingRailFor);

/** The series ids of an option as an order-free key. */
function seriesIdKey(option: { series?: unknown }): string {
  return seriesList(option)
    .map((s) => String(s.id))
    .sort()
    .join('\n');
}

function seriesList(option: { series?: unknown }): Record<string, unknown>[] {
  const raw = option.series;
  return (Array.isArray(raw) ? raw : raw ? [raw] : []) as Record<string, unknown>[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v);
}

// Every defined key path under `obj` (arrays are leaves: ECharts replaces them
// on merge, it never merges into them).
function addPaths(obj: Record<string, unknown>, prefix: string, out: Set<string>): void {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const path = `${prefix}.${k}`;
    out.add(path);
    if (isPlainObject(v)) addPaths(v, path, out);
  }
}

/**
 * The option's key paths, series keyed by id. The dataset is left out: its
 * source is replaced wholesale on every publish.
 */
function optionPaths(option: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(option)) {
    if (k === 'dataset' || k === 'series' || v === undefined) continue;
    out.add(k);
    if (isPlainObject(v)) addPaths(v, k, out);
  }
  for (const s of seriesList(option)) addPaths(s, `series[${String(s.id)}]`, out);
  return out;
}

interface Published {
  ids: string;
  paths: Set<string>;
}

/**
 * Merge per publish; replace the series only when their id set changed.
 * Merge mode keeps a key the new option no longer carries (a fixed y range
 * after a switch back to auto, a band's areaStyle, a curve's sampling), so
 * when any key path of the last option is gone from the next one — on a
 * component, or on a series that stays — the option is set with notMerge.
 */
function setOptionArgs(
  prev: Published | null,
  next: Published
): { replaceMerge?: string[]; notMerge?: boolean } {
  if (prev === null) return { replaceMerge: ['series', 'dataset'] };
  const kept = new Set(next.ids.split('\n'));
  for (const path of prev.paths) {
    if (next.paths.has(path)) continue;
    const series = /^series\[(.*?)\]\./.exec(path);
    if (series !== null && !kept.has(series[1])) continue;
    return { notMerge: true };
  }
  return prev.ids === next.ids ? {} : { replaceMerge: ['series', 'dataset'] };
}

function canvasCounts(counts: { live: number; hidden: number; refused: number }): string {
  const parts = [`${counts.live} ${counts.live === 1 ? 'curve' : 'curves'}`];
  if (counts.hidden > 0) parts.push(`${counts.hidden} hidden`);
  if (counts.refused > 0) parts.push(`${counts.refused} refused`);
  return parts.join(' · ');
}

export function WaveformPlot({
  state,
  model,
  frames,
  hare,
  chartTheme = drawingThemeFor('dark'),
  fontFamily,
  onChart,
  drawingDocument = READ_ONLY_DOCUMENT,
  shed: shedProp,
  update,
}: WaveformPlotProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  const chart = useRef<EChartsType | null>(null);
  const last = useRef<Published | null>(null);
  const buffers = useRef(new WaveformPlotBuffers());
  // The chart host's CSS width (0 until first measured), for the sampling rule.
  const [cssWidth, setCssWidth] = useState(0);
  const onChartRef = useRef(onChart);
  useEffect(() => {
    onChartRef.current = onChart;
  });

  // ── Drawings ──────────────────────────────────────────────────────────────

  // The chart the projection reads: set on its first `finished` (laid out),
  // cleared on dispose; until then there is nothing to project onto.
  const [laidOut] = useState(createChartSlot);
  const [projection] = useState(() => createWaveformProjection(laidOut.get));
  // The data read-out's dock; its grip is wired on the chart's element below.
  const [readoutDock] = useState(() =>
    createReadoutDock({ grid: projectionArea(projection.store) })
  );
  const [frameStore] = useState(createFrameStore);
  const [ownShed] = useState(() => createShedStore());
  const shed = shedProp ?? ownShed;

  const rendered = renderedXSource(model, frames);
  const deltaOn = model.delta.on;
  // The user chose a source the chart does not plot yet.
  const xPending = model.xAxis.mode === 'source' && rendered === 'index';
  // The latest publish, for the snap, the owner rule and the measure card
  // (read at call time, never captured); each one bumps the frame store.
  const live = useLatest<WaveformDrawingData & { pending: boolean }>({
    state,
    model,
    frames,
    pending: xPending,
  });
  useLayoutEffect(() => {
    frameStore.bump();
  }, [state, model, frames, frameStore]);

  const config = useMemo<HostConfig>(() => {
    const read = () => live.current;
    return {
      catalog: WAVEFORM_CATALOG,
      xAxis: VALUE_X_AXIS,
      snap: { snap: (x, y, grid) => nearestPoint(waveformSnapSeries(read()), grid, x, y) },
      measure: createWaveformMeasure(read),
      frames: frameStore,
      shed,
      ownerAxisAt: () => (read().pending ? null : WAVEFORM_AXIS_ID),
      hiddenReason: (a) => waveformHiddenReason(a, rendered, deltaOn),
      swatches: () => waveformSwatches(read()),
    };
  }, [live, rendered, deltaOn, frameStore, shed]);

  // New drawings carry the context they were placed in.
  const stampedDocument = useMemo<DrawingDocument>(
    () => ({
      ...drawingDocument,
      commit: (fn, label) =>
        drawingDocument.commit(
          (list) => stampNewDrawings(list, fn(list), rendered, deltaOn),
          label
        ),
    }),
    [drawingDocument, rendered, deltaOn]
  );

  const unit = model.unit;
  const axes = useMemo(
    () => [{ id: WAVEFORM_AXIS_ID, name: 'y', ...(unit ? { units: unit } : {}) }],
    [unit]
  );
  const chartTip = useCallback(() => chart.current, []);
  const drawingHost = useDrawingHost(config, stampedDocument, projection.store, {
    axes,
    theme: chartTheme,
    chart: chartTip,
  });
  useDrawingWrapperListeners(stage, drawingHost);
  const point = useCallback((p: PlotPoint) => waveformPointMenu(p, state, model), [state, model]);
  useDrawingPlotMenu(drawingHost, { point });
  // A right-click on a legend entry: that curve's signal menu.
  const menus = useContextMenu();
  const onLegend = useCallback(
    (name: string, e: MouseEvent): boolean => {
      const s = state;
      const pv = [...s.pvs, s.reference?.kind === 'pv' ? s.reference.pv : '', s.xs].find(
        (p) => p !== '' && (s.styles[p]?.label ?? p) === name
      );
      const group = pv === undefined ? null : groupOf(s, pv);
      if (menus === null || pv === undefined || group === null) return false;
      const at = { x: e.clientX, y: e.clientY, target: host.current?.ownerDocument.body };
      return menus.openSignals([waveformItemId(group, pv)], at);
    },
    [state, menus]
  );
  const legendMenu = useLatest(onLegend);
  const focusStage = useCallback(() => stage.current?.focus({ preventScroll: true }), []);
  const view = useMemo<PlotView>(
    () => ({ tooltip: state.tooltip, drag: state.drag }),
    [state.tooltip, state.drag]
  );
  const onView = useMemo(
    () => (update ? (patch: Partial<PlotView>) => update((s) => ({ ...s, ...patch })) : undefined),
    [update]
  );
  // The shared plot gestures on the stage; zooms write the state's scales.
  useWaveformGestures({
    stageRef: stage,
    chart,
    projection: projection.store,
    state,
    update,
    claimsPointer: drawingHost.claimsPointer,
  });

  useEffect(() => {
    const el = host.current;
    if (el === null) return;
    const instance = init(el);
    chart.current = instance;
    const detachReadout = attachReadoutDrag(el, readoutDock);
    last.current = null;
    laidOut.set(null);
    projection.reset();
    onChartRef.current?.(instance);
    // Every frame's layout ends in `finished`; the gate bumps the projection
    // only when the size, the grid rect or an axis extent changed.
    const onFinished = () => {
      laidOut.set(instance as unknown as WaveformChartInstance);
      projection.finished();
      markRendered(RENDERED_MARK);
    };
    const events = instance as Partial<Pick<EChartsType, 'on' | 'off'>>;
    events.on?.('finished', onFinished);
    // A right-click on a legend entry; a left-click there toggles nothing.
    const legend = new LegendMenu((name, e) => legendMenu.current(name, e));
    for (const [name, handler] of Object.entries(legend.events)) events.on?.(name, handler);
    el.addEventListener('click', legend.blockClick, true);
    const detachLegend = () => {
      el.removeEventListener('click', legend.blockClick, true);
      for (const [name, handler] of Object.entries(legend.events)) events.off?.(name, handler);
    };
    // The canvas has a fixed pixel size: follow the host box in both
    // dimensions (the stage shrinks when the statistics row or a wrapped
    // health line takes room, and on a vertical panel resize).
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      let size = { w: -1, h: -1 };
      ro = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect;
        if (rect === undefined) return;
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        if (w === size.w && h === size.h) return;
        size = { w, h };
        instance.resize();
        if (laidOut.get() !== null) projection.finished();
        setCssWidth(w);
      });
      ro.observe(el);
    }
    return () => {
      detachLegend();
      detachReadout();
      ro?.disconnect();
      events.off?.('finished', onFinished);
      onChartRef.current?.(null);
      chart.current = null;
      laidOut.set(null);
      instance.dispose();
    };
  }, [projection, laidOut, readoutDock, legendMenu]);

  useEffect(() => {
    const instance = chart.current;
    if (instance === null) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const option = waveformPlotOption({
      state,
      model,
      frames,
      // Unmeasured: draw unsampled (never as if the plot were 0 px wide,
      // which would minmax-sample every curve).
      widthPx: cssWidth > 0 ? cssWidth * dpr : Number.POSITIVE_INFINITY,
      pixelRatio: dpr,
      theme: chartTheme,
      buffers: buffers.current,
      readoutDock,
    });
    if (fontFamily) option.textStyle = { fontFamily };
    const next: Published = {
      ids: seriesIdKey(option),
      paths: optionPaths(option as Record<string, unknown>),
    };
    instance.setOption(option, setOptionArgs(last.current, next));
    last.current = next;
  }, [state, model, frames, cssWidth, chartTheme, fontFamily, readoutDock]);

  // The statistics frame follows the publish; the strips tick on its clock.
  const statFrame = useMemo(
    () => (state.stats ? waveformStatFrame(state, model, frames) : null),
    [state, model, frames]
  );
  const stats = useStatistics(WAVEFORM_METRICS, statFrame, state.metrics, frames.time ?? null);
  const unitOf = useCallback((_row: string, unit: string) => waveformUnitOf(model, unit), [model]);

  const canvas = model.canvas;

  return (
    <div className="waveform-plot stats-canvas" data-testid="waveform-plot">
      <WaveformHealthLine status={hare} />
      <div className="waveform-plot__stage stats-canvas__stage" ref={stage}>
        <div className="waveform-plot__chart" ref={host} data-testid="waveform-chart" />
        {canvas.kind !== 'ready' && (
          <div
            className="waveform-plot__message"
            data-kind={canvas.kind}
            data-testid="waveform-canvas-message"
            role="status"
          >
            <p className="waveform-plot__message-text">{canvas.message}</p>
            {canvas.kind === 'none-drawable' && (
              <p className="waveform-plot__message-counts" data-testid="waveform-canvas-counts">
                {canvasCounts(canvas.counts)}
              </p>
            )}
          </div>
        )}
        <Layers host={drawingHost} />
        <Rail host={drawingHost} focusRoot={focusStage} view={view} onView={onView} />
      </div>
      <WaveformDrawingStatus
        host={drawingHost}
        pendingHint={xPending ? X_SOURCE_PENDING_HINT : null}
      />
      <StatisticsPanel
        show={state.stats}
        catalog={WAVEFORM_METRICS}
        metrics={state.metrics}
        table={stats.table}
        strips={stats.strips}
        unitOf={unitOf}
        rowHeading="Curve"
        chartTheme={chartTheme}
        distribution={state.dist}
        frame={statFrame}
      />
    </div>
  );
}
