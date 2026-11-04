// Correlation's chart source (the counterpart of Trace's
// src/tools/trace/codeFragments.ts): the plot's chart option without its
// series, taken from `plotOption` — the same builder that feeds the chart — and
// printed through `codeFragment`, so the source can never drift from the plot.

import type { EChartsOption } from 'echarts';
import { codeFragment } from '../codeFragment';
import { plotOption, type PlotOptionInput } from './plotOption';

/** The chart source's input: exactly what the chart's `plotOption` call receives. */
export type CorrelationFragmentInput = PlotOptionInput;

/** The chart option without series. */
export function selectToolFragment(input: CorrelationFragmentInput): Omit<EChartsOption, 'series'> {
  const option: EChartsOption = { ...plotOption(input) };
  delete option.series;
  return option;
}

export function toolCodeFragment(input: CorrelationFragmentInput): string {
  return codeFragment(selectToolFragment(input));
}
