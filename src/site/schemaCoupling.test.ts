// @vitest-environment jsdom
//
// A site can set nothing a user could not: each site key that has an
// Inspector field accepts exactly that field's kind, range and options. Probed
// through the validator at each bound and just past it, so a field whose
// range changes fails here until the site check follows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldDef, ToolSchema } from '../workbench/types';
import { TRACE_SCHEMA } from '../tools/trace/tool';
import { CORRELATION_SCHEMA } from '../tools/correlation/tool';
import { WAVEFORM_SCHEMA } from '../tools/waveform/tool';
import { validateSiteConfig } from './validate';

type AnyField = FieldDef<unknown, unknown>;

function fieldsOf(schema: ToolSchema<never, never, never>): AnyField[] {
  const objects = [schema.tool, ...Object.values(schema.sections), ...Object.values(schema.items)];
  return objects.flatMap((o) => o.tabs.flatMap((t) => t.fields)) as unknown as AnyField[];
}

function field(schema: ToolSchema<never, never, never>, id: string): AnyField {
  const found = fieldsOf(schema).find((f) => f.id === id);
  if (!found) throw new Error(`no field ${id}`);
  return found;
}

const trace = TRACE_SCHEMA as unknown as ToolSchema<never, never, never>;
const correlation = CORRELATION_SCHEMA as unknown as ToolSchema<never, never, never>;
const waveform = WAVEFORM_SCHEMA as unknown as ToolSchema<never, never, never>;

/** Whether the site takes `value` at `path` (a dotted key). */
function accepts(path: string, value: unknown): boolean {
  const keys = path.split('.');
  const raw: Record<string, unknown> = {};
  let at = raw;
  for (const key of keys.slice(0, -1)) {
    at[key] = {};
    at = at[key] as Record<string, unknown>;
  }
  at[keys[keys.length - 1]] = value;
  let node: unknown = validateSiteConfig(raw, 'test');
  for (const key of keys) node = (node as Record<string, unknown> | undefined)?.[key];
  return node !== undefined;
}

function optionValues(f: AnyField): string[] {
  const options = (f as { options?: (ctx: never) => { value: string }[] }).options;
  if (!options) throw new Error(`${f.id} has no options`);
  return options({} as never).map((o) => o.value);
}

function bounds(f: AnyField): { min: number; max: number | undefined } {
  const { min, max } = f as { min?: number; max?: number };
  if (min === undefined) throw new Error(`${f.id} has no min`);
  return { min, max };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('site keys follow their Inspector fields', () => {
  const toggles: [ToolSchema<never, never, never>, string, string][] = [
    [trace, 'show-crosshair', 'trace.plot.showCrosshair'],
    [trace, 'show-legend', 'trace.plot.showLegend'],
    [trace, 'show-x-gridlines', 'trace.plot.showXGridlines'],
    [trace, 'show-y-gridlines', 'trace.plot.showYGridlines'],
    [trace, 'show-drawing-tools', 'trace.plot.showDrawingTools'],
    [trace, 'show-symbols', 'trace.trace.showSymbol'],
    [correlation, 'drawing-tools', 'correlation.drawingTools'],
    [waveform, 'drawing-tools', 'waveform.drawingTools'],
  ];
  it.each(toggles)('%#: toggle %s ↔ %s', (schema, id, path) => {
    expect(field(schema, id).kind).toBe('toggle');
    expect(accepts(path, true)).toBe(true);
    expect(accepts(path, false)).toBe(true);
    expect(accepts(path, 'true')).toBe(false);
    expect(accepts(path, 1)).toBe(false);
  });

  const choices: [ToolSchema<never, never, never>, string, string][] = [
    [trace, 'drag-mode', 'trace.plot.dragMode'],
    [trace, 'grid-style', 'trace.plot.gridStyle'],
    [trace, 'line-type', 'trace.trace.lineType'],
  ];
  it.each(choices)('%#: options of %s ↔ %s', (schema, id, path) => {
    for (const value of optionValues(field(schema, id))) expect(accepts(path, value)).toBe(true);
    expect(accepts(path, 'bogus')).toBe(false);
  });

  const numbers: [ToolSchema<never, never, never>, string, string, number][] = [
    [trace, 'tick-font-size', 'trace.plot.tickFontSize', 1],
    [trace, 'refresh-interval', 'trace.plot.refreshIntervalS', 1],
    [trace, 'line-width', 'trace.trace.lineWidth', 1],
    [waveform, 'rolling-window', 'waveform.rollS', 1],
    // A percentage in the field, a fraction on the wire.
    [trace, 'grid-opacity', 'trace.plot.gridOpacity', 0.01],
    [correlation, 'trigger-period', 'correlation.dt', 1],
  ];
  it.each(numbers)('%#: range of %s ↔ %s', (schema, id, path, scale) => {
    const { min, max } = bounds(field(schema, id));
    expect(accepts(path, min * scale)).toBe(true);
    expect(accepts(path, min * scale - 0.01 * scale)).toBe(false);
    if (max !== undefined) {
      expect(accepts(path, max * scale)).toBe(true);
      expect(accepts(path, max * scale + scale)).toBe(false);
    }
  });
});
