// Ported from Python `trace` config.json `color_palettes`.
// Keep ids in sync with the reference config so saved selections stay valid.

export interface Palette {
  id: string;
  label: string;
  colors: string[];
}

export const PALETTES: Palette[] = [
  {
    id: 'default',
    label: 'Default',
    colors: [
      '#008CF9',
      '#006E00',
      '#B80058',
      '#EBAC23',
      '#B24502',
      '#FF9287',
      '#5954D6',
      '#00C6F8',
      '#878500',
      '#00A76C',
      '#D163E6',
      '#00BBAD',
    ],
  },
  {
    id: 'matplotlib',
    label: 'Matplotlib',
    colors: [
      '#1f77b4',
      '#ff7f0e',
      '#2ca02c',
      '#d62728',
      '#9467bd',
      '#8c564b',
      '#e377c2',
      '#7f7f7f',
      '#bcbd22',
      '#17becf',
    ],
  },
  {
    id: 'light',
    label: 'Light',
    colors: [
      '#8dd3c7',
      '#bebada',
      '#fb8072',
      '#80b1d3',
      '#fdb462',
      '#b3de69',
      '#fccde5',
      '#d9d9d9',
      '#bc80bd',
      '#ccebc5',
      '#ffed6f',
    ],
  },
  {
    id: 'coolwarm',
    label: 'Coolwarm',
    colors: [
      '#364B9A',
      '#4A7BB7',
      '#6EA6CD',
      '#98CAE1',
      '#C2E4EF',
      '#EAECCC',
      '#FEDA8B',
      '#FDB366',
      '#F67E4B',
      '#DD3D2D',
      '#A50026',
    ],
  },
  {
    id: 'PRGn',
    label: 'PRGn',
    colors: [
      '#762a83',
      '#9970ab',
      '#c2a5cf',
      '#e7d4e8',
      '#d9f0d3',
      '#acd39e',
      '#5aae61',
      '#1b7837',
    ],
  },
  {
    id: 'rainbow',
    label: 'Rainbow',
    colors: ['#e8601c', '#f6c141', '#cae0ab', '#4eb265', '#5289c7', '#882e72', '#d1bbd7'],
  },
  {
    id: 'viridis',
    label: 'Viridis',
    colors: [
      '#fde725',
      '#addc30',
      '#5ec962',
      '#28ae80',
      '#21918c',
      '#2c728e',
      '#3b528b',
      '#472d7b',
      '#440154',
    ],
  },
  {
    id: 'cool',
    label: 'Cool',
    colors: ['#00FFFF', '#2AD5FF', '#55AAFF', '#807FFF', '#AA55FF', '#D52AFF', '#FF00FF'],
  },
  {
    id: 'java',
    label: 'Java',
    colors: [
      '#FF0000',
      '#0000FF',
      '#00FF00',
      '#FF00FF',
      '#000000',
      '#660099',
      '#FF6600',
      '#339999',
      '#999999',
    ],
  },
  {
    id: 'excel',
    label: 'Excel',
    colors: ['#4472C4', '#ED7D32', '#A5A5A5', '#FFBF00', '#5B9BD5', '#71AD47'],
  },
  {
    id: 'apple',
    label: 'Apple',
    colors: ['#64B2DF', '#9CE25A', '#FFE062', '#FFBF72', '#FE5F5E', '#9D44B9'],
  },
  {
    id: 'diverging',
    label: 'Diverging',
    colors: ['#003F5C', '#58508D', '#BC5090', '#FF6361', '#FFA600'],
  },
  {
    id: 'dark',
    label: 'Dark',
    colors: ['#005900', '#000078', '#490D00', '#8A034F', '#005A8A', '#443500'],
  },
];

export const DEFAULT_PALETTE_ID = 'default';

// Look up a palette by id, falling back to the default palette (and finally the
// first entry) so a stale/unknown id never yields `undefined`.
export function getPalette(id: string): Palette {
  return (
    PALETTES.find((p) => p.id === id) ??
    PALETTES.find((p) => p.id === DEFAULT_PALETTE_ID) ??
    PALETTES[0]
  );
}

// Cyclic color assignment: trace N gets colors[N % len]. Mirrors the Python
// default-palette behavior for new curves and the per-scope re-apply action.
export function colorForIndex(palette: Palette, index: number): string {
  if (palette.colors.length === 0) return '#000000';
  const i = ((index % palette.colors.length) + palette.colors.length) % palette.colors.length;
  return palette.colors[i];
}

// ── Per-plot palette ─────────────────────────────────────────────────────────

/** True iff `id` names a known palette. */
export function isPaletteId(id: unknown): id is string {
  return typeof id === 'string' && PALETTES.some((p) => p.id === id);
}

/**
 * The value a plot stores for palette `id`: undefined for the default palette
 * (automatic) and for an unknown id, else the id.
 */
export function storedPaletteId(id: string | undefined): string | undefined {
  return isPaletteId(id) && id !== DEFAULT_PALETTE_ID ? id : undefined;
}

/** The palette a plot's curves follow: its own, else the default. */
export function paletteOf(plot: { palette?: string } | undefined): Palette {
  return getPalette(plot?.palette ?? DEFAULT_PALETTE_ID);
}

/** The slot (first index) of `colour` in `palette`, case-insensitive; -1 when absent. */
export function paletteSlot(colour: string, palette: Palette): number {
  const c = colour.toLowerCase();
  return palette.colors.findIndex((p) => p.toLowerCase() === c);
}

/**
 * `colour` moved from palette `from` to palette `to` by slot: a colour at
 * slot k of `from` becomes slot k (mod length) of `to`; any other colour is
 * user-set and stays.
 */
export function recolourBySlot(colour: string, from: Palette, to: Palette): string {
  const slot = paletteSlot(colour, from);
  return slot < 0 ? colour : colorForIndex(to, slot);
}

interface PalettedPlot {
  palette?: string;
  traces: readonly { color?: string }[];
}

/**
 * `plot` switched to palette `id` (undefined = default): the stored id is
 * normalised and every curve still at a colour of the old palette is
 * recoloured by slot. Unchanged (same object) when the palette does not change.
 */
export function withPalette<P extends PalettedPlot>(plot: P, id: string | undefined): P {
  const next = storedPaletteId(id);
  const from = paletteOf(plot);
  const to = paletteOf({ palette: next });
  if (from.id === to.id && plot.palette === next) return plot;
  const out: P = {
    ...plot,
    traces: plot.traces.map((t) =>
      t.color === undefined ? t : { ...t, color: recolourBySlot(t.color, from, to) }
    ),
  };
  if (next === undefined) delete out.palette;
  else out.palette = next;
  return out;
}
