import { CHART_THEMES, type ChartTheme } from '@slaclab/canopy-charts';

// Stored plot backgrounds that mean "follow the theme" rather than a user
// override: the dark default every new or imported plot is created with
// (#161616), the g10 chart background (#f4f4f4), and the pre-g10 light
// default (#ffffff). Anything else was picked by the user and stays put.
const THEME_DEFAULT_BACKGROUNDS = new Set<string>([
  CHART_THEMES.dark.bg,
  CHART_THEMES.light.bg,
  '#ffffff',
]);

/** True when `bg` is one of the stored values that mean "follow the theme". */
export function isThemeDefaultBackground(bg: string): boolean {
  return THEME_DEFAULT_BACKGROUNDS.has(bg);
}

/**
 * The background a plot renders (and exports) with in the given chart theme.
 * An undefined `plotBg` is automatic: the theme's.
 */
export function effectiveBackground(
  plotBg: string | undefined,
  theme: Readonly<ChartTheme>
): string {
  return plotBg === undefined || isThemeDefaultBackground(plotBg) ? theme.bg : plotBg;
}
