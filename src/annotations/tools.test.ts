// Pins the tool state machine (prefs in TraceApp, gesture overlay-local): arming,
// 1-point commit on pointerUp, 2-point commit after a > 3 px drag or on the
// second click, exactly one commit per create/move/handle gesture (none on
// cancel or zero movement), return to cursor unless `stay`, the one-shot
// shift-drag measure that never commits, locked/hidden refusal, delete, and
// the Esc ladder that reports `consumed` only for cancel-pending and
// disarm-tool and never deselects.
import { describe, expect, it } from 'vitest';
import { ANNOTATION_INK, defaultAnnotationColor } from '../annotationTheme';
import { BUILTIN_TOOLS, makeCatalog, BUILTIN_CATALOG } from './catalog';
import type { DrawingTool } from './catalog/types';
import { TIME_X_AXIS, VALUE_X_AXIS } from './catalog/xAxis';
import { NEW_DRAWING_WIDTH, type Annotation } from './model';
import { DRAG_THRESHOLD_PX } from '../plot/geometry';
import {
  type AnnotationToolPrefs,
  DEFAULT_TOOL_PREFS,
  DRAFT_ID,
  type GestureState,
  NO_HIT,
  reduceToolsIn,
  type ToolEvent,
  type ToolsContext,
  type ToolPoint,
  type ToolsResult,
} from './tools';

const TRACE_TOOLS = { catalog: BUILTIN_CATALOG, xAxis: TIME_X_AXIS };

const AXIS = 'axis-1';

function pt(x: number, y: number, extra: Partial<ToolPoint> = {}): ToolPoint {
  // 1 px = 10 ms in t and 0.5 units in v (y grows downward).
  return { x, y, t: 1000 + x * 10, v: 100 - y * 0.5, axisId: AXIS, ...extra };
}

function ann(extra: Partial<Annotation> = {}): Annotation {
  return {
    id: 'annotation-9',
    kind: 'trend',
    points: [
      { t: 1000, v: 10 },
      { t: 2000, v: 20 },
    ],
    axisId: AXIS,
    color: defaultAnnotationColor(0),
    width: 1.5,
    text: '',
    ...extra,
  };
}

function prefs(extra: Partial<AnnotationToolPrefs> = {}): AnnotationToolPrefs {
  return { ...DEFAULT_TOOL_PREFS, ...extra };
}

/** Runs events in order, folding prefs patches and gesture; collects results. */
function run(start: AnnotationToolPrefs, events: ToolEvent[], gesture: GestureState = {}) {
  let p = start;
  let g = gesture;
  const results: ToolsResult[] = [];
  for (const e of events) {
    const r = reduceToolsIn(TRACE_TOOLS, p, g, e);
    results.push(r);
    g = r.gesture;
    if (r.prefs) p = { ...p, ...r.prefs };
  }
  const commits = results.filter((r) => r.commit);
  return { prefs: p, gesture: g, results, commits, last: results[results.length - 1] };
}

const down = (p: ToolPoint, hit = NO_HIT, shift = false): ToolEvent => ({
  type: 'pointerDown',
  pt: p,
  hit,
  shift,
});
const move = (p: ToolPoint): ToolEvent => ({ type: 'pointerMove', pt: p });
const up = (p: ToolPoint): ToolEvent => ({ type: 'pointerUp', pt: p });

describe('defaults and prefs events', () => {
  it('starts in cursor mode, not sticky, magnet off', () => {
    expect(DEFAULT_TOOL_PREFS).toEqual({ tool: 'cursor', stay: false, magnet: false });
    expect(DRAG_THRESHOLD_PX).toBe(3);
  });

  it('arm sets the tool and clears any gesture', () => {
    const g: GestureState = run(prefs({ tool: 'trend' }), [down(pt(0, 0))]).gesture;
    expect(g.pending).toBeDefined();
    const r = reduceToolsIn(TRACE_TOOLS, prefs({ tool: 'trend' }), g, {
      type: 'arm',
      tool: 'hline',
    });
    expect(r.prefs).toEqual({ tool: 'hline' });
    expect(r.gesture).toEqual({});
    expect(r.commit).toBeUndefined();
  });

  it('arm cursor disarms', () => {
    const r = reduceToolsIn(
      TRACE_TOOLS,
      prefs({ tool: 'box' }),
      {},
      { type: 'arm', tool: 'cursor' }
    );
    expect(r.prefs).toEqual({ tool: 'cursor' });
  });

  it('setStay and setMagnet patch only their key', () => {
    expect(reduceToolsIn(TRACE_TOOLS, prefs(), {}, { type: 'setStay', on: true }).prefs).toEqual({
      stay: true,
    });
    expect(reduceToolsIn(TRACE_TOOLS, prefs(), {}, { type: 'setMagnet', on: true }).prefs).toEqual({
      magnet: true,
    });
  });

  it('keeps gesture identity on prefs-only events', () => {
    const g: GestureState = {};
    expect(reduceToolsIn(TRACE_TOOLS, prefs(), g, { type: 'setStay', on: true }).gesture).toBe(g);
  });
});

describe('1-point tools', () => {
  it.each(['hline', 'vline', 'note'] as const)(
    '%s commits once on pointerUp without movement',
    (tool) => {
      const r = run(prefs({ tool }), [down(pt(10, 20)), up(pt(10, 20))]);
      expect(r.commits).toHaveLength(1);
      expect(r.gesture).toEqual({});
      const list = r.commits[0].commit!.fn([]);
      expect(list).toHaveLength(1);
      expect(list[0].kind).toBe(tool);
      expect(list[0].points).toHaveLength(1);
      expect(list[0].id).toMatch(/^annotation-/);
      expect(list[0].id).not.toBe(DRAFT_ID);
    }
  );

  it('a placed note asks for its text in place; other tools do not', () => {
    const n = run(prefs({ tool: 'note' }), [down(pt(10, 20)), up(pt(10, 20))]);
    const id = n.commits[0].commit!.fn([])[0].id;
    expect(n.commits[0].edit).toBe(id);
    const h = run(prefs({ tool: 'hline' }), [down(pt(10, 20)), up(pt(10, 20))]);
    expect(h.commits[0].edit).toBeUndefined();
  });

  it('shows a draft while pressed and nothing is committed on pointerDown', () => {
    const r = reduceToolsIn(TRACE_TOOLS, prefs({ tool: 'hline' }), {}, down(pt(10, 20)));
    expect(r.commit).toBeUndefined();
    expect(r.gesture.draft?.kind).toBe('hline');
    expect(r.gesture.draft?.id).toBe(DRAFT_ID);
  });

  it('hline keeps only the value, vline only the time', () => {
    const h = run(prefs({ tool: 'hline' }), [down(pt(10, 20)), up(pt(10, 20))]);
    expect(h.commits[0].commit!.fn([])[0].points).toEqual([{ t: 0, v: 90 }]);
    const v = run(prefs({ tool: 'vline' }), [down(pt(10, 20)), up(pt(10, 20))]);
    expect(v.commits[0].commit!.fn([])[0].points).toEqual([{ t: 1100, v: 0 }]);
  });

  it('note commits at the release point after movement', () => {
    const r = run(prefs({ tool: 'note' }), [down(pt(0, 0)), move(pt(20, 10)), up(pt(20, 10))]);
    expect(r.commits).toHaveLength(1);
    expect(r.commits[0].commit!.fn([])[0].points).toEqual([{ t: 1200, v: 95 }]);
  });

  it('returns to cursor after commit, stays armed with stay', () => {
    const a = run(prefs({ tool: 'hline' }), [down(pt(1, 1)), up(pt(1, 1))]);
    expect(a.prefs.tool).toBe('cursor');
    expect(a.last.prefs).toEqual({ tool: 'cursor' });
    const b = run(prefs({ tool: 'hline', stay: true }), [down(pt(1, 1)), up(pt(1, 1))]);
    expect(b.prefs.tool).toBe('hline');
    expect(b.last.prefs).toBeUndefined();
  });

  it('selects the new drawing and labels the commit', () => {
    const r = run(prefs({ tool: 'hline' }), [down(pt(1, 1)), up(pt(1, 1))]);
    const created = r.commits[0].commit!.fn([])[0];
    expect(r.commits[0].select).toBe(created.id);
    expect(r.commits[0].commit!.label).toBe('Draw H-line');
  });
});

describe('the committed annotation', () => {
  it('appends in the theme ink at the fine default width, whatever the list holds', () => {
    const r = run(prefs({ tool: 'hline' }), [down(pt(1, 1)), up(pt(1, 1))]);
    const existing = [ann({ id: 'a' }), ann({ id: 'b' })];
    const next = r.commits[0].commit!.fn(existing);
    expect(next.slice(0, 2)).toEqual(existing);
    expect(next[2]).toMatchObject({
      color: ANNOTATION_INK,
      width: NEW_DRAWING_WIDTH,
      text: '',
      axisId: AXIS,
    });
    expect(next[2].traceId).toBeUndefined();
    expect(next[2]).not.toHaveProperty('dash');
    expect(NEW_DRAWING_WIDTH).toBe(0.75);
    // The same drawing on an empty list: its colour never depends on the index.
    const { id: _id, ...alone } = r.commits[0].commit!.fn([])[0];
    const { id: _id2, ...third } = next[2];
    void _id;
    void _id2;
    expect(third).toEqual(alone);
  });

  it('the commit fn is deterministic (StrictMode double invocation)', () => {
    const r = run(prefs({ tool: 'trend' }), [down(pt(0, 0)), move(pt(30, 30)), up(pt(30, 30))]);
    const fn = r.commits[0].commit!.fn;
    expect(fn([])).toEqual(fn([]));
  });

  it('quantizes free points to integer ms and 6 significant digits', () => {
    const p = pt(0, 0, { t: 1000.6, v: 1.23456789 });
    const r = run(prefs({ tool: 'note' }), [down(p), up(p)]);
    expect(r.commits[0].commit!.fn([])[0].points).toEqual([{ t: 1001, v: 1.23457 }]);
  });

  it('magnet snaps to the sample, adopts its axis and trace, keeps v exact', () => {
    const snap = { t: 1234.4, v: 1.23456789, axisId: 'axis-2', traceId: 'trace-7' };
    const p = pt(5, 5, { snap });
    const r = run(prefs({ tool: 'note', magnet: true }), [down(p), up(p)]);
    const a = r.commits[0].commit!.fn([])[0];
    expect(a.points).toEqual([{ t: 1234, v: 1.23456789 }]);
    expect(a.axisId).toBe('axis-2');
    expect(a.traceId).toBe('trace-7');
  });

  it('ignores the snap candidate when magnet is off', () => {
    const snap = { t: 1, v: 2, axisId: 'axis-2', traceId: 'trace-7' };
    const p = pt(5, 5, { snap });
    const r = run(prefs({ tool: 'note' }), [down(p), up(p)]);
    const a = r.commits[0].commit!.fn([])[0];
    expect(a.axisId).toBe(AXIS);
    expect(a.traceId).toBeUndefined();
  });
});

describe('2-point tools', () => {
  it.each(['trange', 'trend', 'box', 'measure'] as const)(
    '%s commits once on pointerUp after a > 3 px drag',
    (tool) => {
      const r = run(prefs({ tool }), [
        down(pt(0, 0)),
        move(pt(2, 0)),
        move(pt(10, 10)),
        move(pt(40, 20)),
        up(pt(40, 20)),
      ]);
      expect(r.commits).toHaveLength(1);
      expect(r.results.slice(0, -1).every((x) => !x.commit)).toBe(true);
      const a = r.commits[0].commit!.fn([])[0];
      expect(a.kind).toBe(tool);
      expect(a.points).toHaveLength(2);
    }
  );

  it('the draft follows the pointer during the drag', () => {
    const r = run(prefs({ tool: 'trend' }), [down(pt(0, 0)), move(pt(40, 20))]);
    expect(r.gesture.draft?.points).toEqual([
      { t: 1000, v: 100 },
      { t: 1400, v: 90 },
    ]);
  });

  it('trend points are the press and release points', () => {
    const r = run(prefs({ tool: 'trend' }), [down(pt(0, 0)), move(pt(40, 20)), up(pt(40, 20))]);
    expect(r.commits[0].commit!.fn([])[0].points).toEqual([
      { t: 1000, v: 100 },
      { t: 1400, v: 90 },
    ]);
  });

  it('trange keeps only times', () => {
    const r = run(prefs({ tool: 'trange' }), [down(pt(0, 0)), up(pt(40, 20))]);
    expect(r.commits[0].commit!.fn([])[0].points).toEqual([
      { t: 1000, v: 0 },
      { t: 1400, v: 0 },
    ]);
  });

  it('a release within 3 px is a first click: no commit, waits for the second', () => {
    const r = run(prefs({ tool: 'box' }), [down(pt(0, 0)), up(pt(3, 0))]);
    expect(r.commits).toHaveLength(0);
    expect(r.gesture.pending?.phase).toBe('await');
    expect(r.gesture.draft).toBeDefined();
    expect(r.prefs.tool).toBe('box');
  });

  it('commits on the second click, rubber-banding in between', () => {
    const r = run(prefs({ tool: 'box' }), [down(pt(0, 0)), up(pt(0, 0)), move(pt(50, 50))]);
    expect(r.gesture.draft?.points[1]).toEqual({ t: 1500, v: 75 });
    const r2 = run(r.prefs, [down(pt(60, 40)), up(pt(60, 40))], r.gesture);
    expect(r2.commits).toHaveLength(1);
    expect(r2.results[0].commit).toBeUndefined();
    expect(r2.commits[0].commit!.fn([])[0].points).toEqual([
      { t: 1000, v: 100 },
      { t: 1600, v: 80 },
    ]);
    expect(r2.gesture).toEqual({});
    expect(r2.prefs.tool).toBe('cursor');
  });

  it('two-point drag with stay stays armed', () => {
    const r = run(prefs({ tool: 'trend', stay: true }), [down(pt(0, 0)), up(pt(10, 10))]);
    expect(r.commits).toHaveLength(1);
    expect(r.prefs.tool).toBe('trend');
  });

  it('magnet snaps the first anchor and records its trace', () => {
    const snap = { t: 1111, v: 7, axisId: 'axis-2', traceId: 'trace-3' };
    const r = run(prefs({ tool: 'trend', magnet: true }), [
      down(pt(0, 0, { snap })),
      up(pt(40, 20, { axisId: 'axis-2' })),
    ]);
    const a = r.commits[0].commit!.fn([])[0];
    expect(a.points[0]).toEqual({ t: 1111, v: 7 });
    expect(a.traceId).toBe('trace-3');
    expect(a.axisId).toBe('axis-2');
  });

  it('labels: measure and range', () => {
    const m = run(prefs({ tool: 'measure' }), [down(pt(0, 0)), up(pt(10, 10))]);
    expect(m.commits[0].commit!.label).toBe('Draw Measure');
    const t = run(prefs({ tool: 'trange' }), [down(pt(0, 0)), up(pt(10, 10))]);
    expect(t.commits[0].commit!.label).toBe('Draw Range');
  });
});

describe('cursor mode: select, move, handle', () => {
  const body = (a: Annotation) => ({ kind: 'body' as const, annotation: a });
  const handle = (a: Annotation, index: number) => ({
    kind: 'handle' as const,
    annotation: a,
    index,
  });

  it('a click on a drawing selects it and commits nothing', () => {
    const a = ann();
    const r = run(prefs(), [down(pt(0, 0), body(a)), up(pt(0, 0))]);
    expect(r.results[0].select).toBe(a.id);
    expect(r.commits).toHaveLength(0);
    expect(r.gesture).toEqual({});
  });

  it('movement within 3 px is still a click', () => {
    const a = ann();
    const r = run(prefs(), [down(pt(0, 0), body(a)), move(pt(2, 2)), up(pt(2, 2))]);
    expect(r.commits).toHaveLength(0);
    expect(r.results[1].gesture.draft).toBeUndefined();
  });

  it('a move drag translates every point and commits exactly once', () => {
    const a = ann();
    const r = run(prefs(), [
      down(pt(0, 0), body(a)),
      move(pt(5, 0)),
      move(pt(8, 2)),
      move(pt(10, 4)),
      up(pt(10, 4)),
    ]);
    expect(r.commits).toHaveLength(1);
    expect(r.results[3].gesture.draft?.points).toEqual([
      { t: 1100, v: 8 },
      { t: 2100, v: 18 },
    ]);
    const next = r.commits[0].commit!.fn([ann({ id: 'other' }), a]);
    expect(next[0].id).toBe('other');
    expect(next[1]).toEqual({
      ...a,
      points: [
        { t: 1100, v: 8 },
        { t: 2100, v: 18 },
      ],
    });
    expect(r.commits[0].commit!.label).toBe('Move Trend');
    expect(r.prefs.tool).toBe('cursor');
  });

  it('move commit leaves the list untouched when the drawing is gone', () => {
    const a = ann();
    const r = run(prefs(), [down(pt(0, 0), body(a)), move(pt(20, 0)), up(pt(20, 0))]);
    const list = [ann({ id: 'x' })];
    expect(r.commits[0].commit!.fn(list)).toBe(list);
  });

  it('a handle drag moves only that point', () => {
    const a = ann();
    const r = run(prefs(), [
      down(pt(100, 160), handle(a, 1)),
      move(pt(110, 150)),
      up(pt(110, 150)),
    ]);
    expect(r.commits).toHaveLength(1);
    const next = r.commits[0].commit!.fn([a])[0];
    expect(next.points).toEqual([
      { t: 1000, v: 10 },
      { t: 2100, v: 25 },
    ]);
    expect(r.commits[0].commit!.label).toBe('Edit Trend');
  });

  it('a handle drag snaps with magnet', () => {
    const a = ann();
    const snap = { t: 3000, v: 33, axisId: AXIS, traceId: 't' };
    const r = run(prefs({ magnet: true }), [
      down(pt(100, 160), handle(a, 1)),
      move(pt(110, 150, { snap })),
      up(pt(110, 150, { snap })),
    ]);
    expect(r.commits[0].commit!.fn([a])[0].points[1]).toEqual({ t: 3000, v: 33 });
  });

  it('zero movement on a handle commits nothing', () => {
    const a = ann();
    const r = run(prefs(), [down(pt(0, 0), handle(a, 0)), up(pt(0, 0))]);
    expect(r.commits).toHaveLength(0);
  });

  it('locked drawings select but refuse move and handle', () => {
    const a = ann({ locked: true });
    for (const hit of [body(a), handle(a, 0)]) {
      const r = run(prefs(), [down(pt(0, 0), hit), move(pt(40, 40)), up(pt(40, 40))]);
      expect(r.results[0].select).toBe(a.id);
      expect(r.commits).toHaveLength(0);
      expect(r.results.every((x) => x.gesture.draft === undefined)).toBe(true);
    }
  });

  it('hidden drawings are not hit', () => {
    const a = ann({ hidden: true });
    const r = run(prefs(), [down(pt(0, 0), body(a)), move(pt(40, 40)), up(pt(40, 40))]);
    expect(r.results[0].select).toBeUndefined();
    expect(r.commits).toHaveLength(0);
    expect(r.gesture).toEqual({});
  });

  it('an empty click in cursor mode does nothing (never deselects)', () => {
    const r = reduceToolsIn(TRACE_TOOLS, prefs(), {}, down(pt(0, 0)));
    expect(r.select).toBeUndefined();
    expect(r.gesture).toEqual({});
  });

  it('pointerMove / pointerUp with no gesture are no-ops that keep identity', () => {
    const g: GestureState = {};
    expect(reduceToolsIn(TRACE_TOOLS, prefs(), g, move(pt(1, 1))).gesture).toBe(g);
    const r = reduceToolsIn(TRACE_TOOLS, prefs(), g, up(pt(1, 1)));
    expect(r.gesture).toBe(g);
    expect(r.commit).toBeUndefined();
  });

  it('with a tool armed, a press on a drawing creates instead of moving', () => {
    const a = ann();
    const r = run(prefs({ tool: 'hline' }), [down(pt(0, 0), body(a)), up(pt(0, 0))]);
    expect(r.commits).toHaveLength(1);
    expect(r.commits[0].commit!.fn([a])).toHaveLength(2);
  });
});

describe('shift-drag measure', () => {
  it('renders a measure draft and never commits', () => {
    const r = run(prefs(), [down(pt(0, 0), NO_HIT, true), move(pt(30, 10)), move(pt(50, 20))]);
    expect(r.gesture.draft?.kind).toBe('measure');
    expect(r.gesture.draft?.points).toEqual([
      { t: 1000, v: 100 },
      { t: 1500, v: 90 },
    ]);
    const end = reduceToolsIn(TRACE_TOOLS, r.prefs, r.gesture, up(pt(50, 20)));
    expect(end.commit).toBeUndefined();
    expect(end.gesture).toEqual({});
    expect(end.prefs).toBeUndefined();
  });

  it('is one-shot: tool and stay are untouched', () => {
    const r = run(prefs({ stay: true }), [
      down(pt(0, 0), NO_HIT, true),
      move(pt(30, 10)),
      up(pt(30, 10)),
    ]);
    expect(r.prefs).toEqual(prefs({ stay: true }));
    expect(r.commits).toHaveLength(0);
  });

  it('shift on a drawing in cursor mode still measures, not moves', () => {
    const a = ann();
    const r = run(prefs(), [
      down(pt(0, 0), { kind: 'body', annotation: a }, true),
      move(pt(30, 0)),
    ]);
    expect(r.gesture.draft?.kind).toBe('measure');
  });
});

describe('Esc ladder (cancel)', () => {
  it('cancels a pending draw first, consumed, tool stays armed', () => {
    const g = run(prefs({ tool: 'trend' }), [down(pt(0, 0)), up(pt(0, 0))]).gesture;
    const r = reduceToolsIn(TRACE_TOOLS, prefs({ tool: 'trend' }), g, { type: 'cancel' });
    expect(r).toEqual({ gesture: {}, consumed: true });
  });

  it('cancels a live create drag without committing', () => {
    const r = run(prefs({ tool: 'trend' }), [
      down(pt(0, 0)),
      move(pt(40, 40)),
      { type: 'cancel' },
      up(pt(40, 40)),
    ]);
    expect(r.results[2].consumed).toBe(true);
    expect(r.commits).toHaveLength(0);
    expect(r.prefs.tool).toBe('trend');
  });

  it('cancels a live move drag without committing', () => {
    const a = ann();
    const r = run(prefs(), [
      down(pt(0, 0), { kind: 'body', annotation: a }),
      move(pt(40, 40)),
      { type: 'cancel' },
      up(pt(40, 40)),
    ]);
    expect(r.results[2].consumed).toBe(true);
    expect(r.commits).toHaveLength(0);
  });

  it('then disarms the tool, consumed', () => {
    const r = reduceToolsIn(TRACE_TOOLS, prefs({ tool: 'box' }), {}, { type: 'cancel' });
    expect(r.prefs).toEqual({ tool: 'cursor' });
    expect(r.consumed).toBe(true);
  });

  it('with nothing to cancel or disarm: not consumed, never deselects', () => {
    const g: GestureState = {};
    const r = reduceToolsIn(TRACE_TOOLS, prefs(), g, { type: 'cancel' });
    expect(r.consumed).toBeFalsy();
    expect(r.select).toBeUndefined();
    expect(r.prefs).toBeUndefined();
    expect(r.gesture).toBe(g);
  });

  it('the full ladder: pending, then tool, then pass-through', () => {
    const r = run(prefs({ tool: 'trend' }), [
      down(pt(0, 0)),
      up(pt(0, 0)),
      { type: 'cancel' },
      { type: 'cancel' },
      { type: 'cancel' },
    ]);
    expect(r.results.slice(2).map((x) => !!x.consumed)).toEqual([true, true, false]);
    expect(r.prefs.tool).toBe('cursor');
  });
});

describe('keyDelete', () => {
  it('removes the selected drawing, deselects, consumed', () => {
    const a = ann();
    const r = reduceToolsIn(TRACE_TOOLS, prefs(), {}, { type: 'keyDelete', target: a });
    expect(r.consumed).toBe(true);
    expect(r.select).toBeNull();
    expect(r.commit!.label).toBe('Delete Trend');
    const other = ann({ id: 'other' });
    expect(r.commit!.fn([other, a])).toEqual([other]);
    const list = [other];
    expect(r.commit!.fn(list)).toBe(list);
  });

  it('refuses a locked drawing and does nothing without a target', () => {
    for (const target of [ann({ locked: true }), null]) {
      const r = reduceToolsIn(TRACE_TOOLS, prefs(), {}, { type: 'keyDelete', target });
      expect(r.commit).toBeUndefined();
      expect(r.consumed).toBeFalsy();
      expect(r.select).toBeUndefined();
    }
  });

  it('is ignored while a gesture is live', () => {
    const g = run(prefs({ tool: 'trend' }), [down(pt(0, 0))]).gesture;
    const r = reduceToolsIn(TRACE_TOOLS, prefs({ tool: 'trend' }), g, {
      type: 'keyDelete',
      target: ann(),
    });
    expect(r.commit).toBeUndefined();
    expect(r.gesture).toBe(g);
  });
});

describe('reduceToolsIn (kind-agnostic)', () => {
  // A test-only tool: 1-point, zeroes v, typed text, its own short label.
  const PIN: DrawingTool = {
    ...BUILTIN_TOOLS.find((t) => t.kind === 'note')!,
    kind: 'pin',
    code: 901,
    label: { long: 'Pin marker', short: 'Pin' },
    key: undefined,
    menuAdd: undefined,
    shapePoint: (p) => ({ t: p.t, v: 0 }),
  };
  const WITHOUT_MEASURE = BUILTIN_TOOLS.filter((t) => t.kind !== 'measure');
  const ctxOf = (tools: readonly DrawingTool[], xAxis = TIME_X_AXIS): ToolsContext => ({
    catalog: makeCatalog(tools),
    xAxis,
  });

  function runIn(ctx: ToolsContext, start: AnnotationToolPrefs, events: ToolEvent[]) {
    let p = start;
    let g: GestureState = {};
    const results: ToolsResult[] = [];
    for (const e of events) {
      const r = reduceToolsIn(ctx, p, g, e);
      results.push(r);
      g = r.gesture;
      if (r.prefs) p = { ...p, ...r.prefs };
    }
    return { gesture: g, results, commits: results.filter((r) => r.commit) };
  }

  it('creates a catalog tool by its definition: shape, label, inline text', () => {
    const ctx = ctxOf([...WITHOUT_MEASURE, PIN]);
    const r = runIn(ctx, prefs({ tool: 'pin' }), [down(pt(0, 0)), up(pt(0, 0))]);
    expect(r.commits).toHaveLength(1);
    const res = r.commits[0];
    expect(res.commit!.label).toBe('Draw Pin');
    const [drawn] = res.commit!.fn([]);
    expect(drawn.kind).toBe('pin');
    expect(drawn.points).toEqual([{ t: 1000, v: 0 }]);
    expect(res.edit).toBe(drawn.id);
  });

  it('moves and deletes with the catalog short label', () => {
    const ctx = ctxOf([...WITHOUT_MEASURE, PIN]);
    const a = ann({ kind: 'pin', points: [{ t: 1000, v: 0 }] });
    const r = runIn(ctx, prefs(), [
      down(pt(0, 0), { kind: 'body', annotation: a }),
      move(pt(20, 0)),
      up(pt(20, 0)),
    ]);
    expect(r.commits[0].commit!.label).toBe('Move Pin');
    const del = reduceToolsIn(ctx, prefs(), {}, { type: 'keyDelete', target: a });
    expect(del.commit!.label).toBe('Delete Pin');
  });

  it("drives shift-drag from the tool whose modifierGesture is 'shift', in mode 'modifier'", () => {
    const r = runIn(ctxOf(BUILTIN_TOOLS), prefs(), [
      down(pt(0, 0), NO_HIT, true),
      move(pt(30, 10)),
    ]);
    expect(r.gesture.drag?.mode).toBe('modifier');
    expect(r.gesture.draft?.kind).toBe('measure');
  });

  it('without a modifier tool, shift-press on a drawing selects and moves it', () => {
    const a = ann();
    const r = runIn(ctxOf(WITHOUT_MEASURE), prefs(), [
      down(pt(0, 0), { kind: 'body', annotation: a }, true),
      move(pt(30, 0)),
    ]);
    expect(r.results[0].select).toBe(a.id);
    expect(r.gesture.drag?.mode).toBe('move');
  });

  it('quantizes committed x through ctx.xAxis with the point pxStep', () => {
    const value = (x: number): ToolPoint => ({
      x,
      y: 0,
      t: 1.234567 + x * 0.01,
      v: 5,
      axisId: AXIS,
      pxStep: 0.01,
    });
    const onValue = runIn(ctxOf(BUILTIN_TOOLS, VALUE_X_AXIS), prefs({ tool: 'vline' }), [
      down(value(0)),
      up(value(0)),
    ]);
    // pxStep 0.01 -> x rounded to 0.001 on a value axis.
    expect(onValue.commits[0].commit!.fn([])[0].points).toEqual([{ t: 1.235, v: 0 }]);
    const onTime = runIn(ctxOf(BUILTIN_TOOLS), prefs({ tool: 'vline' }), [
      down(value(0)),
      up(value(0)),
    ]);
    expect(onTime.commits[0].commit!.fn([])[0].points).toEqual([{ t: 1, v: 0 }]);
  });
});
