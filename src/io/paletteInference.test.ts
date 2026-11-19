import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE_ID, getPalette } from '../palettes';
import { newPlot, newTrace } from '../embed/plotConfig';
import type { Plot } from '../types';
import { inferPaletteId, withFilePalette } from './paletteInference';

const DEF = getPalette(DEFAULT_PALETTE_ID);
const MPL = getPalette('matplotlib');
const JAVA = getPalette('java');

describe('inferPaletteId', () => {
  it('no colours imply the default', () => {
    expect(inferPaletteId([])).toBe(DEFAULT_PALETTE_ID);
  });

  it('takes the default first when it holds every colour (any hex case)', () => {
    expect(inferPaletteId([DEF.colors[0], DEF.colors[4].toLowerCase()])).toBe(DEFAULT_PALETTE_ID);
  });

  it('takes the first palette, in PALETTES order, holding every colour', () => {
    expect(inferPaletteId([MPL.colors[0], MPL.colors[1]])).toBe('matplotlib');
    // #FF00FF is in both cool and java; cool comes first.
    expect(inferPaletteId(['#FF00FF'])).toBe('cool');
    // With a java-only colour beside it, only java holds both.
    const javaOnly = JAVA.colors.find((c) => c.toLowerCase() !== '#ff00ff')!;
    expect(inferPaletteId(['#ff00ff', javaOnly])).toBe('java');
  });

  it('is undefined when no palette holds every colour', () => {
    expect(inferPaletteId(['#123456'])).toBeUndefined();
    expect(inferPaletteId([DEF.colors[0], '#123456'])).toBeUndefined();
  });
});

function filePlot(colours: string[], extra: Partial<Plot> = {}): Plot {
  const p = newPlot('p1', 0);
  return {
    ...p,
    traces: colours.map((c, i) => newTrace(`t${i}`, `PV:${i}`, p.axes[0].id, c, [])),
    ...extra,
  };
}

describe('withFilePalette (.trc.json opening palette)', () => {
  it('keeps the palette the file states', () => {
    const plot = filePlot([DEF.colors[0]], { palette: 'viridis' });
    expect(withFilePalette(plot)).toBe(plot);
  });

  it('infers it from the curve colours when the file states none', () => {
    expect(withFilePalette(filePlot([MPL.colors[2], MPL.colors[0]])).palette).toBe('matplotlib');
  });

  it('infers it when the stated palette is unknown', () => {
    expect(withFilePalette(filePlot([MPL.colors[2]], { palette: 'gone' })).palette).toBe(
      'matplotlib'
    );
  });

  it('stores the default (inferred or stated) as absent', () => {
    const inferred = withFilePalette(filePlot([DEF.colors[1]]));
    expect('palette' in inferred).toBe(false);
    const stated = withFilePalette(filePlot([MPL.colors[1]], { palette: DEFAULT_PALETTE_ID }));
    expect('palette' in stated).toBe(false);
  });

  it('falls back to the default when no palette holds every colour', () => {
    const plot = withFilePalette(filePlot([MPL.colors[0], '#123456']));
    expect(plot.palette).toBeUndefined();
    // Colours are never rewritten on open.
    expect(plot.traces.map((t) => t.color)).toEqual([MPL.colors[0], '#123456']);
  });
});
