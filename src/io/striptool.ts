import type { Axis, Plot, PVTrace } from '../types';
import { getPalette, colorForIndex, DEFAULT_PALETTE_ID } from '../palettes';
import type { DeserializeResult } from './serialize';

// StripTool's fixed 10-slot palette, keyed Strip.Color.Color1..10; curve N uses
// slot N+1 by convention (not stored per curve). See STP_FORMAT.md §4.2.
const PALETTE_KEYS = Array.from({ length: 10 }, (_, i) => `Strip.Color.Color${i + 1}`);

const STRIP_MAX_CURVES = 10;

// Split on the first run of whitespace, mirroring StripConfig.c's
// `while (!isspace(*p)) p++` key/value scan.
function parseLines(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const m = /^(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    map.set(m[1], m[2].trim());
  }
  return map;
}

function parseNumber(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

// StripTool colors are 3 whitespace-separated 16-bit (0-65535) X11 XColor components.
function toHexColor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const rgb = /^(\d+)\s+(\d+)\s+(\d+)$/.exec(raw);
  if (!rgb) return undefined;
  const to8 = (v: string) => Math.round((Number(v) / 65535) * 255);
  const hex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${hex(to8(rgb[1]))}${hex(to8(rgb[2]))}${hex(to8(rgb[3]))}`;
}

export function convertStripTool(text: string): DeserializeResult {
  const warnings: string[] = [];
  const firstLine = text.split('\n', 1)[0] ?? '';
  const header = /^(\S+)\s+(\d+)\.(\d+)/.exec(firstLine);
  if (!header || header[1] !== 'StripConfig') {
    throw new Error("Unrecognized .stp file: missing 'StripConfig <major>.<minor>' header.");
  }
  const major = Number(header[2]);
  const minor = Number(header[3]);
  if (major > 1 || (major === 1 && minor > 2)) {
    throw new Error(
      `.stp file version ${major}.${minor} is newer than this importer understands (1.2).`
    );
  }

  const fields = parseLines(text);

  const timespan = parseNumber(fields.get('Strip.Time.Timespan')) ?? 300;

  const palette = getPalette(DEFAULT_PALETTE_ID);
  const paletteColors = PALETTE_KEYS.map(
    (key, i) => toHexColor(fields.get(key)) ?? colorForIndex(palette, i)
  );

  const lineWidth = parseNumber(fields.get('Strip.Option.GraphLineWidth')) ?? 2;

  const traces: PVTrace[] = [];
  const axes: Axis[] = [];
  for (let n = 0; n < STRIP_MAX_CURVES; n++) {
    const name = fields.get(`Strip.Curve.${n}.Name`);
    if (!name) continue;

    const units = fields.get(`Strip.Curve.${n}.Units`);
    const comment = fields.get(`Strip.Curve.${n}.Comment`);
    const scaleRaw = fields.get(`Strip.Curve.${n}.Scale`);
    const minRaw = fields.get(`Strip.Curve.${n}.Min`);
    const maxRaw = fields.get(`Strip.Curve.${n}.Max`);
    const plotStatus = fields.get(`Strip.Curve.${n}.PlotStatus`);

    const min = parseNumber(minRaw);
    let max = parseNumber(maxRaw);
    // Known StripConfig.c writer bug: when a curve's Max was never explicitly
    // set, the writer's switch-case falls through and prints the curve's
    // Scale enum (0 or 1) under the Max key instead — as a bare `%d`, unlike
    // a real Max, which is always formatted by dbl2str() with the curve's
    // Precision digits (so a genuine 0 or 1 reads "0.00"/"1.00", not "0"/"1").
    // Require both signals — numeric match to Scale *and* no decimal point —
    // so a legitimately saved integer-valued Max (e.g. Min=0/Max=1) survives.
    if (
      max !== undefined &&
      scaleRaw !== undefined &&
      max === Number(scaleRaw) &&
      maxRaw !== undefined &&
      !maxRaw.includes('.')
    ) {
      warnings.push(
        `Curve '${name}': Max value '${maxRaw}' looks like a leaked Scale value (a known StripTool writer bug) — treated as unset.`
      );
      max = undefined;
    }

    const axisId = `axis-${n + 1}`;
    axes.push({
      id: axisId,
      name: units || name,
      orientation: n % 2 === 0 ? 'left' : 'right',
      min,
      max,
      autoScale: min === undefined || max === undefined,
      logScale: scaleRaw === '1',
      visible: true,
      units,
    });

    if (comment) {
      warnings.push(`Curve '${name}': comment '${comment}' dropped (no equivalent field).`);
    }

    traces.push({
      id: `trace-${n + 1}`,
      pvName: name,
      displayName: '',
      color: paletteColors[n] ?? colorForIndex(palette, n),
      visible: plotStatus !== '0',
      axisId,
      useLive: true,
      updateRate: 'monitor',
      useArchive: false,
      lineWidth,
      lineType: 'direct',
      lineStyle: 'solid',
      showSymbol: false,
      symbolShape: 'circle',
      symbolSize: 10,
      data: [],
    });
  }

  if (axes.length === 0) {
    axes.push({
      id: 'axis-1',
      name: 'Y',
      orientation: 'left',
      autoScale: true,
      logScale: false,
      visible: true,
    });
  }

  const background = fields.get('Strip.Color.Background');
  const gridXon = fields.get('Strip.Option.GridXon');
  const gridYon = fields.get('Strip.Option.GridYon');

  const plot: Plot = {
    id: 'plot-1',
    title: 'Imported',
    traces,
    axes,
    backgroundColor: toHexColor(background) ?? '#161616',
    showLegend: true,
    showXGridlines: gridXon !== '0',
    showYGridlines: gridYon !== '0',
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: `-${timespan}s` },
  };

  return { source: 'striptool', plots: [plot], warnings };
}
