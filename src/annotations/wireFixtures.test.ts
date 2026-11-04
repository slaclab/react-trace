// Pins Trace's wire format v1 and the drawing-tool registry: every `plot=` link in __fixtures__/trace-wire.json decodes to the recorded plot over
// its base fields (drawing ids normalized: decode mints them fresh) and
// re-encodes byte for byte; every `.trc.json` file there opens to the recorded
// plots and saves back byte for byte; and __fixtures__/registry.json fixes each
// tool's kind code, Alt key, long and short label and rail position — both as
// BUILTIN_CATALOG declares them (the one place they are defined) and as
// the rail, the link encoder and the keymap use them. The rail's icons and its
// strip toggles are the rail's own design (icons.tsx, plotToggles.ts), pinned
// here by the tables below rather than by the fixture's Carbon names.
//
// The byte-pinned values (queries, file texts) are JSON strings, so prettier
// reformatting the fixture files cannot change them. A fixture is never edited
// to make a refactor pass: a difference here is a wire or registry change.
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { View, ZoomArea } from '@carbon/icons-react';
import { applyPlotConfig, plotConfigOf } from '../embed/plotConfig';
import { buildInitialPlots } from '../embed/initialPlots';
import {
  MAX_QUERY_BYTES,
  parseTraceQuery,
  serializeTraceQuery,
  type TraceQuery,
} from '../embed/query';
import { deserializeWorkspace, serializeWorkspace } from '../io/serialize';
import { DEFAULT_PALETTE_ID, getPalette } from '../palettes';
import type { ColorMode } from '@slaclab/canopy-shell/color-mode';
import type { Plot } from '../types';
import { encodeDrawings, MAX_DRAWINGS } from './config';
import { DrawingRail } from './DrawingRail';
import { BUILTIN_CATALOG } from './catalog';
import {
  BoxIcon,
  HorizontalLineIcon,
  MeasureIcon,
  NoteIcon,
  TimeRangeIcon,
  TrendLineIcon,
  VerticalLineIcon,
} from './icons';
import { DataTooltipIcon, KeepDrawingIcon, MagnetIcon } from '../plot/icons';
import { type Annotation, type AnnotationKind } from './model';
import { DEFAULT_TOOL_PREFS, appendCommitIn } from './tools';
import { baseOf } from '../test/fixtureBase';
import traceRaw from './__fixtures__/trace-wire.json?raw';
import registryRaw from './__fixtures__/registry.json?raw';
import { resolveKey } from '../tools/trace/drawing/builtin';

interface LinkFixture {
  name: string;
  query: string;
  /** Whether the link opens as the page's own query (buildInitialPlots) at base. */
  page: boolean;
  parsed: TraceQuery;
  plot: Plot;
}

interface WorkspaceFixture {
  name: string;
  savedAt: string;
  theme: ColorMode;
  file: string;
  plots: Plot[];
}

interface ToolFixture {
  kind: AnnotationKind;
  code: number;
  key: string;
  label: string;
  shortLabel: string;
  icon: string;
}

interface ToggleFixture {
  toggle: string;
  label: string;
  icon: string;
}

const TRACE = JSON.parse(traceRaw) as { links: LinkFixture[]; workspaces: WorkspaceFixture[] };
const REGISTRY = JSON.parse(registryRaw) as { tools: ToolFixture[]; toggles: ToggleFixture[] };

const palette = getPalette(DEFAULT_PALETTE_ID);

/** A drawing without its (freshly minted) id. */
const noId = ({ id: _id, ...rest }: Annotation) => (void _id, rest);
const normalized = (p: Plot) =>
  p.annotations === undefined ? p : { ...p, annotations: p.annotations.map(noId) };

/** What stateOut publishes for a plot. */
const reencode = (p: Plot) => serializeTraceQuery(p.traces, p.xAxis, plotConfigOf(p));

/** The plot a parsed link opens to: buildInitialPlots' own steps, without its page re-encoding. */
function reopen(q: TraceQuery): Plot {
  const base = buildInitialPlots(`?${serializeTraceQuery(q.pvs, q.xAxis)}`, palette)[0];
  return q.plot === undefined ? base : applyPlotConfig(base, q.plot);
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Trace plot= links (base fixtures)', () => {
  it.each(TRACE.links.map((c) => [c.name, c] as const))(
    '%s: decodes to the recorded plot and re-encodes byte for byte',
    (_name, c) => {
      expect(bytes(c.query)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
      const parsed = parseTraceQuery(c.query);
      expect(baseOf(parsed, c.parsed)).toEqual(c.parsed);

      const plot = reopen(parsed);
      expect(baseOf(normalized(plot), c.plot)).toEqual(c.plot);
      expect(reencode(plot)).toBe(c.query);

      if (c.page) {
        const opened = buildInitialPlots(`?${c.query}`, palette)[0];
        expect(baseOf(normalized(opened), c.plot)).toEqual(c.plot);
        expect(reencode(opened)).toBe(c.query);
      }
    }
  );

  it('covers every kind code, flag and colour case', () => {
    const tuples = TRACE.links.flatMap((c) => c.parsed.plot?.drawings ?? []);
    expect(new Set(tuples.map((t) => t[0]))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]));
    const flags = tuples.map((t) => t[6] ?? '').join('');
    for (const f of ['l', 'h', 'd', 'r', 'b', 'w1', 'w1.5', 'w2', 'w3']) expect(flags).toContain(f);
    const colours = new Set(tuples.map((t) => t[4]));
    expect(colours).toContain(undefined);
    expect(colours).toContain('');
    expect([...colours].some((c) => typeof c === 'string' && c.startsWith('\x23'))).toBe(true);
    expect([...colours].some((c) => typeof c === 'string' && c.startsWith('rgb('))).toBe(true);
    expect([...colours].some((c) => typeof c === 'string' && c.startsWith('rgba('))).toBe(true);
    expect(tuples.some((t) => t[2] === 1)).toBe(true);
    expect(tuples.some((t) => t[3] !== null)).toBe(true);
  });

  it('covers the drawing cap and the over-budget drawing shed', () => {
    const counts = TRACE.links.map((c) => c.parsed.plot?.drawings?.length ?? 0);
    expect(counts).toContain(MAX_DRAWINGS);
    const shed = TRACE.links.find((c) => c.name.startsWith('over budget'));
    expect(shed && bytes(shed.query)).toBeGreaterThan(MAX_QUERY_BYTES - 200);
  });
});

describe('.trc.json workspaces (base fixtures)', () => {
  it.each(TRACE.workspaces.map((w) => [w.name, w] as const))(
    '%s: opens to the recorded plots and saves back byte for byte',
    (_name, w) => {
      const back = deserializeWorkspace(w.file);
      expect(back.warnings).toEqual([]);
      expect(back.theme).toBe(w.theme);
      expect(baseOf(back.plots, w.plots)).toEqual(w.plots);

      vi.useFakeTimers();
      vi.setSystemTime(new Date(w.savedAt));
      // The writer resolves an automatic background to the theme's: a light
      // file's pre-g10 `#ffffff` comes back as canopy-charts' g10 light
      // background, which every reader also takes as the theme default.
      const expected =
        w.theme === 'light'
          ? w.file.replaceAll('"backgroundColor": "#ffffff"', '"backgroundColor": "#f4f4f4"')
          : w.file;
      expect(serializeWorkspace({ theme: w.theme, plots: back.plots })).toBe(expected);
    }
  );
});

// ── Registry pin ────────────────────────────────────────────────────────────

type IconCmp = ComponentType<{ size?: number }>;

/** Each tool's rail icon: a drawing of what the tool leaves on the plot. */
const TOOL_ICONS: Record<AnnotationKind, IconCmp> = {
  hline: HorizontalLineIcon,
  vline: VerticalLineIcon,
  trend: TrendLineIcon,
  trange: TimeRangeIcon,
  box: BoxIcon,
  note: NoteIcon,
  measure: MeasureIcon,
};

/** The strip toggles in strip order, as the rail shows them with the data tooltip on, drag zooming and drawings shown. */
const STRIP: readonly { toggle: string; label: string; icon: IconCmp }[] = [
  { toggle: 'magnet', label: 'Magnet', icon: MagnetIcon },
  { toggle: 'stay', label: 'Keep drawing', icon: KeepDrawingIcon },
  { toggle: 'tooltip', label: 'Data tooltip', icon: DataTooltipIcon },
  { toggle: 'drag', label: 'Zoom box', icon: ZoomArea },
  { toggle: 'hide', label: 'Hide all drawings', icon: View },
];

const iconMarkup = (icon: IconCmp) => renderToStaticMarkup(createElement(icon, { size: 16 }));

interface RailButton {
  attrs: Record<string, string>;
  inner: string;
}

/** The rail's buttons in DOM order, with their attributes and inner markup. */
function railButtons(): RailButton[] {
  const html = renderToStaticMarkup(
    createElement(DrawingRail, {
      catalog: BUILTIN_CATALOG,
      prefs: DEFAULT_TOOL_PREFS,
      onPrefs: () => {},
      onHiddenChange: () => {},
      view: { tooltip: true, drag: 'zoom' },
      onView: () => {},
    })
  );
  return [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(([, raw, inner]) => ({
    attrs: Object.fromEntries([...raw.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v])),
    inner,
  }));
}

const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"');

function armedBy(letter: string): AnnotationKind | null {
  const cmd = resolveKey(
    {
      key: letter,
      code: `Key${letter.toUpperCase()}`,
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    },
    false
  );
  return cmd?.kind === 'arm' ? cmd.tool : null;
}

function drawing(kind: AnnotationKind): Annotation {
  return {
    id: 'annotation-1',
    kind,
    points: [
      { t: 1, v: 1 },
      { t: 2, v: 2 },
    ],
    axisId: 'y-axis-1',
    color: '',
    width: 1.5,
    text: '',
  };
}

describe('drawing-tool registry (base pin)', () => {
  const tools = REGISTRY.tools;

  it('lists the seven kinds, in rail order, with their icons and labels', () => {
    const buttons = railButtons();
    const toolButtons = buttons.filter((b) => b.attrs['data-drawing-tool'] !== undefined);
    expect(toolButtons.map((b) => b.attrs['data-drawing-tool'])).toEqual(tools.map((t) => t.kind));
    toolButtons.forEach((b, i) => {
      const t = tools[i];
      expect(unescape(b.attrs['aria-label'])).toBe(t.label);
      // The key shows in the rail's own tooltip, never a native title.
      expect(b.attrs.title).toBeUndefined();
      expect(b.inner).toBe(iconMarkup(TOOL_ICONS[t.kind as AnnotationKind]));
    });
    const toggles = buttons.filter((b) => b.attrs['data-drawing-toggle'] !== undefined);
    expect(toggles.map((b) => b.attrs['data-drawing-toggle'])).toEqual(STRIP.map((t) => t.toggle));
    // The fixture's toggles, in the strip's order.
    expect([...REGISTRY.toggles.map((t) => t.toggle)].sort()).toEqual(
      STRIP.map((t) => t.toggle).sort()
    );
    toggles.forEach((b, i) => {
      expect(unescape(b.attrs['aria-label'])).toBe(STRIP[i].label);
      expect(b.attrs.title).toBeUndefined();
      expect(b.inner).toBe(iconMarkup(STRIP[i].icon));
    });
  });

  it('BUILTIN_CATALOG declares each kind code, Alt key, label and icon, in rail order', () => {
    expect(BUILTIN_CATALOG.tools.map((d) => d.kind)).toEqual(tools.map((t) => t.kind));
    BUILTIN_CATALOG.tools.forEach((d, i) => {
      const t = tools[i];
      expect(d.code, d.kind).toBe(t.code);
      expect(d.key, d.kind).toBe(t.key);
      expect(d.label, d.kind).toEqual({ long: t.label, short: t.shortLabel });
      expect(d.icon, d.kind).toBe(TOOL_ICONS[t.kind as AnnotationKind]);
      expect(BUILTIN_CATALOG.byKind(t.kind), d.kind).toBe(d);
      expect(BUILTIN_CATALOG.byCode(t.code), d.kind).toBe(d);
    });
  });

  it.each(tools.map((t) => [t.kind, t] as const))(
    '%s: kind code, long and short label, Alt key',
    (kind, t) => {
      const [tuple] = encodeDrawings(
        { annotations: [drawing(kind)], axes: [{ id: 'y-axis-1' }] },
        [],
        { catalog: BUILTIN_CATALOG }
      )!;
      expect(tuple[0]).toBe(t.code);
      expect(BUILTIN_CATALOG.byKind(kind)!.label.long).toBe(t.label);
      expect(appendCommitIn(BUILTIN_CATALOG, drawing(kind)).label).toBe(`Draw ${t.shortLabel}`);
      expect(armedBy(t.key)).toBe(kind);
    }
  );

  it('arms a tool from no other Alt letter', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const armed = Object.fromEntries(
      letters.flatMap((l) => {
        const kind = armedBy(l);
        return kind === null ? [] : [[l, kind]];
      })
    );
    expect(armed).toEqual(Object.fromEntries(tools.map((t) => [t.key, t.kind])));
  });
});
