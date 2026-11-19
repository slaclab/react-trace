// Drawing colours: app data layered on the shared chart theme
// (@slaclab/canopy-charts), not part of it. The only hex values annotations
// use (src/annotations is literal-guarded).
import { useColorMode } from '@slaclab/canopy-shell';
import { chartThemeFor, type ChartColorMode, type ChartTheme } from '@slaclab/canopy-charts';

/** The svg text attributes of a drawing label (font, size, slant). */
export interface AnnotationLabelStyle {
  fontFamily: string;
  fontSize: number;
  fontStyle: 'italic' | 'normal';
}

export interface AnnotationTheme {
  /**
   * Accent colours, identical in both themes. They were the default colours
   * by creation index, so a saved `plot=` omits a colour that matches its
   * index; the style panel offers them as accents.
   */
  palette: readonly [string, string, string, string, string];
  /** The ink a drawing coloured {@link ANNOTATION_INK} is drawn in: dark on light, light on dark. */
  ink: string;
  /** Measurement readouts and their guide lines. */
  measure: string;
  /** Outline of the selected drawing. */
  selection: string;
  /** Fill of the drag handles on the selected drawing (the plot's own colour). */
  handle: string;
  /** Labels, note text and the measure readout: a small serif, italic like math in a LaTeX figure. */
  label: AnnotationLabelStyle;
}

/** Shared by both themes: mid-tone hues that read on dark and light backgrounds. */
const ANNOTATION_PALETTE = ['#4589ff', '#ff832b', '#24a148', '#d12771', '#a56eff'] as const;

/**
 * The colour a drawing stores to be drawn in the theme's ink
 * (`AnnotationTheme.ink`), so it reads in both themes. New drawings take it.
 */
export const ANNOTATION_INK = 'ink';

const ANNOTATION_LABEL: AnnotationLabelStyle = Object.freeze({
  fontFamily: '"STIX Two Text", "Latin Modern Roman", "Times New Roman", Times, serif',
  fontSize: 11,
  fontStyle: 'italic',
});

/** The drawing colours of each colour mode, over the g100 and g10 chart themes. */
export const ANNOTATION_THEMES: Readonly<Record<ChartColorMode, Readonly<AnnotationTheme>>> = {
  dark: {
    palette: ANNOTATION_PALETTE,
    ink: '#f4f4f4',
    measure: '#f4f4f4',
    selection: '#78a9ff',
    handle: '#161616',
    label: ANNOTATION_LABEL,
  },
  light: {
    palette: ANNOTATION_PALETTE,
    ink: '#161616',
    measure: '#161616',
    selection: '#0f62fe',
    handle: '#ffffff',
    label: ANNOTATION_LABEL,
  },
};

/** The chart theme of a colour mode with its drawing colours: what a drawing layer reads. */
export type ChartDrawingTheme = Readonly<ChartTheme> & { annotation: Readonly<AnnotationTheme> };

// One frozen object per mode, like canopy-charts' own themes: a theme is
// compared by reference wherever a chart option or a drawing layer is memoized.
const DRAWING_THEMES: Readonly<Record<ChartColorMode, ChartDrawingTheme>> = {
  dark: Object.freeze({ ...chartThemeFor('dark'), annotation: ANNOTATION_THEMES.dark }),
  light: Object.freeze({ ...chartThemeFor('light'), annotation: ANNOTATION_THEMES.light }),
};

/** Pure lookup: the chart theme and the drawing colours of `mode`, the same object each call. */
export function drawingThemeFor(mode: ChartColorMode): ChartDrawingTheme {
  return DRAWING_THEMES[mode];
}

/** {@link drawingThemeFor} the current mode of the canopy-shell colour-mode store. */
export function useDrawingTheme(): ChartDrawingTheme {
  return drawingThemeFor(useColorMode().colorMode);
}

const COLOR_LITERAL = /^(#[0-9A-Fa-f]{3,8}|rgba?\([\d\s.,%]+\))$/;

/**
 * True when `v` is a plain colour literal: `#` and hex digits, or `rgb()` /
 * `rgba()` around nothing but digits, spaces, dots, commas and percents. The
 * one colour rule for every colour read from a link or a saved file before it
 * reaches a style, an svg paint or tooltip HTML: a name, `url(…)`,
 * `expression(…)` or a `;` that would start another declaration is refused.
 */
export function isColorLiteral(v: unknown): v is string {
  return typeof v === 'string' && COLOR_LITERAL.test(v);
}

/** The colour `color` is drawn in under `theme`: the theme's ink for {@link ANNOTATION_INK}. */
export function annotationPaint(color: string, theme: Pick<AnnotationTheme, 'ink'>): string {
  return color === ANNOTATION_INK ? theme.ink : color;
}

/**
 * The `index`-th palette colour, cycling: what an absent colour slot of a
 * `plot=` tuple means, so a link keeps its drawings' colours.
 * The palette is theme-independent, so no theme is needed. A negative or
 * fractional index is wrapped / truncated; a non-finite one gives the first colour.
 */
export function defaultAnnotationColor(index: number): string {
  const n = ANNOTATION_PALETTE.length;
  const i = Number.isFinite(index) ? Math.trunc(index) : 0;
  return ANNOTATION_PALETTE[((i % n) + n) % n];
}
