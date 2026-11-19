import { describe, expect, it } from 'vitest';
import { tracePlotView, withPlotView } from './plotView';

describe('Trace plot view', () => {
  it('opens with the tooltip on and a zooming drag', () => {
    expect(tracePlotView({})).toEqual({ tooltip: true, drag: 'zoom' });
  });

  it('stores only the off-default values', () => {
    const off = withPlotView({}, { tooltip: false, drag: 'pan' });
    expect(off).toEqual({ showTooltip: false, dragMode: 'pan' });
    expect(tracePlotView(off)).toEqual({ tooltip: false, drag: 'pan' });
    const back = withPlotView(off, { tooltip: true, drag: 'zoom' });
    expect(back).toEqual({});
  });

  it('leaves a field the patch does not name alone', () => {
    expect(withPlotView({ dragMode: 'pan' }, { tooltip: false })).toEqual({
      dragMode: 'pan',
      showTooltip: false,
    });
  });

  it('still reads a stored zoom as zoom', () => {
    expect(tracePlotView({ dragMode: 'zoom' }).drag).toBe('zoom');
  });
});
