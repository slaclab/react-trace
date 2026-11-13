import type { PngSource } from './exportPlotImage';

// Live chart PNG sources per plot, for capturing plots to post to the e-log.
//
// A plot can be mounted more than once at the same time: its in-window tab or
// grid cell plus the fullscreen overlay copy. Every live registration is kept,
// so unmounting one copy falls back to a copy that is still mounted. While a
// fullscreen copy is mounted it wins, matching print and PNG export, which
// capture the popped-out copy the user is looking at. Otherwise the most
// recently registered copy wins.
export interface ChartRegistry {
  register(plotId: string, source: PngSource, fullscreen?: boolean): void;
  // Removes this exact source (each mount registers its own object), leaving
  // any other copy of the plot registered.
  unregister(plotId: string, source: PngSource): void;
  get(plotId: string): PngSource | undefined;
}

interface Entry {
  source: PngSource;
  fullscreen: boolean;
}

export function createChartRegistry(): ChartRegistry {
  const byPlot = new Map<string, Entry[]>();
  return {
    register(plotId, source, fullscreen = false) {
      const entries = byPlot.get(plotId);
      if (entries) entries.push({ source, fullscreen });
      else byPlot.set(plotId, [{ source, fullscreen }]);
    },
    unregister(plotId, source) {
      const entries = byPlot.get(plotId);
      if (!entries) return;
      const i = entries.findIndex((e) => e.source === source);
      if (i !== -1) entries.splice(i, 1);
      if (entries.length === 0) byPlot.delete(plotId);
    },
    get(plotId) {
      const entries = byPlot.get(plotId);
      if (!entries) return undefined;
      const fullscreen = entries.findLast((e) => e.fullscreen);
      return (fullscreen ?? entries[entries.length - 1]).source;
    },
  };
}
