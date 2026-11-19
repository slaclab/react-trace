// @vitest-environment jsdom
// The extensibility proof: a new drawing tool is
// one module (`__fixtures__/cross`, a test-only crosshair, code 900) and one
// catalog line. Offered to a Trace host config and to a Correlation
// (value-axis) host config by that one line each, the tool
// - appears in the rail, arms by its key, renders and hit-tests;
// - shows its own Inspector field in the generic drawing schema;
// - round-trips the real link codecs, `plot=` (parsePlotConfig) and `ann=`
//   (parseCorrelationQuery), each given the test catalog.
// No production file knows the kind `cross`. This test is exempt from the
// drawing core's import boundary: it reaches into Trace and Correlation.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useMemo, useRef, useState } from 'react';
import { drawingThemeFor } from '../../annotationTheme';
import { BUILTIN_CATALOG, BUILTIN_TOOLS, CORRELATION_CATALOG, makeCatalog } from './index';
import type { AxisRef, Catalog, GridProjection, HostConfig, XAxisDescriptor } from './types';
import { TIME_X_AXIS, VALUE_X_AXIS } from './xAxis';
import { CROSS_ARM, CROSS_TOOL } from './__fixtures__/cross/def';
import { createProjectionStore, type Projection } from '../../plot/geometry';
import type { Annotation } from '../model';
import { DEFAULT_TOOL_PREFS, type AnnotationToolPrefs } from '../tools';
import { firePointer, projectionOf } from '../../plot/testUtils';
import { createShedStore } from '../host/shedStore';
import type { DrawingDocument } from '../host/useDrawingDocument';
import {
  useDrawingHost,
  useDrawingWrapperListeners,
  type DrawingHost,
} from '../host/useDrawingHost';
import { DrawingLayers, DrawingRailFor } from '../host/DrawingOverlay';
import { createDrawingSchema, DRAWING_ITEM_KIND, type DrawingAccess } from '../host/workbench';
import type { FieldDef, Target, ToolContext } from '../../workbench/types';
import { createTraceHostConfig } from '../../tools/trace/drawing/hostConfig';
import { createFrameStore } from '../host/frameStore';
import { encodeDrawings } from '../config';
import { TIP_DELAY } from '../DrawingRail';
import {
  applyPlotConfig,
  newPlot,
  parsePlotConfig,
  PLOT_CONFIG_VERSION,
} from '../../embed/plotConfig';
import type { PlotConfig } from '../../embed/plotConfig';
import {
  defaultCorrelationState,
  parseCorrelationQuery,
  serializeCorrelationQuery,
} from '../../tools/correlation/query';

afterEach(cleanup);

// ── The two test catalogs: the host's own tools plus `cross` ────────────────

const TRACE_TEST_CATALOG = makeCatalog([...BUILTIN_TOOLS, CROSS_TOOL]);
const CORRELATION_TEST_CATALOG = makeCatalog([...CORRELATION_CATALOG.tools, CROSS_TOOL]);

// ── The two host configs, each offering `cross` by one config line ──────────

const TRACE_AXIS = 'p1-axis-1';
const CORRELATION_Y = 'TEST:Y';

function traceConfig(): HostConfig {
  const base = createTraceHostConfig({
    traceData: new Map(),
    traces: [],
    binnedTraceIds: new Set(),
    archiveEndMs: new Map(),
    axes: [{ id: TRACE_AXIS }],
  });
  return { ...base, catalog: TRACE_TEST_CATALOG };
}

/** Correlation's value-axis config shape (src/correlation/Plot.tsx), over a fixed Y. */
function correlationConfig(): HostConfig {
  const base: HostConfig = {
    catalog: CORRELATION_CATALOG,
    xAxis: VALUE_X_AXIS,
    snap: { snap: () => null },
    measure: { card: () => [] },
    frames: createFrameStore(),
    shed: createShedStore(),
    ownerAxisAt: () => CORRELATION_Y,
    hiddenReason: () => null,
  };
  return { ...base, catalog: CORRELATION_TEST_CATALOG };
}

interface HostCase {
  name: string;
  config: () => HostConfig;
  catalog: Catalog;
  axisId: string;
  xAxis: XAxisDescriptor;
}

const HOSTS: HostCase[] = [
  {
    name: 'Trace',
    config: traceConfig,
    catalog: TRACE_TEST_CATALOG,
    axisId: TRACE_AXIS,
    xAxis: TIME_X_AXIS,
  },
  {
    name: 'Correlation',
    config: correlationConfig,
    catalog: CORRELATION_TEST_CATALOG,
    axisId: CORRELATION_Y,
    xAxis: VALUE_X_AXIS,
  },
];

// ── A mounted overlay over one fake grid ────────────────────────────────────

// One grid at (0, 0), 200 x 100: x = t/10, y = 100 - v on the host's axis.
function gridOn(axisId: string): GridProjection {
  return {
    tToX: (t) => t / 10,
    xToT: (x) => x * 10,
    vToY: (v, id) => (id === axisId ? 100 - v : NaN),
    yToV: (y, id) => (id === axisId ? 100 - y : NaN),
    gridRect: { left: 0, top: 0, width: 200, height: 100 },
    axisIds: [axisId],
  };
}

interface Live {
  list: Annotation[];
  prefs: AnnotationToolPrefs;
  selectedId: string | null;
  host: DrawingHost | null;
}

function mount(host: HostCase) {
  const config = host.config();
  const grid = gridOn(host.axisId);
  // A fresh object per read, as a real projection rebuild is, so a bump re-renders.
  const store = createProjectionStore((): Projection => projectionOf(grid));
  const axes = [{ id: host.axisId }];
  const live: Live = { list: [], prefs: DEFAULT_TOOL_PREFS, selectedId: null, host: null };

  function Plot() {
    const [list, setList] = useState<Annotation[]>([]);
    const [prefs, setPrefsState] = useState<AnnotationToolPrefs>(DEFAULT_TOOL_PREFS);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [hidden, setHidden] = useState(false);
    const document = useMemo<DrawingDocument>(
      () => ({
        annotations: list,
        commit: (fn) => setList((l) => fn(l)),
        undo: () => {},
        selectedId,
        select: setSelectedId,
        prefs,
        setPrefs: (patch) => setPrefsState((p) => ({ ...p, ...patch })),
        hidden,
        setHidden,
      }),
      [list, selectedId, prefs, hidden]
    );
    live.list = list;
    live.prefs = prefs;
    live.selectedId = selectedId;
    const drawingHost = useDrawingHost(config, document, store, {
      axes,
      theme: drawingThemeFor('dark'),
    });
    live.host = drawingHost;
    const wrapRef = useRef<HTMLDivElement | null>(null);
    useDrawingWrapperListeners(wrapRef, drawingHost);
    return (
      <div ref={wrapRef} data-testid="wrap" style={{ position: 'relative' }}>
        <DrawingLayers host={drawingHost} />
        <DrawingRailFor host={drawingHost} />
      </div>
    );
  }

  const utils = render(<Plot />);
  act(() => store.bump());
  const wrap = utils.getByTestId('wrap');
  const svg = () => wrap.querySelector('svg[data-annotation-layer]') as SVGSVGElement;
  const key = (init: KeyboardEventInit) => {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => {
      wrap.dispatchEvent(ev);
    });
    return ev;
  };
  const fire = (el: EventTarget, type: string, x: number, y: number) =>
    act(() => {
      firePointer(el, type, { x, y });
    });
  return { ...utils, wrap, live, svg, key, fire };
}

// Alt+X arms by physical key (Option+X is ≈ on macOS).
const ALT_X: KeyboardEventInit = { key: '≈', code: 'KeyX', altKey: true };

// ── One drawing of each host, for the Inspector and codec checks ────────────

function cross(host: HostCase, over: Partial<Annotation> = {}): Annotation {
  return {
    id: 'cross-1',
    kind: 'cross',
    points: [{ t: host.xAxis === TIME_X_AXIS ? 1_760_000_000_000 : 12.5, v: 3.25 }],
    axisId: host.axisId,
    color: drawingThemeFor('dark').annotation.palette[2],
    width: 2,
    dash: true,
    text: 'probe',
    ...over,
  };
}

/** The drawing as the codec carries it: everything but the id. */
function wireOf(a: Annotation): Omit<Annotation, 'id'> {
  const { id: _id, ...rest } = a;
  void _id;
  return rest;
}

describe.each(HOSTS)('$name host offers the cross tool by one catalog line', (host) => {
  it('appears in the rail, after the host tools, with its label and shortcut', () => {
    const { wrap } = mount(host);
    const rail = wrap.querySelector('[data-drawing-rail]')!;
    const kinds = [...rail.querySelectorAll('[data-drawing-tool]')].map((el) =>
      el.getAttribute('data-drawing-tool')
    );
    expect(kinds).toEqual(host.catalog.tools.map((t) => t.kind));
    expect(kinds[kinds.length - 1]).toBe('cross');
    const button = rail.querySelector('[data-drawing-tool="cross"]')!;
    expect(button.getAttribute('aria-label')).toBe('Crosshair');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      act(() => {
        fireEvent.pointerEnter(button);
        vi.advanceTimersByTime(TIP_DELAY);
      });
    } finally {
      vi.useRealTimers();
    }
    const tip = rail.querySelector('[role="tooltip"][data-rail-tip]')!;
    expect(tip.querySelector('span')!.textContent).toBe('Crosshair');
    expect(tip.querySelector('kbd')!.textContent).toBe('Alt+X');
    expect(button.getAttribute('aria-describedby')).toBe(tip.id);
  });

  it('arms by its key, and not without the catalog line', () => {
    const { key, live } = mount(host);
    const ev = key(ALT_X);
    expect(ev.defaultPrevented).toBe(true);
    expect(live.prefs.tool).toBe('cross');
    expect(key({ key: 'Escape' }).defaultPrevented).toBe(true);
    expect(live.prefs.tool).toBe('cursor');
    cleanup();

    const without = mount({
      ...host,
      config: () => ({ ...host.config(), catalog: makeCatalog(host.catalog.tools.slice(0, -1)) }),
    });
    expect(without.key(ALT_X).defaultPrevented).toBe(false);
    expect(without.live.prefs.tool).toBe('cursor');
    expect(without.wrap.querySelector('[data-drawing-tool="cross"]')).toBeNull();
  });

  it('places on the host axis, renders its crosshair, and is hit by a click', () => {
    const { key, live, fire, svg, wrap } = mount(host);
    key(ALT_X);
    fire(svg(), 'pointerdown', 50, 40);
    fire(svg(), 'pointerup', 50, 40);

    expect(live.list).toHaveLength(1);
    const [a] = live.list;
    expect(a.kind).toBe('cross');
    expect(a.axisId).toBe(host.axisId);
    expect(a.points).toHaveLength(1);
    expect(a.points[0].t).toBeCloseTo(500, 0);
    expect(a.points[0].v).toBeCloseTo(60, 0);
    // A placed one-point tool re-arms the cursor.
    expect(live.prefs.tool).toBe('cursor');

    const g = wrap.querySelector(`[data-annotation-id="${a.id}"]`)!;
    expect(g).not.toBeNull();
    const x = a.points[0].t / 10;
    const y = 100 - a.points[0].v;
    const d = `M${x - CROSS_ARM} ${y}H${x + CROSS_ARM}M${x} ${y - CROSS_ARM}V${y + CROSS_ARM}`;
    const body = [...g.querySelectorAll('path')].filter(
      (p) => !p.hasAttribute('data-annotation-hit')
    );
    expect(body.map((p) => p.getAttribute('d'))).toContain(d);

    act(() => live.host!.document.select(null));
    expect(live.selectedId).toBeNull();
    const hit = g.querySelector('[data-annotation-hit]')!;
    expect(hit.getAttribute('d')).toBe(d);
    fire(hit, 'pointerdown', x, y);
    fire(svg(), 'pointerup', x, y);
    expect(live.selectedId).toBe(a.id);
    expect(live.list).toHaveLength(1);
  });
});

// ── Inspector ───────────────────────────────────────────────────────────────

interface Drawings {
  drawings: Annotation[];
  axes: AxisRef[];
}

const access: DrawingAccess<Drawings> = {
  list: (s, id) => (s.drawings.some((a) => a.id === id) ? s.drawings : []),
  patch: (s, id, fn) => {
    const current = s.drawings.find((a) => a.id === id);
    if (!current) return s;
    const next = fn(current);
    return next === current
      ? s
      : { ...s, drawings: s.drawings.map((a) => (a.id === id ? next : a)) };
  },
  remove: (s, id) => ({ ...s, drawings: s.drawings.filter((a) => a.id !== id) }),
  axes: (s) => s.axes,
};

type Field = FieldDef<Drawings, unknown>;

describe.each(HOSTS)('$name Inspector shows the cross tool field', (host) => {
  const schema = createDrawingSchema<Drawings, unknown>(access, { catalog: host.catalog });
  const fields = schema.tabs.flatMap((t) => t.fields) as Field[];
  const crossX = fields.find((f) => f.id === 'cross-x')!;

  function ctxOver(state: Drawings, id: string) {
    const box = { state };
    const target: Target = { level: 'item', kind: DRAWING_ITEM_KIND, id };
    const ctx = (): ToolContext<Drawings, unknown> => ({
      state: box.state,
      model: undefined,
      update: (fn) => {
        box.state = fn(box.state);
      },
      selection: target,
      target,
      capabilities: { elog: true, formulas: true },
      ui: {},
    });
    return { box, ctx };
  }

  it('places the field after the host tools fields and before the common tail', () => {
    const ids = fields.map((f) => f.id);
    expect(crossX).toBeDefined();
    expect(crossX.label).toBe('Cross X');
    expect(ids.indexOf('cross-x')).toBe(ids.indexOf('annotation-locked') - 1);
    expect(ids.indexOf('cross-x')).toBeGreaterThan(ids.indexOf('annotation-axis'));
  });

  it('shows it for a cross drawing only, and writes through the host update', () => {
    const a = cross(host);
    const hline: Annotation = { ...a, id: 'h', kind: 'hline', dash: undefined };
    const state: Drawings = {
      drawings: [a, hline],
      axes: [{ id: host.axisId, name: host.axisId }],
    };
    const onCross = ctxOver(state, a.id);
    const onHline = ctxOver(state, 'h');
    expect(crossX.when?.(onCross.ctx()) ?? true).toBe(true);
    expect(crossX.when?.(onHline.ctx()) ?? true).toBe(false);

    const io = crossX as unknown as {
      get(c: ToolContext<Drawings, unknown>): unknown;
      set(c: ToolContext<Drawings, unknown>, v: unknown): void;
    };
    expect(io.get(onCross.ctx())).toBe(a.points[0].t);
    io.set(onCross.ctx(), 42);
    expect(onCross.box.state.drawings[0].points[0]).toEqual({ t: 42, v: a.points[0].v });
    expect(onCross.box.state.drawings[1]).toBe(hline);
  });
});

// ── The real link codecs ────────────────────────────────────────────────────

describe('Trace plot= round-trips a cross drawing through the test catalog', () => {
  const trace = HOSTS[0];

  function linkOf(drawings: Annotation[], catalog?: Catalog): string {
    const plot = { ...newPlot('p1', 0), annotations: drawings };
    const config: PlotConfig = {
      v: PLOT_CONFIG_VERSION,
      drawings: encodeDrawings(plot, [], { catalog: catalog ?? BUILTIN_CATALOG }),
    };
    return JSON.stringify(config);
  }

  it('encodes, parses and applies it back to the same drawing', () => {
    expect(newPlot('p1', 0).axes[0].id).toBe(TRACE_AXIS);
    const a = cross(trace);
    const raw = linkOf([a], TRACE_TEST_CATALOG);
    const parsed = parsePlotConfig(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.drawings).toHaveLength(1);
    const applied = applyPlotConfig(newPlot('p1', 0), parsed!, { catalog: TRACE_TEST_CATALOG });
    expect(applied.annotations).toHaveLength(1);
    expect(wireOf(applied.annotations![0])).toEqual(wireOf(a));
  });

  it('carries it with code 900, and Trace’s built-in catalog drops it', () => {
    const raw = linkOf([cross(trace)], TRACE_TEST_CATALOG);
    const parsed = parsePlotConfig(raw)!;
    expect(JSON.stringify(parsed.drawings)).toMatch(/^\[\[900,/);
    const builtin = applyPlotConfig(newPlot('p1', 0), parsed);
    expect(builtin.annotations ?? []).toHaveLength(0);
    expect(linkOf([cross(trace)])).not.toMatch(/900/);
  });
});

describe('Correlation ann= round-trips a cross drawing through the test catalog', () => {
  const corr = HOSTS[1];

  function stateWith(drawings: Annotation[]) {
    return { ...defaultCorrelationState(), x: 'TEST:X', ys: [CORRELATION_Y], drawings };
  }

  it('serializes and parses it back to the same drawing', () => {
    const a = cross(corr);
    const query = serializeCorrelationQuery(stateWith([a]), {
      catalog: CORRELATION_TEST_CATALOG,
    });
    expect(query).toMatch(/(^|&)ann=/);
    const parsed = parseCorrelationQuery(query, { catalog: CORRELATION_TEST_CATALOG });
    expect(parsed.ys).toEqual([CORRELATION_Y]);
    expect(parsed.drawings).toHaveLength(1);
    expect(wireOf(parsed.drawings[0])).toEqual(wireOf(a));
  });

  it('is dropped by Correlation’s own catalog', () => {
    const query = serializeCorrelationQuery(stateWith([cross(corr)]), {
      catalog: CORRELATION_TEST_CATALOG,
    });
    expect(parseCorrelationQuery(query).drawings).toHaveLength(0);
  });
});
