// Waveform's right-click writers (workbench/contextMenu): what the shared
// menus need from this tool.
//
//   Signal (a Live, Reference or X axis PV row, or its legend entry): Copy
//   this shot (the array), Use as reference (moves a Live PV to Reference,
//   as its Plot on would), Take snapshot as reference, Open in, PV info.
//   Point: the reading under the pointer, Copy this shot (every drawn curve),
//   Use this shot as reference, Freeze this shot (held on the plot without
//   pausing; again to release), Reset zoom, Copy plot as image, Copy link.
//
// Hide, Remove and the Add … here entries come from the workbench and the
// drawing host.
import type { WaveformModel } from './model';
import type { WaveformFrames } from './WaveformController';
import { groupOf, movePv, moveRefusal, type WaveformGroup } from './edit';
import { autoScale } from './gestures';
import { serializeWaveformQuery, type WaveformState } from './query';
import type { PlotPoint, PointMenu } from '../../annotations/host/useDrawingHost';
import type {
  ContextMenuWriters,
  CopyOffer,
  InfoRow,
  MenuSignal,
} from '../../workbench/contextMenu/registry';
import {
  arrayText,
  columnsText,
  openInChoices,
  pngBlob,
  pvInfoRows,
  readingNumber,
  viewLinkFor,
} from '../contextMenu';
import { GROUP_LABELS, parseWaveformItemId, waveformItemId } from './schema';
import { chartPngSource, type ChartImage } from '../shared/chartImage';

/** A shot held on the plot: each drawn Live curve's frame at the moment of the freeze. */
export interface HeldShot {
  time: number;
  live: Readonly<Record<string, Float64Array>>;
}

export interface WaveformMenuInput {
  state: WaveformState;
  model: WaveformModel;
  frames: WaveformFrames;
  update(fn: (s: WaveformState) => WaveformState): void;
  /** Snapshot → reference; false when no curve has a frame. */
  takeSnapshot(): boolean;
  /** Why Snapshot → reference cannot run now, or false. */
  snapshotDisabled: string | false;
  held: HeldShot | null;
  setHeld(held: HeldShot | null): void;
  /** The mounted chart, for the image. */
  chart(): ChartImage | null;
  /** The image's background. */
  background: string;
  drawingsHidden: boolean;
}

/** The PNG pixel ratio, as the export's. */
const PIXEL_RATIO = 2;

function frameOf(frames: WaveformFrames, group: WaveformGroup, pv: string): Float64Array | null {
  if (group === 'live') return frames.live[pv]?.frame ?? null;
  if (group === 'reference') return frames.reference;
  return frames.x;
}

/** The signal a row id names (a PV row; the snapshot and rolling rows hold none). */
export function waveformSignalOf(id: string): MenuSignal | null {
  const parsed = parseWaveformItemId(id);
  return parsed?.pv ? { id, pv: parsed.pv } : null;
}

function shotOffer(input: WaveformMenuInput, s: MenuSignal | null): CopyOffer | null {
  const { state, model, frames } = input;
  if (s !== null) {
    const parsed = parseWaveformItemId(s.id);
    const values = parsed?.pv ? frameOf(frames, parsed.group, parsed.pv) : null;
    if (values === null) return null;
    return {
      label: `Copy this shot (${values.length} values)`,
      text: arrayText(values),
      what: `${values.length} values of ${s.pv}`,
    };
  }
  const columns = model.live.flatMap((row) => {
    const frame = row.drawable && !row.hidden ? frames.live[row.pv]?.frame : undefined;
    return frame ? [{ name: state.styles[row.pv]?.label ?? row.pv, values: frame }] : [];
  });
  if (columns.length === 0) return null;
  const n = Math.max(...columns.map((c) => c.values.length));
  return {
    label: `Copy this shot (${n} values)`,
    text: columns.length === 1 ? arrayText(columns[0].values) : columnsText(columns),
    what: columns.length === 1 ? `${n} values of ${columns[0].name}` : `${columns.length} curves`,
  };
}

function knownRows(input: WaveformMenuInput, s: MenuSignal): InfoRow[] {
  const parsed = parseWaveformItemId(s.id);
  if (!parsed?.pv) return [];
  const rows: InfoRow[] = [{ label: 'Plotted as', value: GROUP_LABELS[parsed.group] }];
  const live = input.model.live.find((r) => r.pv === parsed.pv);
  if (live) {
    if (live.egu) rows.push({ label: 'Units', value: live.egu });
    if (live.length !== null) rows.push({ label: 'Elements', value: String(live.length) });
    rows.push({ label: 'Status', value: live.message ?? live.chip ?? live.status });
  } else {
    const frame = frameOf(input.frames, parsed.group, parsed.pv);
    if (frame) rows.push({ label: 'Elements', value: String(frame.length) });
  }
  return rows;
}

/** The writers Waveform registers with the menu host. */
export function waveformMenuWriters(input: WaveformMenuInput): ContextMenuWriters {
  const { state, frames, update } = input;
  return {
    signalOf: waveformSignalOf,
    copyShot: (s) => shotOffer(input, s),
    useAsReference: (s) => {
      if (groupOf(state, s.pv) !== 'live') return null;
      return {
        disabled: moveRefusal(state, s.pv, 'reference') ?? false,
        run: () => update((st) => movePv(st, s.pv, 'reference').state),
      };
    },
    snapshotReference: () => ({
      disabled: input.snapshotDisabled,
      run: () => void input.takeSnapshot(),
    }),
    freezeShot: () => {
      if (input.held !== null)
        return { label: 'Release frozen shot', run: () => input.setHeld(null) };
      const live: Record<string, Float64Array> = {};
      for (const row of input.model.live) {
        const frame = row.drawable ? frames.live[row.pv]?.frame : undefined;
        if (frame) live[row.pv] = Float64Array.from(frame);
      }
      const empty = Object.keys(live).length === 0;
      return {
        disabled: empty ? 'No live curve has data yet' : false,
        run: () => input.setHeld({ time: frames.time ?? Date.now(), live }),
      };
    },
    openIn: (s) => openInChoices('waveform', s.pv),
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
    viewLink: () => viewLinkFor('waveform', serializeWaveformQuery(state)),
  };
}

/** The point menu: the curve under the pointer and its reading. */
export function waveformPointMenu(
  p: PlotPoint,
  state: WaveformState,
  model: WaveformModel
): PointMenu {
  const xName = model.xAxis.label === 'Element' ? 'element' : model.xAxis.label;
  const unit = model.unit ? ` ${model.unit}` : '';
  if (p.hit === null) {
    if (!Number.isFinite(p.t)) return { signals: [] };
    const x = model.xAxis.mode === 'index' ? String(Math.round(p.t)) : readingNumber(p.t);
    const header = `${xName} ${x} · ${readingNumber(p.v)}${unit}`;
    return { signals: [], reading: { header, text: header } };
  }
  const { t, v, traceId: pv } = p.hit;
  const group = groupOf(state, pv) ?? 'live';
  const x = model.xAxis.mode === 'index' ? String(Math.round(t)) : readingNumber(t);
  const header = `${xName} ${x} · ${readingNumber(v)}${unit} · ${pv}`;
  return {
    signals: [{ id: waveformItemId(group, pv), pv }],
    reading: { header, text: `${pv}\t${xName} ${x}\t${readingNumber(v)}${unit}` },
  };
}
