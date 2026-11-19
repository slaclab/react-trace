// Correlation's chart source: the fragment is taken from
// `plotOption` — the builder that feeds the chart — and printed through
// `codeFragment`, so the source is the chart's own option without its series.

import { describe, expect, it } from 'vitest';
import type { TableResultDTO } from '@slaclab/canopy-client';
import { drawingThemeFor } from '../../annotationTheme';
import { codeFragment } from '../codeFragment';
import { plotOption, type PlotOptionInput } from './plotOption';
import type { FrameLike } from './stats';
import { selectToolFragment, toolCodeFragment } from './codeFragments';

const PVS = { x: 'X:PV', y1: 'Y1:PV', y2: 'Y2:PV' };

function frame(rows = 10): FrameLike {
  const tsNs = Array.from({ length: rows }, (_, i) => i * 1e9);
  const columns: Record<string, (number | null)[]> = {
    x: tsNs.map((_, i) => i + 1),
    y1: tsNs.map((_, i) => 2 * i + 1),
    y2: tsNs.map((_, i) => 3 * i - 4),
  };
  const table: TableResultDTO = { tsNs, columns, inputs: {}, totalRows: rows };
  return { table, columnPvs: PVS };
}

function input(extra: Partial<PlotOptionInput> = {}): PlotOptionInput {
  return {
    frame: frame(),
    view: 'scatter',
    axes: 'shared',
    densityPv: '',
    unitsOf: () => 'mm',
    theme: drawingThemeFor('dark'),
    hidden: new Set(),
    width: 900,
    ...extra,
  };
}

describe('tool fragment', () => {
  it('is the chart option without its series', () => {
    const i = input();
    const rest: Record<string, unknown> = { ...plotOption(i) };
    delete rest.series;
    expect(selectToolFragment(i)).toEqual(rest);
    expect(toolCodeFragment(i)).toBe(codeFragment(rest));
    expect(toolCodeFragment(i)).not.toContain('series');
  });

  it('follows the layout: the axes of every layout are in it', () => {
    for (const axes of ['shared', 'overlay', 'split'] as const) {
      const i = input({ axes });
      const o = plotOption(i);
      expect(selectToolFragment(i).xAxis).toEqual(o.xAxis);
      expect(selectToolFragment(i).yAxis).toEqual(o.yAxis);
    }
  });
});
