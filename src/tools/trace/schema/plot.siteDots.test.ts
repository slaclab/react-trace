// @vitest-environment jsdom
//
// The modified dots and resets of the plot fields a site can set (src/site):
// Refresh interval, Default archiver, Mouse drag, Drawing tools and
// Palette. Each dot is lit while the plot's value differs from the site's,
// and its reset writes the site's value back in the field's stored form.
// With the built-ins each behaves as its optional-path dot did
// (plot.test.tsx pins those).
import { afterEach, describe, expect, it } from 'vitest';
import { colorForIndex, getPalette } from '../../../palettes';
import { resetSiteDefaults } from '../../../site/store';
import { setSiteConfig } from '../../../site/testing';
import type { Plot, PVTrace } from '../../../types';
import type { FieldDef, ToolContext } from '../../../workbench/types';
import type { TraceDotState } from '../dots';
import { plotSchema, type TracePlotModel } from './plot';

type State = TraceDotState;
type Ctx = ToolContext<State, TracePlotModel>;
type Field = FieldDef<State, TracePlotModel>;

function field(id: string): Field & { modified(c: Ctx): boolean; reset(c: Ctx): void } {
  const found = plotSchema.tabs.flatMap((t) => t.fields).find((f) => f.id === id);
  if (!found || !('modified' in found) || found.modified === undefined) {
    throw new Error(`no dot on ${id}`);
  }
  return found as Field & { modified(c: Ctx): boolean; reset(c: Ctx): void };
}

function plot(extra: Partial<Plot> = {}): Plot {
  const viridis = getPalette('viridis');
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [{ id: 't1', pvName: 'A', color: colorForIndex(viridis, 0) } as PVTrace],
    axes: [],
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
    ...extra,
  };
}

/** A context over one plot; `state()` reads it after a reset. */
function ctxOf(p: Plot) {
  let state: State = { plots: [p], activePlotId: p.id };
  const ctx = {
    get state() {
      return state;
    },
    model: {} as TracePlotModel,
    update: (fn: (s: State) => State) => void (state = fn(state)),
    selection: null,
    target: { level: 'tool', kind: 'trace', id: p.id },
    capabilities: {},
    ui: {},
  } as unknown as Ctx;
  return { ctx, plot: () => state.plots[0] };
}

const SITE = {
  trace: {
    plot: { refreshIntervalS: 10, archiver: 'arch-b', dragMode: 'pan', showDrawingTools: false },
  },
};

afterEach(() => resetSiteDefaults());

describe('with a site’s values', () => {
  it('leaves the dots off at the site’s values and resets to them', () => {
    setSiteConfig(SITE);
    const at = ctxOf(
      plot({ refreshIntervalS: 10, archiver: 'arch-b', dragMode: 'pan', showDrawingTools: false })
    );
    for (const id of ['refresh-interval', 'default-archiver', 'drag-mode', 'show-drawing-tools']) {
      expect(field(id).modified(at.ctx)).toBe(false);
    }
    const off = ctxOf(plot());
    for (const id of ['refresh-interval', 'default-archiver', 'drag-mode', 'show-drawing-tools']) {
      expect(field(id).modified(off.ctx)).toBe(true);
      field(id).reset(off.ctx);
      expect(field(id).modified(off.ctx)).toBe(false);
    }
    expect(off.plot()).toMatchObject({
      refreshIntervalS: 10,
      archiver: 'arch-b',
      dragMode: 'pan',
      showDrawingTools: false,
    });
  });

  it('lights the dot at the baseline value, and resets it to the site’s', () => {
    setSiteConfig({ trace: { plot: { dragMode: 'pan' } } });
    const { ctx, plot: read } = ctxOf(plot({ dragMode: undefined }));
    expect(field('drag-mode').modified(ctx)).toBe(true);
    field('drag-mode').reset(ctx);
    expect(read().dragMode).toBe('pan');
  });

  it('marks the palette against the site’s and resets to it, recolouring', () => {
    setSiteConfig({ trace: { plot: { palette: 'viridis' } } });
    const at = ctxOf(plot({ palette: 'viridis' }));
    expect(field('plot-palette').modified(at.ctx)).toBe(false);
    const def = ctxOf(
      plot({
        traces: [
          { id: 't1', pvName: 'A', color: colorForIndex(getPalette('default'), 0) } as PVTrace,
        ],
      })
    );
    expect(field('plot-palette').modified(def.ctx)).toBe(true);
    field('plot-palette').reset(def.ctx);
    expect(def.plot().palette).toBe('viridis');
    expect(def.plot().traces[0].color).toBe(colorForIndex(getPalette('viridis'), 0));
  });
});

describe('with the built-ins', () => {
  it('marks a value off the automatic one and resets to automatic', () => {
    const { ctx, plot: read } = ctxOf(
      plot({ refreshIntervalS: 12, archiver: 'arch-a', dragMode: 'pan', showDrawingTools: false })
    );
    for (const id of ['refresh-interval', 'default-archiver', 'drag-mode', 'show-drawing-tools']) {
      expect(field(id).modified(ctx)).toBe(true);
      field(id).reset(ctx);
      expect(field(id).modified(ctx)).toBe(false);
    }
    const p = read();
    expect(p.refreshIntervalS).toBeUndefined();
    expect(p.archiver).toBeUndefined();
    expect(p.dragMode).toBeUndefined();
    expect(p.showDrawingTools).toBeUndefined();
  });

  it('leaves a stamped 5 s refresh interval unmarked: it is the default', () => {
    const { ctx } = ctxOf(plot({ refreshIntervalS: 5 }));
    expect(field('refresh-interval').modified(ctx)).toBe(false);
  });
});
