// Waveform field schemas; the layout is listed in ./index.ts.
// The tool's object schema: Acquisition, Axes, Display, Statistics and Code.

import { DRAG_MODE_LABEL, DRAG_MODES, isDragMode } from '../../../plot/plotToggles';
import { statisticsFields } from '../../../statistics/fields';
import { WAVEFORM_METRICS } from '../metrics';
import { apply } from '../edit';
import { toolCodeFragment } from '../plotOption';
import { LABELS, PLOT_SECTIONS, onFlags, summary } from '../../vocabulary';
import type { FieldDef, ObjectSchema } from '../../../workbench/types';

import {
  type S,
  type WaveformSchemaModel,
  type WaveformUi,
  axesSummary,
  statisticsSummary,
  toggle,
} from './common';
import { acquisitionFields, axesFields } from './axes';

// ------------------------------------------------------------------- tool --

export function toolSchema<M extends WaveformSchemaModel, U extends WaveformUi>(): ObjectSchema<
  S,
  M,
  U
> {
  const acquisition = acquisitionFields<M, U>();
  const axes = axesFields<M, U>();

  const displayTab = PLOT_SECTIONS.display.id;
  const display: FieldDef<S, M, U>[] = [
    toggle<M, U>('legend', LABELS.legend, 'legend', displayTab),
    toggle<M, U>('grid', LABELS.grid, 'grid', displayTab),
    toggle<M, U>('crosshair', LABELS.crosshair, 'crosshair', displayTab),
    toggle<M, U>('tooltip', LABELS.tooltip, 'tooltip', displayTab),
    {
      id: 'drag',
      label: LABELS.drag,
      kind: 'segmented',
      tab: displayTab,
      level: 'L2',
      options: () => DRAG_MODES.map((m) => ({ value: m, label: DRAG_MODE_LABEL[m] })),
      get: (ctx) => ctx.state.drag,
      set: (ctx, value) => {
        if (isDragMode(value)) ctx.update((state) => apply(state, (s) => ({ ...s, drag: value })));
      },
    },
  ];

  // The shared Statistics fields (src/statistics/fields.ts): Show
  // statistics, the Metrics list, Reset metrics.
  const stats: FieldDef<S, M, U>[] = statisticsFields<S, M, U>({
    tab: PLOT_SECTIONS.statistics.id,
    catalog: WAVEFORM_METRICS,
    getShow: (ctx) => ctx.state.stats,
    setShow: (ctx, on) => ctx.update((state) => apply(state, (s) => ({ ...s, stats: on }))),
    getDistribution: (ctx) => ctx.state.dist,
    setDistribution: (ctx, on) => ctx.update((state) => apply(state, (s) => ({ ...s, dist: on }))),
    getMetrics: (ctx) => ctx.state.metrics,
    setMetrics: (ctx, metrics) =>
      ctx.update((state) => apply(state, (s) => ({ ...s, metrics: [...metrics] }))),
    rowCount: (ctx) => ctx.state.pvs.length,
  });

  const code: FieldDef<S, M, U>[] = [
    {
      id: 'waveform-code',
      label: 'Code',
      kind: 'code',
      tab: PLOT_SECTIONS.code.id,
      level: 'L1',
      get: (ctx) => toolCodeFragment(ctx.model.fragmentInput(ctx.state)),
    },
  ];

  return {
    tabs: [
      {
        ...PLOT_SECTIONS.acquisition,
        fields: acquisition,
        summary: (ctx) => summary(`persistence ${ctx.state.persist}`, `average ${ctx.state.avg}`),
      },
      { ...PLOT_SECTIONS.axes, fields: axes, summary: (ctx) => axesSummary(ctx.state) },
      {
        ...PLOT_SECTIONS.display,
        fields: display,
        summary: (ctx) =>
          onFlags([
            ['legend', ctx.state.legend],
            ['grid', ctx.state.grid],
            ['crosshair', ctx.state.crosshair],
            ['tooltip', ctx.state.tooltip],
            ['pan', ctx.state.drag === 'pan'],
          ]),
      },
      {
        ...PLOT_SECTIONS.statistics,
        fields: stats,
        summary: (ctx) => statisticsSummary(ctx.state),
      },
      { ...PLOT_SECTIONS.code, fields: code },
    ],
  };
}
