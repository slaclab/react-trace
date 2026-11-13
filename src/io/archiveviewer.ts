import type { Axis, Plot, PVTrace } from '../types';
import { getPalette, colorForIndex, DEFAULT_PALETTE_ID } from '../palettes';
import { mapLegacyTimeRange, type DeserializeResult } from './serialize';
import { parseSpanMs, toDatetimeLocal } from '../api/time';

// Detect and decode the UTF-16 (or UTF-8) text a .xml file was saved as.
// ArchiveViewer's Java writer emits UTF-16 with a <?xml ... encoding="UTF-16"?>
// declaration, but that declaration can't be trusted at face value: a
// hand-edited or re-saved file may keep the old declaration text while
// actually being plain ASCII/UTF-8 bytes. Sniff the real byte pattern
// instead — for ASCII-range XML, true UTF-16 has a zero byte in every other
// position (the padding byte of each 16-bit code unit); plain UTF-8/ASCII
// has none.
export function decodeArchiveViewerXml(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.slice(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.slice(2));
  }
  // No BOM: inspect the first ~200 bytes for the alternating-zero pattern.
  const sample = bytes.slice(0, 200);
  let zerosAtEven = 0;
  let zerosAtOdd = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) {
      if (i % 2 === 0) zerosAtEven++;
      else zerosAtOdd++;
    }
  }
  const halfLen = sample.length / 2;
  if (zerosAtOdd > halfLen * 0.9) {
    return new TextDecoder('utf-16le').decode(buffer);
  }
  if (zerosAtEven > halfLen * 0.9) {
    return new TextDecoder('utf-16be').decode(buffer);
  }
  return new TextDecoder('utf-8').decode(buffer);
}

function text(el: Element | null | undefined, tag: string): string {
  return el?.querySelector(tag)?.textContent?.trim() ?? '';
}

function argbIntToHex(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith('#')) return trimmed.toLowerCase();
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  const rgb = n & 0xffffff;
  return `#${rgb.toString(16).padStart(6, '0')}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Wrap each bare variable identifier in a term with Fox's {var} placeholder
// syntax, e.g. bracePlaceholders('A+B', ['A', 'B']) -> '{A}+{B}'.
function bracePlaceholders(term: string, variables: string[]): string {
  if (variables.length === 0) return term;
  const sorted = [...variables].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`\\b(${sorted.map(escapeRegExp).join('|')})\\b`, 'g');
  return term.replace(pattern, '{$1}');
}

function mapDrawType(drawType: string): Pick<PVTrace, 'lineType' | 'lineStyle' | 'showSymbol'> {
  switch (drawType.toLowerCase()) {
    case 'scatter':
      return { lineType: 'direct', lineStyle: 'none', showSymbol: true };
    case 'lines':
      return { lineType: 'direct', lineStyle: 'solid', showSymbol: false };
    case 'steps':
    default:
      return { lineType: 'step', lineStyle: 'solid', showSymbol: false };
  }
}

// ArchiveViewer start/end accept everything mapLegacyTimeRange already handles
// (relative "-1d", "now", ISO-ish absolute) plus MM/dd/yyyy[.SSS] style dates;
// normalize the latter to something `new Date(...)` parses before delegating.
function normalizeAvDate(value: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ .](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{3}))?)?$/.exec(
    value.trim()
  );
  if (!m) return value;
  const [, mm, dd, yyyy, hh = '00', min = '00', ss = '00', ms = '000'] = m;
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}.${ms}`;
}

// ArchiveViewer allows a relative start ("-1d") paired with a fixed absolute
// end — a combination mapLegacyTimeRange doesn't handle (it only resolves a
// relative start when the end is "now"). Resolve the relative start against
// "now" (not the end) into an absolute custom range in that case; otherwise
// delegate to the shared legacy-time-range mapping.
function resolveTimeAxis(start: string, end: string, warnings: string[]): Plot['xAxis'] {
  const endIsNow = !end || end === 'now';
  const startSpanMs = start.startsWith('-') ? parseSpanMs(start.slice(1)) : null;
  if (startSpanMs !== null && !endIsNow) {
    const endMs = new Date(end).getTime();
    if (Number.isFinite(endMs)) {
      const timeFrom = toDatetimeLocal(Date.now() - startSpanMs);
      const timeTo = toDatetimeLocal(endMs);
      // timeFrom is relative to *now*, not to the fixed end, so a saved end
      // that's far enough in the past (or future) produces a reversed
      // range — these minute-precision strings sort lexicographically the
      // same as chronologically, so compare them directly.
      if (timeFrom < timeTo) {
        return { timeRange: 'custom', timeFrom, timeTo };
      }
      warnings.push(
        `Time axis: relative start '${start}' (from now) is not before fixed end '${end}'; falling back to the last hour.`
      );
      return { timeRange: '-1h' };
    }
  }
  return mapLegacyTimeRange({ start, end }, warnings);
}

export function convertArchiveViewer(xmlText: string): DeserializeResult {
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Unrecognized .xml file: could not parse as XML.');
  }
  const root = doc.querySelector('AVConfiguration');
  if (!root) {
    throw new Error('Unrecognized .xml file: missing root <AVConfiguration> element.');
  }

  // Range axes: name -> Axis, plus a synthesized shared axis for traces with
  // an empty/unknown range_axis_name. ArchiveViewer plots those traces
  // "normalized" (each value divided by the pv's own range) — Trace has no
  // such mode, so they're plotted on a shared raw-value axis instead; warn
  // so this isn't mistaken for the source file's normalized view.
  const axes: Axis[] = [];
  const axisIdByName = new Map<string, string>();
  const rangeAxisEls = Array.from(root.querySelectorAll(':scope > range_axis'));
  rangeAxisEls.forEach((el, i) => {
    const name = el.getAttribute('name') ?? `Axis ${i + 1}`;
    const minText = text(el, 'min');
    const maxText = text(el, 'max');
    const min = minText ? Number(minText) : undefined;
    const max = maxText ? Number(maxText) : undefined;
    const location = text(el, 'location');
    const id = `axis-${i + 1}`;
    axisIdByName.set(name, id);
    // An empty location hides only the axis's line/ticks in ArchiveViewer, but
    // Trace's `visible` also drops every attached trace (see PlotArea's
    // visible-axes filter) — keep the axis visible so its traces still plot,
    // and warn instead of silently discarding the decoration-hiding intent.
    if (location === '') {
      warnings.push(
        `Range axis '${name}' has no location (hidden in ArchiveViewer); showing it so its traces still plot.`
      );
    }
    axes.push({
      id,
      name,
      orientation: location === 'right' ? 'right' : 'left',
      min,
      max,
      autoScale: min === undefined || max === undefined,
      logScale: text(el, 'type') === 'log',
      visible: true,
    });
  });
  const sharedAxisId = 'axis-shared';
  let sharedAxisUsed = false;

  function resolveRangeAxis(name: string): string {
    if (name === '') {
      warnings.push(
        `Trace has no range_axis_name (normalized in ArchiveViewer); plotted with raw values on a shared axis instead.`
      );
      sharedAxisUsed = true;
      return sharedAxisId;
    }
    const id = axisIdByName.get(name);
    if (id) return id;
    warnings.push(
      `Trace references unknown range_axis '${name}'; plotted with raw values on a shared axis instead.`
    );
    sharedAxisUsed = true;
    return sharedAxisId;
  }

  // Time axes: use the first as the plot's xAxis; warn about the rest.
  const timeAxisEls = Array.from(root.querySelectorAll(':scope > time_axis'));
  const primaryTimeAxisName = timeAxisEls[0]?.getAttribute('name') ?? 'Main Time Axis';
  if (timeAxisEls.length > 1) {
    const dropped = timeAxisEls
      .slice(1)
      .map((el) => el.getAttribute('name') ?? '(unnamed)')
      .join(', ');
    warnings.push(
      `Multiple time axes found; only '${primaryTimeAxisName}' was imported. Dropped: ${dropped}.`
    );
  }
  const primaryTimeAxisEl = timeAxisEls[0];
  const xAxis = primaryTimeAxisEl
    ? resolveTimeAxis(
        normalizeAvDate(text(primaryTimeAxisEl, 'start') || '-1d'),
        normalizeAvDate(text(primaryTimeAxisEl, 'end') || 'now'),
        warnings
      )
    : { timeRange: '-1h' };

  const palette = getPalette(DEFAULT_PALETTE_ID);
  const traces: PVTrace[] = [];
  const idByAveName = new Map<string, string>();
  const formulaIds = new Set<string>();
  const directoryNames = new Set<string>();

  function addDirectory(el: Element) {
    const dir = el.getAttribute('directory_name');
    if (dir) directoryNames.add(dir);
  }

  function buildCommon(el: Element, index: number): Omit<PVTrace, 'id' | 'pvName' | 'kind'> {
    const colorRaw = text(el, 'color');
    const color = (colorRaw && argbIntToHex(colorRaw)) || colorForIndex(palette, index);
    const drawWidthText = text(el, 'draw_width');
    const drawWidth = drawWidthText ? Number(drawWidthText) : 1;
    return {
      displayName: '',
      color,
      visible: text(el, 'visibility') !== 'false',
      axisId: resolveRangeAxis(text(el, 'range_axis_name')),
      useLive: false,
      updateRate: 'monitor',
      useArchive: true,
      lineWidth: Number.isFinite(drawWidth) ? drawWidth : 1,
      ...mapDrawType(text(el, 'draw_type') || 'steps'),
      symbolShape: 'circle',
      symbolSize: 10,
      data: [],
    };
  }

  const childEls = Array.from(root.children).filter(
    (el) => el.tagName === 'pv' || el.tagName === 'formula'
  );
  childEls.forEach((el, index) => {
    const name = el.getAttribute('name') ?? '';
    const id = `trace-${index + 1}`;
    addDirectory(el);
    if (el.tagName === 'pv') {
      traces.push({ id, kind: 'pv', pvName: name, ...buildCommon(el, index) });
      idByAveName.set(name, id);
    }
  });
  // Second pass for formulas, so argument_ave bindings can resolve against
  // both pv and formula ids regardless of document order.
  childEls.forEach((el, index) => {
    if (el.tagName !== 'formula') return;
    const name = el.getAttribute('name') ?? '';
    const id = `trace-${index + 1}`;
    idByAveName.set(name, id);
    formulaIds.add(id);
  });
  childEls.forEach((el, index) => {
    if (el.tagName !== 'formula') return;
    const name = el.getAttribute('name') ?? '';
    const id = `trace-${index + 1}`;
    const bindings: Record<string, string> = {};
    const unresolved: string[] = [];
    const variables: string[] = [];
    el.querySelectorAll('argument_ave').forEach((arg) => {
      const argName = arg.getAttribute('name') ?? '';
      const variable = arg.getAttribute('variable') ?? '';
      const targetId = idByAveName.get(argName);
      // Formula-to-formula bindings aren't evaluated (resolveBindings in
      // src/formula.ts skips non-PV targets — see #33); treat them the same
      // as an unresolved reference instead of silently going idle.
      if (targetId && formulaIds.has(targetId)) {
        unresolved.push(`${variable} → ${argName} (formula-to-formula bindings aren't supported)`);
      } else if (targetId && variable) {
        bindings[variable] = targetId;
        variables.push(variable);
      } else unresolved.push(`${variable} → ${argName}`);
    });
    // ArchiveViewer's <term> uses bare identifiers (e.g. "A+B") matched by
    // <argument_ave variable="A">, but Fox expressions require brace-delimited
    // placeholders (e.g. "{A}+{B}") — see src/formula.ts's VAR_RE. Brace each
    // declared variable; longest names first so "AB" isn't split by a "A" match.
    const expression = bracePlaceholders(text(el, 'term'), variables);
    if (unresolved.length > 0) {
      warnings.push(
        `Formula '${name || expression}': could not bind ${unresolved.join(', ')} (not found among pv/formula entries).`
      );
    }
    traces.push({
      id,
      kind: 'formula',
      pvName: '',
      expression,
      bindings,
      ...buildCommon(el, index),
      // A formula trace has no pvName for traceLabel to fall back to; without
      // this it shows as a numbered "New Trace N" instead of its saved name.
      displayName: name || expression,
    });
  });

  if (sharedAxisUsed) {
    axes.push({
      id: sharedAxisId,
      name: 'Shared (raw values)',
      orientation: 'left',
      autoScale: true,
      logScale: false,
      visible: true,
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

  if (directoryNames.size > 0) {
    warnings.push(
      `Archive directory reference(s) not applied — pick the matching archiver from the header: ${Array.from(directoryNames).join(', ')}.`
    );
  }

  const legendEl = root.querySelector(':scope > legend_configuration');
  if (legendEl) {
    const flags = ['show_ave_name', 'show_directory_name', 'show_range', 'show_units'];
    const hiddenFlags = flags.filter((f) => legendEl.getAttribute(f) === 'false');
    if (hiddenFlags.length > 0) {
      warnings.push(
        `Legend sub-settings (${hiddenFlags.join(', ')}) not supported — legend is shown with all details.`
      );
    }
  }

  const plot: Plot = {
    id: 'plot-1',
    title: text(root, 'plot_title') || 'Imported',
    traces,
    axes,
    backgroundColor: '#161616',
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis,
  };

  return { source: 'archiveviewer', plots: [plot], warnings };
}
