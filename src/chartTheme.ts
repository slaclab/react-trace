export interface ChartTheme {
  bg: string;
  axisLabel: string;
  axisLine: string;
  splitLine: string;
  axisName: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  tooltipMuted: string;
  crosshair: string;
  legend: string;
}

export const DARK_CHART_THEME: ChartTheme = {
  bg: '#161616',
  axisLabel: '#c6c6c6',
  axisLine: '#525252',
  splitLine: '#393939',
  axisName: '#8d8d8d',
  tooltipBg: '#262626',
  tooltipBorder: '#393939',
  tooltipText: '#f4f4f4',
  tooltipMuted: '#8d8d8d',
  crosshair: '#8d8d8d',
  legend: '#c6c6c6',
};

export const LIGHT_CHART_THEME: ChartTheme = {
  bg: '#ffffff',
  axisLabel: '#393939',
  axisLine: '#a8a8a8',
  splitLine: '#e0e0e0',
  axisName: '#525252',
  tooltipBg: '#ffffff',
  tooltipBorder: '#c6c6c6',
  tooltipText: '#161616',
  tooltipMuted: '#525252',
  crosshair: '#525252',
  legend: '#393939',
};

// Defaults from `addPlot` / INITIAL_PLOTS so we know which `plot.backgroundColor`
// values are "the theme default" vs. an explicit user override. When toggling
// themes, only the defaults follow.
export const DARK_DEFAULT_BG = '#161616';
export const LIGHT_DEFAULT_BG = '#ffffff';

export function effectiveBackground(plotBg: string, theme: ChartTheme): string {
  // If plotBg matches either theme's default bg, snap to current theme's bg.
  // User-customized backgrounds (anything else) stay put.
  if (plotBg === DARK_DEFAULT_BG || plotBg === LIGHT_DEFAULT_BG) return theme.bg;
  return plotBg;
}
