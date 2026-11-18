// @vitest-environment jsdom
//
// The shipped site defaults (src/site/builtins.ts) for the plot behaviour the
// maintainers decided (C1-C7), each pinned where it lands: the built-in value
// and what a plot created with it does. Trace's gestures on a whole plot are
// pinned in src/components/PlotArea.shipped.test.tsx.
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_CATALOG } from '../annotations/catalog';
import { resolveKeyIn } from '../annotations/keys';
import { DRAG_MODES } from '../plot/plotToggles';
import { initialTracePlots, newSitePlot } from '../tools/trace/defaults';
import { tracePlotView } from '../tools/trace/plotView';
import { BUILTIN_DEFAULTS } from './builtins';
import { resetSiteDefaults } from './store';

afterEach(() => resetSiteDefaults());

describe('C1: a left-drag in a new Trace plot draws a zoom box; time pans other ways', () => {
  it('ships the zoom-box drag mode, and every new plot opens with it', () => {
    expect(BUILTIN_DEFAULTS.trace.plot.dragMode).toBe('zoom');
    expect(tracePlotView(newSitePlot('p', 0)).drag).toBe('zoom');
    expect(tracePlotView(initialTracePlots('?pv=A')[0]).drag).toBe('zoom');
  });

  it('keeps Pan as a drag mode, and the arrow keys panning time', () => {
    expect(DRAG_MODES).toContain('pan');
    const key = (k: string) =>
      resolveKeyIn(
        BUILTIN_CATALOG,
        { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false },
        false
      );
    expect(key('ArrowLeft')).toEqual({ kind: 'pan', dir: -1 });
    expect(key('ArrowRight')).toEqual({ kind: 'pan', dir: 1 });
  });
});

describe('C2: Trace’s wheel zooms time only; the other tools keep both', () => {
  it('ships wheel x for Trace and xy for Correlation and Waveform', () => {
    expect(BUILTIN_DEFAULTS.trace.plot.wheel).toBe('x');
    expect(BUILTIN_DEFAULTS.correlation.plot.wheel).toBe('xy');
    expect(BUILTIN_DEFAULTS.waveform.plot.wheel).toBe('xy');
  });
});

describe('C3: dragging a Trace Y axis pans it; the other tools keep stretching', () => {
  it('ships yAxisDrag pan for Trace and stretch for Correlation and Waveform', () => {
    expect(BUILTIN_DEFAULTS.trace.plot.yAxisDrag).toBe('pan');
    expect(BUILTIN_DEFAULTS.correlation.plot.yAxisDrag).toBe('stretch');
    expect(BUILTIN_DEFAULTS.waveform.plot.yAxisDrag).toBe('stretch');
  });
});

describe('C4: a double-click in the plot resets every axis', () => {
  it('ships doubleClick reset for every tool', () => {
    expect(BUILTIN_DEFAULTS.trace.plot.doubleClick).toBe('reset');
    expect(BUILTIN_DEFAULTS.correlation.plot.doubleClick).toBe('reset');
    expect(BUILTIN_DEFAULTS.waveform.plot.doubleClick).toBe('reset');
  });
});
