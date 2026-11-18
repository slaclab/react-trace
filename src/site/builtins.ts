// The product's own site defaults: what a deployment gets when neither its
// `config.json` nor Canopy's site settings set a value. These are the
// shipped behaviour choices; the wire baseline (what a link or file means
// when it leaves a key out) is separate and does not follow them
// (src/site/types.ts).
import { DEFAULT_GESTURE_PREFS } from '../plot/gesturePrefs';
import { defaultMetrics } from '../statistics/model';
import { CORRELATION_METRICS } from '../tools/correlation/metrics';
import { WAVEFORM_METRICS } from '../tools/waveform/metrics';
import { BUG_REPORT_URL, DOCS_URL } from './links';
import type { PlotBehaviour, SiteDefaults } from './types';

/** `value` and everything it holds, frozen. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const docked: PlotBehaviour = { ...DEFAULT_GESTURE_PREFS, tooltip: 'docked' };

/**
 * Trace's plot behaviour, as main had it (the maintainers' C1-C7): the wheel
 * zooms time only (Alt+wheel: time and every Y axis; C2).
 */
const tracePlot: PlotBehaviour = { ...docked, wheel: 'x' };

export const BUILTIN_DEFAULTS: SiteDefaults = deepFreeze({
  header: {
    prefix: '',
    brand: false,
    bugReportUrl: BUG_REPORT_URL,
    docsUrl: DOCS_URL,
  },
  trace: {
    plot: {
      ...tracePlot,
      showCrosshair: false,
      dragMode: 'zoom',
      showLegend: true,
      showXGridlines: true,
      showYGridlines: true,
      gridStyle: 'solid',
      gridOpacity: 1,
      tickFontSize: 11,
      refreshIntervalS: 5,
      palette: undefined,
      timeRange: '-1h',
      archiver: undefined,
      showDrawingTools: true,
    },
    trace: { lineWidth: 2, lineType: 'step', showSymbol: false },
  },
  correlation: {
    plot: { ...docked },
    lookback: '1h',
    dt: 1,
    metrics: defaultMetrics(CORRELATION_METRICS),
    drawingTools: true,
  },
  waveform: {
    plot: { ...docked },
    rollS: 60,
    metrics: defaultMetrics(WAVEFORM_METRICS),
    drawingTools: true,
  },
});
