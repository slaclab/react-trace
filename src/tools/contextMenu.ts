// What the three plot tools share when they wire the right-click menus
// (workbench/contextMenu): the Open in targets, the PV info rows, a shot's
// text, the plot's PNG and the link to the current view.
import { fetchMetadata } from '@slaclab/canopy-client';
import { canopyConnection } from '../api/connection';
import { openTool, siblingToolUrl } from '../embed/openTool';
import type { Choice, InfoRow } from '../workbench/contextMenu/registry';

/** The tools a signal opens in, by their workspace registry id. */
export type PlotToolId = 'trace' | 'correlation' | 'waveform';

/** A PV in a query value, ":" left readable. */
function enc(pv: string): string {
  return encodeURIComponent(pv).replace(/%3A/gi, ':');
}

/** The context the target queries carry. */
export interface OpenInContext {
  /** Trace's range (`-1h`, …); its default when absent. */
  range?: string;
  /** Correlation's look-back span (`30m`, …); its default when absent. */
  lookback?: string;
}

/** Correlation's look-back for a relative Trace range (`-2h` → `2h`), else undefined. */
export function lookbackOf(range: string | undefined): string | undefined {
  return range !== undefined && /^-\d/.test(range) ? range.slice(1) : undefined;
}

/** Trace's query for one PV. */
export function traceQueryFor(pv: string, range = '-1h'): string {
  return `pv=${enc(pv)}&range=${encodeURIComponent(range)}`;
}

/** Correlation's query: `y` against `x` (either may be absent). */
export function correlationQueryFor(pair: { x?: string; y?: string }, lookback?: string): string {
  const parts: string[] = [];
  if (pair.x) parts.push(`x=${enc(pair.x)}`);
  if (pair.y) parts.push(`y=${enc(pair.y)}`);
  if (lookback) parts.push(`lookback=${encodeURIComponent(lookback)}`);
  return parts.join('&');
}

/** "Open in ›": every other tool, Correlation once as X and once as Y. */
export function openInChoices(from: PlotToolId, pv: string, ctx: OpenInContext = {}): Choice[] {
  const lookback = ctx.lookback ?? lookbackOf(ctx.range);
  const all: (Choice & { tool: PlotToolId })[] = [
    {
      tool: 'trace',
      label: 'Trace',
      run: () => openTool('trace', traceQueryFor(pv, ctx.range)),
    },
    { tool: 'waveform', label: 'Waveform', run: () => openTool('waveform', `pv=${enc(pv)}`) },
    {
      tool: 'correlation',
      label: 'Correlation as X',
      run: () => openTool('correlation', correlationQueryFor({ x: pv }, lookback)),
    },
    {
      tool: 'correlation',
      label: 'Correlation as Y',
      run: () => openTool('correlation', correlationQueryFor({ y: pv }, lookback)),
    },
  ];
  return all.filter((c) => c.tool !== from).map(({ label, run }) => ({ label, run }));
}

/** Open Correlation with `y` against `x`. */
export function openCorrelation(x: string, y: string, ctx: OpenInContext = {}): void {
  openTool('correlation', correlationQueryFor({ x, y }, ctx.lookback ?? lookbackOf(ctx.range)));
}

function limits(lo: number | null, hi: number | null): string | null {
  if (lo === null && hi === null) return null;
  return `${lo ?? '—'} … ${hi ?? '—'}`;
}

/**
 * The PV info rows: what the tool knows (`known`, first), then the archiver's
 * metadata for the channel (description, units, precision, limits). A
 * metadata error rejects, and the dialog shows `known` with the reason.
 */
export async function pvInfoRows(
  pv: string,
  known: readonly InfoRow[],
  archiver?: string
): Promise<InfoRow[]> {
  const rows: InfoRow[] = [...known];
  const meta = await fetchMetadata(canopyConnection, pv, archiver).catch((e: unknown) => {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`No metadata (${reason})`, { cause: e });
  });
  const add = (label: string, value: string | number | null) => {
    if (value === null || value === '') return;
    if (rows.some((r) => r.label === label)) return;
    rows.push({ label, value: String(value) });
  };
  add('Description', meta.description);
  add('Units', meta.units);
  add('Precision', meta.precision);
  add('Display limits', limits(meta.displayLow, meta.displayHigh));
  add('Alarm limits', limits(meta.alarmLow, meta.alarmHigh));
  add('Warning limits', limits(meta.warningLow, meta.warningHigh));
  add('Archiver', meta.archiver);
  return rows;
}

/** A value as the reading shows it: four significant digits, exponent at the extremes. */
export function readingNumber(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(3);
  return v.toPrecision(4);
}

/** A number as copied text: full precision, no grouping. */
export function numberText(v: number): string {
  return Number.isFinite(v) ? String(v) : '';
}

/** One array, one value per line (pastes as a spreadsheet column). */
export function arrayText(values: ArrayLike<number>): string {
  return Array.from(values, numberText).join('\n');
}

/** Several arrays as tab-separated columns under a header row of their names. */
export function columnsText(
  columns: readonly { name: string; values: ArrayLike<number> }[]
): string {
  const n = Math.max(0, ...columns.map((c) => c.values.length));
  const lines = [columns.map((c) => c.name).join('\t')];
  for (let i = 0; i < n; i++) {
    lines.push(columns.map((c) => (i < c.values.length ? numberText(c.values[i]) : '')).join('\t'));
  }
  return lines.join('\n');
}

/** A PNG data URL (or its promise) as a blob; null when there is none. */
export async function pngBlob(url: string | Promise<string | null> | null): Promise<Blob | null> {
  const href = await url;
  if (!href || !href.startsWith('data:')) return null;
  const res = await fetch(href);
  return res.blob();
}

/** The standalone page that reopens `tool` with `query`. */
export function viewLinkFor(tool: PlotToolId, query: string): string {
  return siblingToolUrl(tool, query, window.location.href);
}

/** A wall-clock time as HH:MM:SS. */
export function clockText(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/**
 * A right-click on a legend entry opens that curve's menu.
 *
 * ECharts makes legend entries silent unless the legend is selectable, so the
 * tools' legends are `selectedMode: true` with `triggerEvent: true`
 * (`LEGEND_MENU_OPTION`) and their series `legendHoverLink: false`; this
 * object then keeps a left-click from toggling anything: `blockClick`, a
 * capture-phase click listener on an ancestor of the chart, swallows the
 * click while the pointer is over an entry. `events` go to the chart
 * (`chart.on(name, handler)` or an `onEvents` map).
 */
export class LegendMenu {
  private over: string | null = null;
  private readonly onLegend: (name: string, event: MouseEvent) => boolean;

  constructor(onLegend: (name: string, event: MouseEvent) => boolean) {
    this.onLegend = onLegend;
  }

  readonly events = {
    contextmenu: (params: unknown) => {
      const p = legendParams(params);
      const native = p?.native;
      if (!p || !(native instanceof MouseEvent)) return;
      if (this.onLegend(p.name, native)) native.preventDefault();
    },
    mouseover: (params: unknown) => {
      const p = legendParams(params);
      if (p) this.over = p.name;
    },
    mouseout: (params: unknown) => {
      if (legendParams(params)) this.over = null;
    },
  };

  readonly blockClick = (e: MouseEvent): void => {
    if (this.over !== null) e.stopPropagation();
  };
}

/** The legend options the right-click needs (see `LegendMenu`). */
export const LEGEND_MENU_OPTION = { selectedMode: true, triggerEvent: true } as const;

/** Series that do not highlight when their legend entry is hovered. */
export function quietLegendHover<T extends object>(series: readonly T[]): T[] {
  return series.map((s) => ({ ...s, legendHoverLink: false }));
}

function legendParams(params: unknown): { name: string; native: unknown } | null {
  const p = params as { componentType?: string; value?: unknown; event?: { event?: unknown } };
  if (p?.componentType !== 'legend' || typeof p.value !== 'string') return null;
  return { name: p.value, native: p.event?.event };
}
