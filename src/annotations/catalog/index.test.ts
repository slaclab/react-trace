// Pins the catalogs: `makeCatalog`'s construction checks and lookups,
// BUILTIN_TOOLS' rail order and `BuiltinKind`, the six-tool Correlation and
// Waveform subsets, and the one uniqueness test over every catalog the app
// builds — unique kinds, codes and keys, built-in codes 0–6, no tool key on a
// reserved key (alt+T, the theme) and none on any plot's action shortcut
// (Trace, Correlation, Waveform; standalone and embedded).
import { describe, expect, it } from 'vitest';
import { parseShortcut, type ParsedShortcut } from '../../workbench/useCanvasActions';
import { THEME_SHORTCUT } from '../../workbench/standardActions';
import { traceActions } from '../../tools/trace/actions';
import { traceCapabilities } from '../../tools/trace/capabilities';
import { correlationActions } from '../../tools/correlation/actions';
import { waveformActions } from '../../tools/waveform/actions';
import type { Action } from '../../workbench/types';
import type { AnnotationKind } from '../model';
import type { Catalog, CodecLayout, DrawingTool } from './types';
import {
  BUILTIN_CATALOG,
  BUILTIN_TOOLS,
  CORRELATION_CATALOG,
  makeCatalog,
  WAVEFORM_CATALOG,
  type BuiltinKind,
} from './index';

// ------------------------------------------------------------- helpers --

/** A test-only tool (code 900+) built from a real one, with overrides. */
function testTool(overrides: Partial<DrawingTool> & { kind: string; code: number }): DrawingTool {
  return { ...BUILTIN_TOOLS[0], key: undefined, ...overrides };
}

const RAIL_ORDER = ['hline', 'vline', 'trend', 'trange', 'box', 'note', 'measure'] as const;

// Compile-time: BuiltinKind is exactly today's AnnotationKind and RAIL_ORDER's kinds.
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const builtinIsAnnotationKind: Equal<BuiltinKind, AnnotationKind> = true;
const builtinIsRailOrder: Equal<BuiltinKind, (typeof RAIL_ORDER)[number]> = true;

// ---------------------------------------------------------- makeCatalog --

describe('makeCatalog', () => {
  const a = testTool({ kind: 'test-a', code: 900, key: 'q' });
  const b = testTool({ kind: 'test-b', code: 901, key: 'w' });

  it('keeps the tools in the given order and looks them up by kind and code', () => {
    const c = makeCatalog([b, a]);
    expect(c.tools).toEqual([b, a]);
    expect(c.byKind('test-a')).toBe(a);
    expect(c.byCode(901)).toBe(b);
    expect(c.byKind('nope')).toBeUndefined();
    expect(c.byCode(999)).toBeUndefined();
  });

  it('accepts an empty tool list', () => {
    const c = makeCatalog([]);
    expect(c.tools).toEqual([]);
    expect(c.byKind('hline')).toBeUndefined();
  });

  it('does not share its tool list with the caller', () => {
    const input = [a];
    const c = makeCatalog(input);
    input.push(b);
    expect(c.tools).toEqual([a]);
    expect(Object.isFrozen(c.tools)).toBe(true);
  });

  it('rejects a duplicate kind', () => {
    expect(() => makeCatalog([a, { ...b, kind: 'test-a' }])).toThrow(
      /duplicate tool kind "test-a"/
    );
  });

  it('rejects a duplicate code', () => {
    expect(() => makeCatalog([a, { ...b, code: 900 }])).toThrow(/duplicate tool code 900/);
  });

  it('rejects a duplicate key, case-insensitively', () => {
    expect(() => makeCatalog([a, { ...b, key: 'q' }])).toThrow(/duplicate tool key "q"/);
    expect(() => makeCatalog([a, { ...b, key: 'Q' }])).toThrow(/duplicate tool key "q"/);
  });

  it('allows several tools without a key', () => {
    expect(() =>
      makeCatalog([
        { ...a, key: undefined },
        { ...b, key: undefined },
      ])
    ).not.toThrow();
  });

  it.each([0, 3, 1.5])('rejects arity %s', (arity) => {
    const bad = { ...a, arity } as unknown as DrawingTool;
    expect(() => makeCatalog([bad])).toThrow(/arity/);
  });

  it.each<[CodecLayout, 1 | 2]>([
    ['v', 2],
    ['t', 2],
    ['tv', 2],
    ['tt', 1],
    ['tvtv', 1],
  ])('rejects layout %s with arity %s', (layout, arity) => {
    const bad: DrawingTool = { ...a, arity, codec: { layout } };
    expect(() => makeCatalog([bad])).toThrow(/codec layout/);
  });

  it.each<[CodecLayout, 1 | 2]>([
    ['v', 1],
    ['t', 1],
    ['tv', 1],
    ['tt', 2],
    ['tvtv', 2],
  ])('accepts layout %s with arity %s', (layout, arity) => {
    expect(() => makeCatalog([{ ...a, arity, codec: { layout } }])).not.toThrow();
  });
});

// ------------------------------------------------------------ built-ins --

describe('BUILTIN_TOOLS', () => {
  it('is frozen, in rail order', () => {
    expect(Object.isFrozen(BUILTIN_TOOLS)).toBe(true);
    expect(BUILTIN_TOOLS.map((t) => t.kind)).toEqual(RAIL_ORDER);
    expect(builtinIsAnnotationKind && builtinIsRailOrder).toBe(true);
  });

  it('BUILTIN_CATALOG holds every built-in, in the same order', () => {
    expect(BUILTIN_CATALOG.tools).toEqual(BUILTIN_TOOLS);
    for (const t of BUILTIN_TOOLS) {
      expect(BUILTIN_CATALOG.byKind(t.kind)).toBe(t);
      expect(BUILTIN_CATALOG.byCode(t.code)).toBe(t);
    }
  });

  it.each([
    ['CORRELATION_CATALOG', CORRELATION_CATALOG],
    ['WAVEFORM_CATALOG', WAVEFORM_CATALOG],
  ] as const)('%s is the six built-ins without the time range', (_name, c) => {
    expect(c.tools.map((t) => t.kind)).toEqual(RAIL_ORDER.filter((k) => k !== 'trange'));
    expect(c.byKind('trange')).toBeUndefined();
    for (const t of c.tools) expect(t).toBe(BUILTIN_CATALOG.byKind(t.kind));
  });
});

// ------------------------------------------------- uniqueness test --

const CATALOGS: readonly (readonly [string, Catalog])[] = [
  ['Trace', BUILTIN_CATALOG],
  ['Correlation', CORRELATION_CATALOG],
  ['Waveform', WAVEFORM_CATALOG],
];

const URLS = { bugUrl: 'https://example.test/bug', docsUrl: 'https://example.test/docs' };
const n = () => {};
const theme = (embedded: boolean) =>
  embedded ? undefined : { colorMode: 'light' as const, toggle: n };

/** Every plot's action list, standalone and embedded, with every capability on. */
function plotActions(plot: string, embedded: boolean): Action[] {
  const common = { embedded, theme: theme(embedded), ...URLS };
  switch (plot) {
    case 'Trace':
      return traceActions({
        ...common,
        handlers: {
          refreshArchive: n,
          dataInsight: n,
          postElog: n,
          save: n,
          print: n,
          import: n,
          exportCsv: n,
          exportPng: n,
        },
        capabilities: traceCapabilities({ elog: true }),
      });
    case 'Correlation':
      return correlationActions({
        ...common,
        handlers: { togglePause: n, clear: n, exportCsv: n, exportPng: n, postElog: n },
        paused: false,
        capabilities: { elog: true },
      });
    case 'Waveform':
      return waveformActions({
        ...common,
        handlers: { togglePause: n, snapshot: n, exportCsv: n, exportPng: n, postElog: n },
        paused: false,
        capabilities: { elog: true },
      });
    default:
      throw new Error(plot);
  }
}

const RESERVED: readonly ParsedShortcut[] = [parseShortcut(THEME_SHORTCUT)!];

describe.each(CATALOGS)('%s catalog: wire codes and keys', (plot, catalog) => {
  const tools = catalog.tools;

  it('has unique kinds, codes and keys', () => {
    const keys = tools.flatMap((t) => (t.key === undefined ? [] : [t.key.toLowerCase()]));
    expect(new Set(tools.map((t) => t.kind)).size).toBe(tools.length);
    expect(new Set(tools.map((t) => t.code)).size).toBe(tools.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps built-in codes in 0–6', () => {
    for (const t of tools) {
      expect(Number.isInteger(t.code), t.kind).toBe(true);
      expect(t.code, t.kind).toBeGreaterThanOrEqual(0);
      expect(t.code, t.kind).toBeLessThanOrEqual(6);
    }
  });

  it('puts no tool on a reserved key (alt+T)', () => {
    expect(RESERVED).toContainEqual({ mod: 'alt', key: 't' });
    for (const t of tools) {
      if (t.key === undefined) continue;
      const clash = RESERVED.find((r) => r.mod === 'alt' && r.key === t.key!.toLowerCase());
      expect(clash, `${t.kind}: alt+${t.key}`).toBeUndefined();
    }
  });

  it.each([
    ['standalone', false],
    ['embedded', true],
  ])('puts no tool on a %s action shortcut of any plot', (_mode, embedded) => {
    // A tool key collides with every plot's shortcuts, not just its own plot's:
    // the workbench can show plots of several kinds side by side.
    for (const other of CATALOGS.map(([p]) => p)) {
      const shortcuts = plotActions(other, embedded)
        .map((a) => parseShortcut(a.shortcut))
        .filter((s): s is ParsedShortcut => s !== null);
      expect(shortcuts.length, other).toBeGreaterThanOrEqual(2);
      if (!embedded) expect(shortcuts, other).toContainEqual({ mod: 'alt', key: 't' });
      for (const t of tools) {
        if (t.key === undefined) continue;
        const clash = shortcuts.find((s) => s.mod === 'alt' && s.key === t.key!.toLowerCase());
        expect(clash, `${plot} ${t.kind} alt+${t.key} vs ${other}`).toBeUndefined();
      }
    }
  });
});
