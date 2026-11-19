// Trace's drawing host config: the `HostConfig` SinglePlot hands
// `useDrawingHost`: the built-in catalog on the time axis, the sample magnet over the plot's curves, the
// Trace measure card, the primary (first visible) axis as a new drawing's
// owner, and nothing hidden. Its `ShedStore` never publishes (Trace links
// carry every drawing), so the status line's shed notice never shows.
//
// Built once per mount (never keyed on the frame): live data (curves,
// samples, the binned-archive facts, the axes) is read through a getter at
// call time, and `frames` is bumped when the data changes so the measure
// card re-reads it.
import type { LinePoint } from '../../../components/traceGaps';
import { BUILTIN_CATALOG } from '../../../annotations/catalog';
import type { HostConfig } from '../../../annotations/catalog/types';
import { axisUnit } from '../../../annotations/catalog/format';
import { TIME_X_AXIS } from '../../../annotations/catalog/xAxis';
import { snapToSample, type SnapTrace } from './snap';
import { createFrameStore, type BumpableFrameStore } from '../../../annotations/host/frameStore';
import { createShedStore } from '../../../annotations/host/shedStore';
import { measureCardLines, measureReadout } from './measure';
import type { Axis } from '../../../types';

/** The live inputs the Trace config reads at call time. */
export interface TraceDrawingData {
  /** Line data of the plot's visible curves. */
  traceData: ReadonlyMap<string, readonly LinePoint[]>;
  /**
   * The plot's visible curves in plot order (magnet candidates, measure's
   * adopted curve), with the colour and name the style panel offers.
   */
  traces: readonly (SnapTrace & { color?: string; name?: string })[];
  /** Curves whose archive data is binned. */
  binnedTraceIds: ReadonlySet<string>;
  /** Last archive sample time (ms) per binned curve. */
  archiveEndMs: ReadonlyMap<string, number>;
  /** The plot's visible Y axes; the first is the primary one. */
  axes: readonly Pick<Axis, 'id'>[];
}

/** Trace's config with a bumpable frame store and its live data slot. */
export interface TraceHostConfig extends HostConfig {
  frames: BumpableFrameStore;
  /** Replaces the live data the getters read (the plot calls it after each commit). */
  setData(next: TraceDrawingData): void;
}

/**
 * The Trace `HostConfig` over `initial`, replaced through `setData`; every
 * getter reads the data current at call time.
 */
export function createTraceHostConfig(initial: TraceDrawingData): TraceHostConfig {
  let current = initial;
  const read = () => current;
  return {
    setData(next) {
      current = next;
    },
    catalog: BUILTIN_CATALOG,
    xAxis: TIME_X_AXIS,
    snap: {
      snap(x, y, grid) {
        const d = read();
        return snapToSample(d.traceData, d.traces, grid, x, y);
      },
    },
    measure: {
      card(a, ctx) {
        const d = read();
        return measureCardLines(
          measureReadout(a, {
            traceData: d.traceData,
            traces: d.traces.filter((t) => t.visible !== false),
            primaryAxisId: d.axes[0]?.id,
            binnedTraceIds: d.binnedTraceIds,
            archiveEndMs: d.archiveEndMs,
          }),
          axisUnit(ctx.axis)
        );
      },
    },
    frames: createFrameStore(),
    shed: createShedStore(),
    // Today's owner-axis rule: a new drawing belongs to the primary axis.
    ownerAxisAt: () => read().axes[0]?.id ?? null,
    hiddenReason: () => null,
    swatches: () =>
      read().traces.flatMap((t) =>
        t.visible !== false && t.color ? [{ color: t.color, name: t.name ?? t.id }] : []
      ),
  };
}
