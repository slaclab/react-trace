// `.trc.json` round trip of drawings: every field
// survives save/open, an emptied list never reaches the wire (so add-then-
// delete saves byte-equal to the untouched plot), an old file without
// the field opens with none, and a drawing on an unknown axis moves to the
// first axis with exactly one warning.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../annotations/model';
import { withAnnotations } from '../tools/trace/drawing/plotDrawings';
import type { Plot } from '../types';
import { deserializeWorkspace, serializeWorkspace } from './serialize';

function plot(extra: Partial<Plot> = {}): Plot {
  return {
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
    axes: [
      {
        id: 'ax1',
        name: 'A',
        orientation: 'left',
        autoScale: true,
        logScale: false,
        visible: true,
      },
      {
        id: 'ax2',
        name: 'B',
        orientation: 'right',
        autoScale: true,
        logScale: false,
        visible: true,
      },
    ],
    traces: [],
    ...extra,
  };
}

function ann(extra: Partial<Annotation> = {}): Annotation {
  return {
    id: 'annotation-1',
    kind: 'trend',
    points: [
      { t: 1_700_000_000_000, v: 1.5 },
      { t: 1_700_000_060_000, v: 2.5 },
    ],
    axisId: 'ax2',
    traceId: 't1',
    color: '#123456',
    width: 3,
    dash: true,
    text: 'hello',
    extend: 'both',
    locked: true,
    hidden: true,
    ...extra,
  };
}

const wirePlots = (text: string) => JSON.stringify(JSON.parse(text).plots);
const roundTrip = (plots: Plot[]) =>
  deserializeWorkspace(serializeWorkspace({ theme: 'dark', plots }));

afterEach(() => vi.restoreAllMocks());

describe('.trc.json annotations', () => {
  it('round-trips every annotation field', () => {
    const full = ann();
    const hline = ann({
      id: 'annotation-2',
      kind: 'hline',
      points: [{ t: 0, v: 7 }],
      axisId: 'ax1',
      traceId: undefined,
      width: 1.5,
      dash: undefined,
      text: '',
      extend: undefined,
      locked: undefined,
      hidden: undefined,
    });
    delete hline.traceId;
    delete hline.dash;
    delete hline.extend;
    delete hline.locked;
    delete hline.hidden;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = roundTrip([plot({ annotations: [full, hline] })]);
    expect(out.plots[0].annotations).toEqual([full, hline]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('add-then-delete serializes byte-equal to the untouched plot', () => {
    const untouched = plot();
    const added = withAnnotations(untouched, [ann()]);
    const deleted = withAnnotations(added, []);
    const a = serializeWorkspace({ theme: 'dark', plots: [untouched] });
    const b = serializeWorkspace({ theme: 'dark', plots: [deleted] });
    expect(wirePlots(b)).toBe(wirePlots(a));
    expect(wirePlots(b)).not.toContain('annotations');
  });

  it('never writes an empty list even if one is in state', () => {
    const text = serializeWorkspace({ theme: 'dark', plots: [plot({ annotations: [] })] });
    expect(JSON.parse(text).plots[0]).not.toHaveProperty('annotations');
    expect(wirePlots(text)).toBe(wirePlots(serializeWorkspace({ theme: 'dark', plots: [plot()] })));
  });

  it('opens an old file without the field with no annotations key', () => {
    const text = serializeWorkspace({ theme: 'dark', plots: [plot()] });
    const out = deserializeWorkspace(text);
    expect(out.plots[0]).not.toHaveProperty('annotations');
  });

  it('maps a saved empty list to absent', () => {
    const raw = JSON.parse(serializeWorkspace({ theme: 'dark', plots: [plot()] }));
    raw.plots[0].annotations = [];
    const out = deserializeWorkspace(JSON.stringify(raw));
    expect(out.plots[0]).not.toHaveProperty('annotations');
  });

  it('drops invalid items and keeps the rest', () => {
    const raw = JSON.parse(serializeWorkspace({ theme: 'dark', plots: [plot()] }));
    raw.plots[0].annotations = [{ kind: 'bogus' }, ann(), 42];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = deserializeWorkspace(JSON.stringify(raw));
    expect(out.plots[0].annotations).toEqual([ann()]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('maps an all-invalid list to absent', () => {
    const raw = JSON.parse(serializeWorkspace({ theme: 'dark', plots: [plot()] }));
    raw.plots[0].annotations = [{ kind: 'bogus' }];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = deserializeWorkspace(JSON.stringify(raw));
    expect(out.plots[0]).not.toHaveProperty('annotations');
  });

  it('ignores a non-array annotations value', () => {
    const raw = JSON.parse(serializeWorkspace({ theme: 'dark', plots: [plot()] }));
    raw.plots[0].annotations = 'nope';
    const out = deserializeWorkspace(JSON.stringify(raw));
    expect(out.plots[0]).not.toHaveProperty('annotations');
  });

  it('moves drawings on unknown axes to the first axis with one warning', () => {
    const lost1 = ann({ id: 'annotation-a', axisId: 'gone' });
    const lost2 = ann({ id: 'annotation-b', axisId: 'also-gone' });
    const kept = ann({ id: 'annotation-c', axisId: 'ax2' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = roundTrip([plot({ annotations: [lost1, lost2, kept] })]);
    expect(out.plots[0].annotations!.map((a) => a.axisId)).toEqual(['ax1', 'ax1', 'ax2']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a missing axisId lands on the first axis', () => {
    const raw = JSON.parse(serializeWorkspace({ theme: 'dark', plots: [plot()] }));
    const noAxis: Partial<Annotation> = ann();
    delete noAxis.axisId;
    raw.plots[0].annotations = [noAxis];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = deserializeWorkspace(JSON.stringify(raw));
    expect(out.plots[0].annotations![0].axisId).toBe('ax1');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
