// Correlation's right-click writers (workbench/contextMenu): what the shared
// menus need from this tool.
//
//   Signal (an X, Y or Trigger row, or a Y's legend entry): Copy fit (a Y,
//   while the fit is on), Use as X (a Y; swaps with the X), Open in, PV info.
//   Point: the reading under the pointer, Copy fit, Reset zoom, Copy plot as
//   image, Copy link.
//
// Hide, Remove and the Add … here entries come from the workbench and the
// drawing host.
import { movePv, moveRefusal } from './edit';
import { autoScale } from './gestures';
import { serializeCorrelationQuery, type CorrelationState } from './query';
import { formatSig } from '../../statistics/evaluate';
import { fitStats, slopeUnits, type FrameLike } from './stats';
import type { PlotPoint, PointMenu } from '../../annotations/host/useDrawingHost';
import type { ContextMenuWriters, InfoRow, MenuSignal } from '../../workbench/contextMenu/registry';
import { openInChoices, pngBlob, pvInfoRows, readingNumber, viewLinkFor } from '../contextMenu';
import { correlationItemId, parseCorrelationItemId, ROLE_LABELS } from './schema';
import { chartPngSource, type ChartImage } from '../shared/chartImage';
import type { PvModel } from '../shared/pvTracker';

export interface CorrelationMenuInput {
  state: CorrelationState;
  /** The frame on screen; null while there is none. */
  shown: FrameLike | null;
  pvs: PvModel;
  unitsOf(pv: string): string;
  update(fn: (s: CorrelationState) => CorrelationState): void;
  /** The mounted chart, for the image. */
  chart(): ChartImage | null;
  background: string;
  drawingsHidden: boolean;
}

const PIXEL_RATIO = 2;

/** The signal a row id names. */
export function correlationSignalOf(id: string): MenuSignal | null {
  const parsed = parseCorrelationItemId(id);
  return parsed ? { id, pv: parsed.pv } : null;
}

/** The fit of each Y in `pvs` as one line of text; null when none has a slope. */
export function fitText(input: CorrelationMenuInput, pvs: readonly string[]): string | null {
  const ro = fitStats(input.shown);
  const x = ro.x?.pv ?? input.state.x;
  const xu = input.unitsOf(x);
  const lines = ro.ys
    .filter((row) => pvs.includes(row.pv) && row.stats.slope !== null)
    .map((row) => {
      const { slope, intercept, r2, n } = row.stats;
      const yu = input.unitsOf(row.pv);
      return (
        `${row.pv} vs ${x}: slope ${formatSig(slope, slopeUnits(yu, xu))}, ` +
        `offset ${formatSig(intercept, yu)}, R² ${formatSig(r2)}, n ${n}`
      );
    });
  return lines.length === 0 ? null : lines.join('\n');
}

function knownRows(input: CorrelationMenuInput, s: MenuSignal): InfoRow[] {
  const role = parseCorrelationItemId(s.id)?.role;
  if (role === undefined) return [];
  const rows: InfoRow[] = [{ label: 'Plotted as', value: ROLE_LABELS[role] }];
  const info =
    role === 'x'
      ? input.pvs.x
      : role === 'trig'
        ? input.pvs.trig
        : input.pvs.ys.find((i) => i.pv === s.pv);
  if (info?.units) rows.push({ label: 'Units', value: info.units });
  if (info) rows.push({ label: 'Status', value: info.message ?? info.status });
  return rows;
}

/** The writers Correlation registers with the menu host. */
export function correlationMenuWriters(input: CorrelationMenuInput): ContextMenuWriters {
  const { state, update } = input;
  const range = `-${state.lookback}`;
  return {
    signalOf: correlationSignalOf,
    copyFit: (s) => {
      if (!state.fit) return null;
      const ys = s !== null && parseCorrelationItemId(s.id)?.role === 'y' ? [s.pv] : state.ys;
      const text = fitText(input, ys);
      return text === null
        ? null
        : { text, what: ys.length === 1 ? `the fit of ${ys[0]}` : 'the fits' };
    },
    useAsX: (s) => {
      if (parseCorrelationItemId(s.id)?.role !== 'y') return null;
      return {
        label: state.x === '' ? 'Use as X' : `Use as X (swap with ${state.x})`,
        disabled: moveRefusal(state, 'y', s.pv, 'x') ?? false,
        run: () => update((st) => movePv(st, 'y', s.pv, 'x').state),
      };
    },
    openIn: (s) => openInChoices('correlation', s.pv, { range, lookback: state.lookback }),
    pvInfo: (s) => pvInfoRows(s.pv, knownRows(input, s)),
    resetZoom: () => ({
      run: () =>
        update((st) => ({ ...st, xScale: autoScale(st.xScale), yScale: autoScale(st.yScale) })),
    }),
    copyImage: () => {
      const chart = input.chart();
      if (chart === null) return null;
      return () =>
        pngBlob(
          Promise.resolve(
            chartPngSource(chart, input.drawingsHidden).getDataURL({
              type: 'png',
              pixelRatio: PIXEL_RATIO,
              backgroundColor: input.background,
            })
          )
        );
    },
    viewLink: () => viewLinkFor('correlation', serializeCorrelationQuery(state)),
  };
}

/** The point menu: the Y under the pointer and its reading. */
export function correlationPointMenu(
  p: PlotPoint,
  state: CorrelationState,
  unitsOf: (pv: string) => string
): PointMenu {
  const xu = state.x ? unitsOf(state.x) : '';
  const unit = (u: string) => (u ? ` ${u}` : '');
  if (p.hit === null) {
    if (!Number.isFinite(p.t)) return { signals: [] };
    const header = `X ${readingNumber(p.t)}${unit(xu)} · Y ${readingNumber(p.v)}`;
    return { signals: [], reading: { header, text: header } };
  }
  const { t, v, traceId: pv } = p.hit;
  const yu = unitsOf(pv);
  const header = `X ${readingNumber(t)}${unit(xu)} · ${readingNumber(v)}${unit(yu)} · ${pv}`;
  return {
    signals: [{ id: correlationItemId('y', pv), pv }],
    reading: {
      header,
      text: `${pv}\t${state.x} ${readingNumber(t)}${unit(xu)}\t${readingNumber(v)}${unit(yu)}`,
    },
  };
}
