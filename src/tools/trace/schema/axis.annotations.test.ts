// removeAxis migrates drawings with curves: a
// drawing on the removed axis moves to the same fallback axis as its curves,
// others keep identity, and a plot without drawings stays without the key.
import { describe, expect, it } from 'vitest';
import type { Annotation } from '../../../annotations/model';
import type { Axis, Plot } from '../../../types';
import type { TraceDotState } from '../dots';
import { removeAxis } from './axis';

function axis(id: string): Axis {
  return { id, name: id, orientation: 'left', autoScale: true, logScale: false, visible: true };
}

function ann(id: string, axisId: string): Annotation {
  return {
    id,
    kind: 'hline',
    points: [{ t: 0, v: 1 }],
    axisId,
    color: '#123456',
    width: 1.5,
    text: '',
  };
}

function state(extra: Partial<Plot> = {}): TraceDotState {
  const plot: Plot = {
    id: 'plot-1',
    title: 'P',
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
    axes: [axis('ax1'), axis('ax2'), axis('ax3')],
    traces: [],
    ...extra,
  };
  return { plots: [plot], activePlotId: 'plot-1' };
}

describe('removeAxis — annotations', () => {
  it("moves the removed axis's drawings to the fallback axis", () => {
    const a = ann('a', 'ax2');
    const b = ann('b', 'ax3');
    const c = ann('c', 'ax2');
    const next = removeAxis(state({ annotations: [a, b, c] }), 'ax2');
    const list = next.plots[0].annotations!;
    expect(list.map((x) => x.axisId)).toEqual(['ax1', 'ax3', 'ax1']);
    expect(list[1]).toBe(b);
  });

  it('falls back to the first other axis when the first axis is removed', () => {
    const next = removeAxis(state({ annotations: [ann('a', 'ax1')] }), 'ax1');
    expect(next.plots[0].annotations![0].axisId).toBe('ax2');
  });

  it('keeps list identity when no drawing is on the removed axis', () => {
    const list = [ann('a', 'ax1')];
    const next = removeAxis(state({ annotations: list }), 'ax2');
    expect(next.plots[0].annotations).toBe(list);
  });

  it('does not add an annotations key to a plot without drawings', () => {
    const next = removeAxis(state(), 'ax2');
    expect(next.plots[0]).not.toHaveProperty('annotations');
    expect(next.plots[0].axes.map((x) => x.id)).toEqual(['ax1', 'ax3']);
  });

  it("leaves a plot's only axis and its drawings alone", () => {
    const s = state({ axes: [axis('ax1')], annotations: [ann('a', 'ax1')] });
    expect(removeAxis(s, 'ax1')).toBe(s);
  });
});
