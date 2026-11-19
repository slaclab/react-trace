// The drawing-tool catalogs: `makeCatalog` builds the lookup object a
// plot hands its overlay, rejecting duplicate kinds, codes and keys, an arity
// other than 1 or 2, and a codec layout whose point count disagrees with the
// arity. `BUILTIN_TOOLS` is the seven built-in tools in rail order; Trace gets
// all seven, Correlation and Waveform the six without the time range. There is
// no module-level tool lookup: everything goes through a catalog.
import type { Catalog, CodecLayout, DrawingTool } from './types';
import { BOX_TOOL } from './box/def';
import { HLINE_TOOL } from './hline/def';
import { MEASURE_TOOL } from './measure/def';
import { NOTE_TOOL } from './note/def';
import { TRANGE_TOOL } from './trange/def';
import { TREND_TOOL } from './trend/def';
import { VLINE_TOOL } from './vline/def';

/** How many points each codec layout stores. */
const LAYOUT_POINTS: Readonly<Record<CodecLayout, 1 | 2>> = {
  v: 1,
  t: 1,
  tv: 1,
  tt: 2,
  tvtv: 2,
};

/** A catalog over `tools` (kept in the given rail order). Throws on an inconsistent tool set. */
export function makeCatalog(tools: readonly DrawingTool[]): Catalog {
  const kinds = new Map<string, DrawingTool>();
  const codes = new Map<number, DrawingTool>();
  const keys = new Map<string, DrawingTool>();
  for (const tool of tools) {
    if (kinds.has(tool.kind)) throw new Error(`duplicate tool kind "${tool.kind}"`);
    const sameCode = codes.get(tool.code);
    if (sameCode) {
      throw new Error(`duplicate tool code ${tool.code} ("${sameCode.kind}" and "${tool.kind}")`);
    }
    if (tool.key !== undefined) {
      const key = tool.key.toLowerCase();
      const sameKey = keys.get(key);
      if (sameKey) {
        throw new Error(`duplicate tool key "${key}" ("${sameKey.kind}" and "${tool.kind}")`);
      }
      keys.set(key, tool);
    }
    if (tool.arity !== 1 && tool.arity !== 2) {
      throw new Error(`tool "${tool.kind}" has arity ${String(tool.arity)}; expected 1 or 2`);
    }
    const points = LAYOUT_POINTS[tool.codec.layout];
    if (points !== tool.arity) {
      throw new Error(
        `tool "${tool.kind}" codec layout "${tool.codec.layout}" stores ${String(points)} point(s) but arity is ${tool.arity}`
      );
    }
    kinds.set(tool.kind, tool);
    codes.set(tool.code, tool);
  }
  const list = Object.freeze([...tools]);
  return {
    tools: list,
    byKind: (kind) => kinds.get(kind),
    byCode: (code) => codes.get(code),
  };
}

/** The built-in tools, in today's rail order. */
export const BUILTIN_TOOLS: readonly DrawingTool[] = Object.freeze([
  HLINE_TOOL,
  VLINE_TOOL,
  TREND_TOOL,
  TRANGE_TOOL,
  BOX_TOOL,
  NOTE_TOOL,
  MEASURE_TOOL,
]);

/** A built-in tool's kind, for Trace-typed code. Pinned to `BUILTIN_TOOLS` by catalog/index.test.ts. */
export type BuiltinKind = 'hline' | 'vline' | 'trend' | 'trange' | 'box' | 'note' | 'measure';

/** Trace's catalog: every built-in tool. */
export const BUILTIN_CATALOG: Catalog = makeCatalog(BUILTIN_TOOLS);

const withoutTimeRange = BUILTIN_TOOLS.filter((t) => t !== TRANGE_TOOL);

/** Correlation's catalog: the built-ins without the time range. */
export const CORRELATION_CATALOG: Catalog = makeCatalog(withoutTimeRange);

/** Waveform's catalog: the built-ins without the time range. */
export const WAVEFORM_CATALOG: Catalog = makeCatalog(withoutTimeRange);
