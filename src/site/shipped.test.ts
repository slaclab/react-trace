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
