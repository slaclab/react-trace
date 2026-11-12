// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import {
  PALETTES,
  DEFAULT_PALETTE_ID,
  getPalette,
  colorForIndex,
  isPaletteId,
  paletteOf,
  paletteSlot,
  recolourBySlot,
  storedPaletteId,
  withPalette,
  type Palette,
} from './palettes';
import { LEGACY_PALETTE_KEY, readLegacyPaletteId } from './state/paletteStore';
import { buildInitialPlots } from './embed/initialPlots';
import { plotConfigOf } from './embed/plotConfig';
import { plotPaletteDot, type TraceDotModel, type TraceDotState } from './tools/trace/dots';
import type { ToolContext } from './workbench/types';

describe('getPalette', () => {
  it('returns the palette matching the id', () => {
    expect(getPalette('viridis').id).toBe('viridis');
  });

  it('falls back to the default palette for an unknown id', () => {
    expect(getPalette('does-not-exist').id).toBe(DEFAULT_PALETTE_ID);
  });

  it('always has a palette registered for the default id', () => {
    expect(PALETTES.some((p) => p.id === DEFAULT_PALETTE_ID)).toBe(true);
  });
});

describe('colorForIndex', () => {
  const palette: Palette = { id: 'test', label: 'Test', colors: ['#aaa', '#bbb', '#ccc'] };

  it('returns colors in order within range', () => {
    expect(colorForIndex(palette, 0)).toBe('#aaa');
    expect(colorForIndex(palette, 1)).toBe('#bbb');
    expect(colorForIndex(palette, 2)).toBe('#ccc');
  });

  it('cycles past the end of the palette', () => {
    expect(colorForIndex(palette, 3)).toBe('#aaa');
    expect(colorForIndex(palette, 4)).toBe('#bbb');
    expect(colorForIndex(palette, 7)).toBe('#bbb');
  });

  it('handles negative indices without throwing', () => {
    expect(colorForIndex(palette, -1)).toBe('#ccc');
  });

  it('returns a fallback color for an empty palette', () => {
    expect(colorForIndex({ id: 'empty', label: 'Empty', colors: [] }, 0)).toBe('#000000');
  });
});

const DEF = getPalette(DEFAULT_PALETTE_ID);
const MPL = getPalette('matplotlib');
const DIV = getPalette('diverging'); // five colours, fewer than the default

describe('palette ids', () => {
  it('knows the registered ids only', () => {
    expect(isPaletteId('viridis')).toBe(true);
    expect(isPaletteId('nope')).toBe(false);
    expect(isPaletteId(undefined)).toBe(false);
    expect(isPaletteId(3)).toBe(false);
  });

  it('stores the default and unknown ids as absent', () => {
    expect(storedPaletteId(DEFAULT_PALETTE_ID)).toBeUndefined();
    expect(storedPaletteId('nope')).toBeUndefined();
    expect(storedPaletteId(undefined)).toBeUndefined();
    expect(storedPaletteId('viridis')).toBe('viridis');
  });

  it("resolves a plot's palette, absent meaning the default", () => {
    expect(paletteOf({}).id).toBe(DEFAULT_PALETTE_ID);
    expect(paletteOf(undefined).id).toBe(DEFAULT_PALETTE_ID);
    expect(paletteOf({ palette: 'viridis' }).id).toBe('viridis');
  });
});

describe('recolour by slot', () => {
  it('finds a colour slot case-insensitively, -1 outside the palette', () => {
    expect(paletteSlot(DEF.colors[2].toLowerCase(), DEF)).toBe(2);
    expect(paletteSlot('#123456', DEF)).toBe(-1);
  });

  it('maps old slot k to new slot k, modulo the new length', () => {
    expect(recolourBySlot(DEF.colors[1], DEF, MPL)).toBe(MPL.colors[1]);
    expect(DEF.colors.length).toBeGreaterThan(DIV.colors.length);
    const k = DIV.colors.length + 1;
    expect(recolourBySlot(DEF.colors[k], DEF, DIV)).toBe(DIV.colors[k % DIV.colors.length]);
  });

  it('leaves a colour outside the old palette alone (user-set)', () => {
    expect(recolourBySlot('#123456', DEF, MPL)).toBe('#123456');
    // A colour of the new palette that is not in the old one is user-set too.
    const onlyNew = MPL.colors.find((c) => paletteSlot(c, DEF) < 0)!;
    expect(recolourBySlot(onlyNew, DEF, DIV)).toBe(onlyNew);
  });

  it('withPalette stores the id, recolours palette curves and keeps the rest', () => {
    const plot: { palette?: string; traces: { color?: string }[] } = {
      traces: [{ color: DEF.colors[0] }, { color: '#123456' }, { color: DEF.colors[3] }, {}],
    };
    const next = withPalette(plot, MPL.id);
    expect(next.palette).toBe(MPL.id);
    expect(next.traces.map((t) => t.color)).toEqual([
      MPL.colors[0],
      '#123456',
      MPL.colors[3],
      undefined,
    ]);
    const back = withPalette(next, DEFAULT_PALETTE_ID);
    expect('palette' in back).toBe(false);
    expect(back.traces).toEqual(plot.traces);
  });

  it('withPalette is the identity when the palette does not change', () => {
    const plot = { palette: MPL.id, traces: [{ color: MPL.colors[0] }] };
    expect(withPalette(plot, MPL.id)).toBe(plot);
    const plain = { traces: [{ color: DEF.colors[0] }] };
    expect(withPalette(plain, DEFAULT_PALETTE_ID)).toBe(plain);
    expect(withPalette(plain, 'unknown')).toBe(plain);
  });
});

describe('legacy per-user palette key', () => {
  afterEach(() => window.localStorage.clear());

  it('reads a valid id and ignores an absent or unknown one', () => {
    expect(readLegacyPaletteId()).toBeUndefined();
    window.localStorage.setItem(LEGACY_PALETTE_KEY, 'bogus');
    expect(readLegacyPaletteId()).toBeUndefined();
    window.localStorage.setItem(LEGACY_PALETTE_KEY, MPL.id);
    expect(readLegacyPaletteId()).toBe(MPL.id);
  });

  it('a legacy-key user opens a fresh tab in it, resets to default, and the key is never written', () => {
    window.localStorage.setItem(LEGACY_PALETTE_KEY, MPL.id);
    const legacy = getPalette(readLegacyPaletteId() ?? DEFAULT_PALETTE_ID);
    const [opened] = buildInitialPlots('?pv=A&pv=B&range=-1h', legacy);
    expect(opened.palette).toBe(MPL.id);
    expect(opened.traces.map((t) => t.color)).toEqual([MPL.colors[0], MPL.colors[1]]);

    let state: TraceDotState = { plots: [opened], activePlotId: opened.id };
    const ctx = (): ToolContext<TraceDotState, TraceDotModel> => ({
      state,
      model: { palette: paletteOf(state.plots[0]) },
      update(fn) {
        state = fn(state);
      },
      selection: null,
      target: { level: 'tool', kind: 'trace', id: opened.id },
      capabilities: { elog: false },
      ui: {},
    });
    const dot = plotPaletteDot<TraceDotState, TraceDotModel>();
    expect(dot.modified(ctx())).toBe(true);
    dot.reset(ctx());
    const [reset] = state.plots;
    expect(reset.palette).toBeUndefined();
    expect(reset.traces.map((t) => t.color)).toEqual([DEF.colors[0], DEF.colors[1]]);
    expect(dot.modified(ctx())).toBe(false);
    // The reset view is the default: nothing about colour on the wire.
    expect(plotConfigOf(reset)).toBeUndefined();
    // The key is only read: still the user's old pick.
    expect(window.localStorage.getItem(LEGACY_PALETTE_KEY)).toBe(MPL.id);
  });
});
