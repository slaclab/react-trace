import type { PVTrace } from './types';

// Curve appearance options, mirroring the Python `trace` project's
// curve_settings.py (Line Type / Style / Symbol Shape) so the two front-ends
// expose the same choices. Values are kept ECharts-friendly; labels match the
// reference UI wording.

export const LINE_TYPE_OPTIONS: { value: PVTrace['lineType']; label: string }[] = [
  // Step is the default to match the reference (stepMode="right" → ECharts 'end').
  { value: 'step', label: 'Step' },
  { value: 'direct', label: 'Direct' },
];

export const LINE_STYLE_OPTIONS: { value: PVTrace['lineStyle']; label: string }[] = [
  { value: 'none', label: 'NoLine' },
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dash' },
  { value: 'dotted', label: 'Dot' },
  { value: 'dashDot', label: 'DashDot' },
  { value: 'dashDotDot', label: 'DashDotDot' },
];

export const SYMBOL_OPTIONS: { value: PVTrace['symbolShape']; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'circle', label: 'Circle' },
  { value: 'square', label: 'Square' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'star', label: 'Star' },
  { value: 'pentagon', label: 'Pentagon' },
  { value: 'hexagon', label: 'Hexagon' },
  { value: 'x', label: 'X' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'plus', label: 'Plus' },
];

// ECharts `lineStyle.type` accepts 'solid' | 'dashed' | 'dotted' | number[].
// The compound dash/dot patterns have no native keyword, so we describe them
// as explicit on/off dash arrays. 'none' is rendered by zeroing line opacity
// (see PlotArea) so symbols can still show.
export function echartsLineType(
  style: PVTrace['lineStyle']
): 'solid' | 'dashed' | 'dotted' | number[] {
  switch (style) {
    case 'dashed':
      return 'dashed';
    case 'dotted':
      return 'dotted';
    case 'dashDot':
      return [10, 4, 2, 4];
    case 'dashDotDot':
      return [10, 4, 2, 4, 2, 4];
    case 'none':
    case 'solid':
    default:
      return 'solid';
  }
}

// ECharts ships built-in symbols for circle/rect/triangle/diamond; the rest are
// supplied as normalized SVG paths (ECharts scales them to symbolSize).
const SYMBOL_PATHS: Partial<Record<PVTrace['symbolShape'], string>> = {
  star: 'path://M50,5 L61,38 L96,38 L68,59 L79,92 L50,72 L21,92 L32,59 L4,38 L39,38 Z',
  pentagon: 'path://M50,5 L95,38 L77,90 L23,90 L5,38 Z',
  hexagon: 'path://M50,3 L93,27 L93,73 L50,97 L7,73 L7,27 Z',
  x: 'path://M20,5 L50,35 L80,5 L95,20 L65,50 L95,80 L80,95 L50,65 L20,95 L5,80 L35,50 L5,20 Z',
  plus: 'path://M35,5 L65,5 L65,35 L95,35 L95,65 L65,65 L65,95 L35,95 L35,65 L5,65 L5,35 L35,35 Z',
};

export function echartsSymbol(shape: PVTrace['symbolShape']): string {
  switch (shape) {
    case 'none':
      return 'none';
    case 'circle':
      return 'circle';
    case 'square':
      return 'rect';
    case 'triangle':
      return 'triangle';
    case 'diamond':
      return 'diamond';
    default:
      return SYMBOL_PATHS[shape] ?? 'circle';
  }
}
