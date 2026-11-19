// Trace's chart source: the active plot's chart option without series,
// taken from `buildPlotOption` — the same builder that feeds the chart — and
// printed through `codeFragment`, so the source can never drift from the plot.

import {
  buildPlotOption,
  type PlotOption,
  type PlotOptionInput,
} from '../../components/plotOption';
import { codeFragment } from '../codeFragment';

/** The chart source's input: the plot plus its per-plot result maps (as TraceApp holds them). */
export type TraceFragmentInput = PlotOptionInput;

/** The active plot's option without series. */
export function selectPlotFragment(input: TraceFragmentInput): Omit<PlotOption, 'series'> {
  const option: Partial<PlotOption> = { ...buildPlotOption(input) };
  delete option.series;
  return option as Omit<PlotOption, 'series'>;
}

export function plotCodeFragment(input: TraceFragmentInput): string {
  return codeFragment(selectPlotFragment(input));
}
