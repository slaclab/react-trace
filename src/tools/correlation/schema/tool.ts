// Correlation field schemas; the layout is listed in ./index.ts.
//
// The plot-level tabs: Acquisition, Axes, Display, Statistics and Code.

import { DRAG_MODE_LABEL, DRAG_MODES, isDragMode } from '../../../plot/plotToggles';
import { createElement } from 'react';
import { toolCodeFragment } from '../codeFragments';
import { apply, setMetrics } from '../edit';
import { CORRELATION_METRICS } from '../metrics';
import { CORRELATION_AXES, MAX_N, densityY } from '../query';
import { optionalPath } from '../../dotHelpers';
import { AXES, LABELS, PLOT_SECTIONS, onFlags, summary } from '../../vocabulary';
import type { FieldDef, ObjectSchema } from '../../../workbench/types';
import { LookbackControl } from '../fields/lookback';
import { statisticsFields } from '../../../statistics/fields';
import { axisFields } from './axes';
import {
  AXES_LABELS,
  VIEW_OPTIONS,
  scaleSummary,
  toggle,
  type CorrelationSchemaModel,
  type CorrelationUi,
  type S,
} from './common';

export function toolSchema<
  M extends CorrelationSchemaModel,
  U extends CorrelationUi,
>(): ObjectSchema<S, M, U> {
  const acquisitionTab = PLOT_SECTIONS.acquisition.id;
  const acquisition: FieldDef<S, M, U>[] = [
    {
      id: 'max-points',
      label: 'Max points',
      kind: 'number',
      tab: acquisitionTab,
      level: 'L1',
      min: 1,
      max: MAX_N,
      step: 1,
      get: (ctx) => ctx.state.n,
      set: (ctx, value) => {
        if (value === null) return;
        const n = Math.round(value);
        if (n >= 1 && n <= MAX_N) ctx.update((state) => apply(state, (s) => ({ ...s, n })));
      },
    },
    {
      id: 'lookback',
      label: 'Lookback',
      kind: 'custom',
      tab: acquisitionTab,
      level: 'L1',
      get: (ctx) => ctx.state.lookback,
      set: (ctx, lookback: string) =>
        ctx.update((state) => apply(state, (s) => ({ ...s, lookback }))),
      render: ({ value, onChange, id, ctx }) =>
        createElement(LookbackControl, {
          id,
          value,
          onChange,
          key: ctx.target.id,
        }),
    },
  ];

  const axes: FieldDef<S, M, U>[] = [
    {
      id: 'y-layout',
      label: 'Layout',
      kind: 'segmented',
      tab: PLOT_SECTIONS.axes.id,
      level: 'L1',
      subgroup: AXES.y,
      when: (ctx) => ctx.state.view === 'scatter',
      options: () => CORRELATION_AXES.map((value) => ({ value, label: AXES_LABELS[value] })),
      get: (ctx) => ctx.state.axes,
      set: (ctx, value) => {
        const axes = CORRELATION_AXES.find((a) => a === value);
        if (axes !== undefined) ctx.update((state) => apply(state, (s) => ({ ...s, axes })));
      },
    },
    ...axisFields<M, U>('y'),
    ...axisFields<M, U>('x'),
  ];

  // What to draw first, then the plot-wide toggles every tool shares.
  const displayTab = PLOT_SECTIONS.display.id;
  const display: FieldDef<S, M, U>[] = [
    {
      id: 'view',
      label: 'Plot as',
      kind: 'segmented',
      tab: displayTab,
      level: 'L1',
      options: () => VIEW_OPTIONS,
      get: (ctx) => ctx.state.view,
      set: (ctx, value) => {
        if (value === 'scatter' || value === 'density') {
          ctx.update((state) => apply(state, (s) => ({ ...s, view: value })));
        }
      },
    },
    {
      // '' (the first Y) is automatic, so a chosen Y is an optional value.
      id: 'density-y',
      label: 'Density Y',
      kind: 'select',
      tab: displayTab,
      level: 'L1',
      when: (ctx) => ctx.state.view === 'density',
      disabled: (ctx) => (ctx.state.ys.length === 0 ? 'Add a Y PV first.' : false),
      options: (ctx) =>
        ctx.state.ys.length === 0
          ? [{ value: '', label: 'No Y PV' }]
          : ctx.state.ys.map((pv) => ({ value: pv, label: ctx.state.labels[pv] ?? pv })),
      get: (ctx) => densityY(ctx.state),
      set: (ctx, pv) => ctx.update((state) => apply(state, (s) => ({ ...s, dy: pv }))),
      ...optionalPath<S, M, U>({
        get: (ctx) => (ctx.state.dy === '' ? undefined : ctx.state.dy),
        set: (state) => apply(state, (s) => ({ ...s, dy: '' })),
      }),
    },
    toggle<M, U>('fit-line', 'Fit line', 'fit', displayTab, 'L1'),
    toggle<M, U>('fade', 'Fade older points', 'fade', displayTab, 'L1'),
    toggle<M, U>('legend', LABELS.legend, 'legend', displayTab, 'L1'),
    toggle<M, U>('grid', LABELS.grid, 'grid', displayTab, 'L1'),
    toggle<M, U>('crosshair', LABELS.crosshair, 'crosshair', displayTab, 'L1'),
    toggle<M, U>('tooltip', LABELS.tooltip, 'tooltip', displayTab, 'L2'),
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

  // The metric list is required state (always present, no dot); Reset metrics
  // is its way back to the quiet default. The fields are the shared
  // statistics fields (src/statistics/fields.ts).
  const statistics: FieldDef<S, M, U>[] = statisticsFields<S, M, U>({
    tab: PLOT_SECTIONS.statistics.id,
    catalog: CORRELATION_METRICS,
    getShow: (ctx) => ctx.state.readout,
    setShow: (ctx, on) => ctx.update((state) => apply(state, (s) => ({ ...s, readout: on }))),
    getDistribution: (ctx) => ctx.state.dist,
    setDistribution: (ctx, on) => ctx.update((state) => apply(state, (s) => ({ ...s, dist: on }))),
    getMetrics: (ctx) => ctx.state.metrics,
    setMetrics: (ctx, metrics) => ctx.update((state) => setMetrics(state, metrics)),
    rowCount: (ctx) => ctx.state.ys.length,
  });

  const code: FieldDef<S, M, U>[] = [
    {
      id: 'correlation-code',
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
        summary: ({ state }) => summary(`${state.n} points`, state.lookback),
      },
      {
        ...PLOT_SECTIONS.axes,
        fields: axes,
        summary: ({ state }) =>
          summary(scaleSummary('Y', state.yScale), scaleSummary('X', state.xScale)),
      },
      {
        ...PLOT_SECTIONS.display,
        fields: display,
        summary: ({ state }) => {
          const flags = onFlags([
            ['legend', state.legend],
            ['grid', state.grid],
            ['crosshair', state.crosshair],
            ['tooltip', state.tooltip],
          ]);
          return summary(state.view, state.fit && 'fit', flags !== 'none' && flags);
        },
      },
      {
        ...PLOT_SECTIONS.statistics,
        fields: statistics,
        summary: ({ state }) => {
          if (!state.readout) return 'off';
          const on = state.metrics.filter((m) => m.on).length;
          return summary('on', `${on} ${on === 1 ? 'metric' : 'metrics'}`);
        },
      },
      { ...PLOT_SECTIONS.code, fields: code },
    ],
  };
}
