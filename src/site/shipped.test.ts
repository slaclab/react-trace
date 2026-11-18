// @vitest-environment jsdom
//
// The shipped site defaults (src/site/builtins.ts) for the plot behaviour the
// maintainers decided (C1-C7), each pinned where it lands: the built-in value
// and what a plot created with it does. Trace's gestures on a whole plot are
// pinned in src/components/PlotArea.shipped.test.tsx.
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_CATALOG } from '../annotations/catalog';
import { resolveKeyIn } from '../annotations/keys';
import { plotConfigOf } from '../embed/plotConfig';
import { deserializeWorkspace, serializeWorkspace } from '../io/serialize';
import { DRAG_MODES } from '../plot/plotToggles';
import { LIVE_RETENTION_MAX_MS, resolveLiveRetentionMs } from '../state/liveStore';
import { initialTracePlots, newSitePlot, newSiteTrace } from '../tools/trace/defaults';
import { tracePlotView } from '../tools/trace/plotView';
import { BUILTIN_DEFAULTS } from './builtins';
import { resetSiteDefaults } from './store';
import { SITE_KEYS } from './validate';

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

describe('C5: the crosshair is on in new plots, and on for a link or file that does not say', () => {
  it('ships the crosshair on, and every new plot opens with it', () => {
    expect(BUILTIN_DEFAULTS.trace.plot.showCrosshair).toBe(true);
    expect(newSitePlot('p', 0).showCrosshair).toBe(true);
    expect(initialTracePlots('?pv=A')[0].showCrosshair).toBe(true);
  });

  it('opens a link with plot= but no crosshair key with the crosshair on', () => {
    const query = `?pv=A&range=-1h&plot=${encodeURIComponent('{"v":1,"title":"Old"}')}`;
    expect(initialTracePlots(query)[0].showCrosshair).toBe(true);
  });

  it('opens a .trc.json plot without the crosshair key with it on, as main does', () => {
    const [plot] = initialTracePlots('?pv=A');
    const { showCrosshair: _omitted, ...rest } = plot;
    void _omitted;
    const file = JSON.stringify({ schemaVersion: 1, theme: 'dark', plots: [rest] });
    expect(deserializeWorkspace(file).plots[0].showCrosshair).toBe(true);
  });

  it('writes the crosshair only when it is off', () => {
    const [plot] = initialTracePlots('?pv=A');
    expect(plotConfigOf(plot)).toBeUndefined();
    expect(plotConfigOf({ ...plot, showCrosshair: false })).toEqual({ v: 1, showCrosshair: false });
  });
});

describe('C6: live retention follows the plot span, at most 30 min; a curve may pin its own', () => {
  it('stamps no retention on a new curve: it is automatic', () => {
    expect(newSiteTrace('t', 'A', 'ax', '#123456', []).liveRetentionMs).toBeUndefined();
    expect(initialTracePlots('?pv=A')[0].traces[0].liveRetentionMs).toBeUndefined();
    expect(SITE_KEYS).not.toContain('trace.trace.liveRetentionS');
  });

  it('follows the span up to 1800 s, and a curve’s own value wins', () => {
    expect(LIVE_RETENTION_MAX_MS).toBe(1_800_000);
    expect(resolveLiveRetentionMs(undefined, undefined, 600_000)).toBe(600_000);
    expect(resolveLiveRetentionMs(undefined, undefined, 7_200_000)).toBe(1_800_000);
    expect(resolveLiveRetentionMs(60_000, undefined, 7_200_000)).toBe(60_000);
  });

  it('loads a curve’s saved retention (R9)', () => {
    const [plot] = initialTracePlots('?pv=A');
    plot.traces = [{ ...plot.traces[0], liveRetentionMs: 900_000 }];
    const file = serializeWorkspace({ theme: 'dark', plots: [plot] });
    expect(deserializeWorkspace(file).plots[0].traces[0].liveRetentionMs).toBe(900_000);
  });
});
