// Trace's right-click writers (workbench/contextMenu): what the
// shared menus need from this tool.
//
//   Signal (a curve's row or legend entry): Copy value at cursor (the curve's
//   sample at the plot cursor's last time inside the plot, else its latest),
//   Open in, Correlate against <the plot's other PV>, PV info. Inspect data,
//   Create formula, Move to axis, Hide and Remove come from the curve's own
//   card fields.
//   Point: the reading under the pointer, Reset zoom, Copy plot as image and
//   Copy link (built by the plot, `tracePointMenu`).
//
// A formula curve holds no PV and opens no menu.
import { createContext } from 'react';
import { toDatetimeLocal, type TimeWindowNs } from '../../api/time';
import { capturePlotPng } from '../../capturePlot';
import { plotConfigOf } from '../../embed/plotConfig';
import { serializeTraceQuery } from '../../embed/query';
import { traceLineData, type LinePoint } from '../../components/traceGaps';
import type { ArchiveSeriesResult } from '../../hooks/useArchiveSeries';
import type { FormulaSeriesResult } from '../../hooks/useFormulaSeries';
import type { LiveSeriesResult } from '../../hooks/useLiveSeries';
import type { Axis, Plot } from '../../types';
import type { PlotPoint, PointMenu } from '../../annotations/host/useDrawingHost';
import type {
  ContextMenuWriters,
  InfoRow,
  MenuSignal,
  Offer,
} from '../../workbench/contextMenu/registry';
import {
  clockText,
  numberText,
  openCorrelation,
  openInChoices,
  pngBlob,
  pvInfoRows,
  readingNumber,
  viewLinkFor,
} from '../contextMenu';
import type { TraceDotState } from './dots';
import { curveOf, plotHoldingCurve } from './schema/curve';

/** What Trace's writers read. */
export interface TraceMenuInput {
  state: TraceDotState;
  archiveResultsByPlot: ReadonlyMap<string, ReadonlyMap<string, ArchiveSeriesResult>>;
  liveResultsByPlot: ReadonlyMap<string, ReadonlyMap<string, LiveSeriesResult>>;
  formulaResultsByPlot: ReadonlyMap<string, ReadonlyMap<string, FormulaSeriesResult>>;
  /** The plot cursor's last time inside the plot (ms), or undefined. */
  cursorOf(plotId: string): number | undefined;
}

/** Where a plot records its cursor's time (ms) while the pointer is inside it; null outside the app. */
export const TraceCursorContext = createContext<((plotId: string, t: number) => void) | null>(null);

/** The curve's PV signal; a formula curve or an empty PV is none. */
export function traceSignalOf(state: TraceDotState, id: string): MenuSignal | null {
  const trace = curveOf(state, id);
  if (!trace || trace.kind === 'formula' || trace.pvName.trim() === '') return null;
  return { id, pv: trace.pvName };
}

/** The sample at or before `t` (the step the plot draws), else the latest; null when none. */
export function sampleAt(points: readonly LinePoint[], t: number | undefined): LinePoint | null {
  let found: LinePoint | null = null;
  for (const p of points) {
    if (p[1] === null) continue;
    if (t !== undefined && p[0] > t) break;
    found = p;
  }
  return found;
}

function dateTime(ms: number): string {
  return toDatetimeLocal(ms).replace('T', ' ');
}

function axisOf(plot: Plot, axisId: string): Axis | undefined {
  return plot.axes.find((a) => a.id === axisId);
}

/** The writers Trace registers with the menu host. */
export function traceMenuWriters(input: TraceMenuInput): ContextMenuWriters {
  const { state } = input;
  const holding = (s: MenuSignal) => plotHoldingCurve(state, s.id);
  return {
    signalOf: (id) => traceSignalOf(state, id),
    copyValue: (s) => {
      const plot = holding(s);
      const trace = curveOf(state, s.id);
      if (!plot || !trace) return null;
      const data = traceLineData(
        trace,
        input.archiveResultsByPlot.get(plot.id)?.get(trace.id),
        input.liveResultsByPlot.get(plot.id)?.get(trace.id),
        input.formulaResultsByPlot.get(plot.id)?.get(trace.id)
      );
      const cursor = input.cursorOf(plot.id);
      const sample = data ? sampleAt(data, cursor) : null;
      if (sample === null || sample[1] === null) return null;
      const units = axisOf(plot, trace.axisId)?.units;
      const value = numberText(sample[1]);
      return {
        label: cursor === undefined ? 'Copy latest value' : 'Copy value at cursor',
        text: value,
        what: `${s.pv} = ${value}${units ? ` ${units}` : ''} at ${clockText(sample[0])}`,
      };
    },
    openIn: (s) => openInChoices('trace', s.pv, { range: holding(s)?.xAxis.timeRange }),
    correlateAgainst: (s): Offer | null => {
      const plot = holding(s);
      const other = plot?.traces.find(
        (t) => t.id !== s.id && t.kind !== 'formula' && t.pvName.trim() !== '' && t.pvName !== s.pv
      );
      if (!plot || !other) return null;
      return {
        label: `Correlate against ${other.pvName}`,
        run: () => openCorrelation(other.pvName, s.pv, { range: plot.xAxis.timeRange }),
      };
    },
    pvInfo: (s) => {
      const plot = holding(s);
      const trace = curveOf(state, s.id);
      const known: InfoRow[] = [];
      if (plot && trace) {
        const axis = axisOf(plot, trace.axisId);
        if (axis) known.push({ label: 'Axis', value: axis.name });
        if (axis?.units) known.push({ label: 'Units', value: axis.units });
        const live = input.liveResultsByPlot.get(plot.id)?.get(trace.id);
        if (trace.useLive && live) {
          known.push({ label: 'Live', value: live.connected ? 'connected' : live.status });
        }
      }
      return pvInfoRows(s.pv, known, plot?.archiver);
    },
  };
}

/** What a plot's point menu needs beyond the reading. */
export interface TracePointInput {
  plot: Plot;
  /** The shown window, written into the link as a fixed range. */
  window?: TimeWindowNs;
  colorMode: 'light' | 'dark';
  drawingsHidden: boolean;
  /** Back to the plot's configured range and auto-scaled axes. */
  resetView(): void;
}

/** The link's range: the shown window when it differs from the configured one, else the range. */
function linkXAxis(plot: Plot, w: TimeWindowNs | undefined): Plot['xAxis'] {
  if (w === undefined || plot.xAxis.timeRange === 'custom') return plot.xAxis;
  return {
    ...plot.xAxis,
    timeRange: 'custom',
    timeFrom: toDatetimeLocal(Math.floor(w.fromNs / 1e6)),
    timeTo: toDatetimeLocal(Math.ceil(w.toNs / 1e6)),
  };
}

/** The point menu of one plot: the curve under the pointer, its reading and the plot's writers. */
export function tracePointMenu(p: PlotPoint, input: TracePointInput): PointMenu {
  const { plot } = input;
  const writers: ContextMenuWriters = {
    resetZoom: () => ({ run: input.resetView }),
    copyImage: () => () =>
      pngBlob(capturePlotPng(plot, input.colorMode, false, input.drawingsHidden)),
    viewLink: () =>
      viewLinkFor(
        'trace',
        serializeTraceQuery(plot.traces, linkXAxis(plot, input.window), plotConfigOf(plot))
      ),
  };
  const hit = p.hit;
  const trace = hit ? plot.traces.find((t) => t.id === hit.traceId) : undefined;
  if (!hit || !trace) {
    if (!Number.isFinite(p.t)) return { signals: [], writers };
    const header = clockText(p.t);
    return { signals: [], reading: { header, text: dateTime(p.t) }, writers };
  }
  const units = axisOf(plot, hit.axisId)?.units;
  const value = `${readingNumber(hit.v)}${units ? ` ${units}` : ''}`;
  const name = trace.kind === 'formula' ? trace.displayName || trace.pvName : trace.pvName;
  const signals =
    trace.kind === 'formula' || trace.pvName.trim() === ''
      ? []
      : [{ id: trace.id, pv: trace.pvName }];
  return {
    signals,
    reading: {
      header: `${clockText(hit.t)} · ${value} · ${name}`,
      text: `${name}\t${dateTime(hit.t)}\t${value}`,
    },
    writers,
  };
}
