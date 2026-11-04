// edit.ts is the one writer of the correlation state. These tests pin
// its role moves, the in-commit add checks and
// the state cases ported from PvPicker.test.tsx.

import { describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../annotations/model';
import {
  addDrawing,
  addMetric,
  addPv,
  apply,
  metricsFullMessage,
  moveMetric,
  patchMetric,
  removeMetric,
  resetMetrics,
  setMetrics,
  moveRefusal,
  movePv,
  patchDrawing,
  removeDrawing,
  removePv,
  setColor,
  setFire,
  setHidden,
  setLabel,
  setMarker,
  setTimer,
} from './edit';
import {
  defaultCorrelationState,
  MAX_Y,
  normalizeCorrelationState,
  type CorrelationState,
} from './query';
import { CORRELATION_METRICS } from './metrics';
import { MAX_METRICS, defaultMetrics, type Metric } from '../../statistics/model';

const X = 'SIM:BPM01:X';
const Y1 = 'SIM:BPM02:X';
const Y2 = 'SIM:BPM03:X';
const Y3 = 'SIM:BPM04:X';
const T = 'SIM:TIMING:TRIG';

function state(over: Partial<CorrelationState> = {}): CorrelationState {
  return normalizeCorrelationState({ ...defaultCorrelationState(), ...over });
}

function fullYs(): string[] {
  return Array.from({ length: MAX_Y }, (_, i) => `SIM:BPM1${i}:Y`);
}

describe('apply', () => {
  it('ends every edit in the normalizer', () => {
    const next = apply(state(), (s) => ({ ...s, ys: [' a ', 'a', 'b'], dy: 'zz' }));
    expect(next.ys).toEqual(['a', 'b']);
    expect(next.dy).toBe('');
  });

  it('is idempotent on a canonical state', () => {
    const s = state({ x: X, ys: [Y1], labels: { [Y1]: 'one' } });
    expect(apply(s, (v) => v)).toEqual(s);
  });
});

describe('addPv', () => {
  it('appends a Y in colour order', () => {
    const r = addPv(state({ ys: [Y1] }), 'y', Y2);
    expect(r.refusal).toBeUndefined();
    expect(r.state.ys).toEqual([Y1, Y2]);
  });

  it('refuses a Y when Y is full instead of truncating', () => {
    const before = state({ ys: fullYs() });
    const r = addPv(before, 'y', Y1);
    expect(r.refusal).toBe(`Y is full (${MAX_Y}/${MAX_Y})`);
    expect(r.state).toBe(before);
  });

  it('refuses a duplicate Y', () => {
    const before = state({ ys: [Y1] });
    const r = addPv(before, 'y', ` ${Y1} `);
    expect(r.refusal).toBe(`${Y1} is already a Y`);
    expect(r.state).toBe(before);
  });

  it('allows a Y that is also the X', () => {
    const r = addPv(state({ x: X }), 'y', X);
    expect(r.refusal).toBeUndefined();
    expect(r.state.ys).toEqual([X]);
  });

  it('refuses a Y in another unit than the axis', () => {
    const before = state({ ys: [Y1] });
    const r = addPv(before, 'y', Y2, { units: 'mA', axisUnit: 'mm' });
    expect(r.refusal).toBe(`${Y2} is in mA; Y axis is mm. Open a new correlation tab (+) for it.`);
    expect(r.state).toBe(before);
  });

  it('accepts a Y in the axis unit, without units, or with no axis unit yet', () => {
    expect(addPv(state({ ys: [Y1] }), 'y', Y2, { units: 'mm', axisUnit: 'mm' }).refusal).toBe(
      undefined
    );
    expect(addPv(state({ ys: [Y1] }), 'y', Y2, { units: '', axisUnit: 'mm' }).refusal).toBe(
      undefined
    );
    expect(addPv(state({ ys: [Y1] }), 'y', Y2, { units: 'mA', axisUnit: null }).refusal).toBe(
      undefined
    );
  });

  it('ignores the axis unit once no Y is left to hold it', () => {
    const r = addPv(state(), 'y', Y2, { units: 'mA', axisUnit: 'mm' });
    expect(r.refusal).toBeUndefined();
    expect(r.state.ys).toEqual([Y2]);
  });

  it('checks against the state it is given (the latest), not a stale one', () => {
    // Two adds probed against the same earlier state commit in turn.
    let latest = state({ ys: fullYs().slice(0, MAX_Y - 1) });
    const first = addPv(latest, 'y', Y1);
    latest = first.state;
    const second = addPv(latest, 'y', Y2);
    expect(first.refusal).toBeUndefined();
    expect(second.refusal).toBe(`Y is full (${MAX_Y}/${MAX_Y})`);
    expect(latest.ys).toHaveLength(MAX_Y);
  });

  it('takes an X only while there is none', () => {
    const r = addPv(state({ ys: [Y1] }), 'x', X);
    expect(r.state.x).toBe(X);
    const again = addPv(r.state, 'x', Y3);
    expect(again.refusal).toBe('X is full (1/1)');
    expect(again.state.x).toBe(X);
  });

  it('a typed trigger PV switches to Trigger PV mode', () => {
    const r = addPv(state({ x: X, ys: [Y1] }), 'trig', Y3);
    expect(r.refusal).toBeUndefined();
    expect(r.state.trigger).toEqual({ mode: 'pv', pv: Y3 });
  });

  it('refuses a second trigger PV', () => {
    const r = addPv(state({ trigger: { mode: 'pv', pv: T } }), 'trig', Y3);
    expect(r.refusal).toBe('Trigger is full (1/1)');
    expect(r.state.trigger).toEqual({ mode: 'pv', pv: T });
  });

  it('adds nothing for an empty name', () => {
    const before = state();
    const r = addPv(before, 'y', '   ');
    expect(r.state).toBe(before);
    expect(r.refusal).toBeUndefined();
  });
});

describe('removePv', () => {
  it('removing the X empties it', () => {
    expect(removePv(state({ x: X, ys: [Y1] }), 'x', X).x).toBe('');
  });

  it('removing the trigger PV returns to Timer 1 s', () => {
    const next = removePv(state({ trigger: { mode: 'pv', pv: T }, fire: 'rising' }), 'trig', T);
    expect(next.trigger).toEqual({ mode: 'timer', dtS: 1 });
    expect(next.fire).toBeUndefined();
  });

  it('removing a Y clears a density Y on it and its records', () => {
    const next = removePv(
      state({ x: X, ys: [Y1, Y2], dy: Y2, colors: { [Y2]: '#f00' }, labels: { [Y2]: 'two' } }),
      'y',
      Y2
    );
    expect(next.ys).toEqual([Y1]);
    expect(next.dy).toBe('');
    expect(next.colors).toEqual({});
    expect(next.labels).toEqual({});
  });

  it('removing a PV not in that role changes nothing', () => {
    const before = state({ x: X });
    expect(removePv(before, 'x', Y1)).toEqual(before);
  });
});

describe('trigger source', () => {
  it('choosing Timer drops the trigger PV', () => {
    const next = setTimer(state({ x: X, ys: [Y1], trigger: { mode: 'pv', pv: T } }));
    expect(next.trigger).toEqual({ mode: 'timer', dtS: 1 });
  });

  it('choosing Timer keeps a timer interval already set', () => {
    expect(setTimer(state({ trigger: { mode: 'timer', dtS: 5 } })).trigger).toEqual({
      mode: 'timer',
      dtS: 5,
    });
  });

  it('Fire on is kept only in PV mode', () => {
    expect(setFire(state({ trigger: { mode: 'pv', pv: T } }), 'rising').fire).toBe('rising');
    expect(setFire(state(), 'rising').fire).toBeUndefined();
    expect(
      setFire(state({ trigger: { mode: 'pv', pv: T }, fire: 'falling' }), undefined).fire
    ).toBeUndefined();
  });
});

describe('movePv', () => {
  it('Y to an empty X', () => {
    const next = movePv(state({ ys: [Y1, Y2] }), 'y', Y1, 'x').state;
    expect(next.x).toBe(Y1);
    expect(next.ys).toEqual([Y2]);
  });

  it('Y to an occupied X swaps the X into the Y slot', () => {
    const next = movePv(state({ x: X, ys: [Y1, Y2, Y3] }), 'y', Y2, 'x').state;
    expect(next.x).toBe(Y2);
    expect(next.ys).toEqual([Y1, X, Y3]);
  });

  it('X to an occupied Trigger swaps them', () => {
    const next = movePv(
      state({ x: X, ys: [Y1], trigger: { mode: 'pv', pv: T } }),
      'x',
      X,
      'trig'
    ).state;
    expect(next.x).toBe(T);
    expect(next.trigger).toEqual({ mode: 'pv', pv: X });
  });

  it('moving to Trigger replaces the timer', () => {
    const next = movePv(
      state({ x: X, ys: [Y1, Y2], trigger: { mode: 'timer', dtS: 3 } }),
      'y',
      Y2,
      'trig'
    ).state;
    expect(next.trigger).toEqual({ mode: 'pv', pv: Y2 });
    expect(next.ys).toEqual([Y1]);
  });

  it('Y to an occupied Trigger swaps the trigger PV into the Y slot', () => {
    const next = movePv(
      state({ ys: [Y1, Y2], trigger: { mode: 'pv', pv: T } }),
      'y',
      Y1,
      'trig'
    ).state;
    expect(next.trigger).toEqual({ mode: 'pv', pv: Y1 });
    expect(next.ys).toEqual([T, Y2]);
  });

  it('Trigger to Y returns the trigger to Timer and appends the Y', () => {
    const next = movePv(
      state({ ys: [Y1], trigger: { mode: 'pv', pv: T }, fire: 'rising' }),
      'trig',
      T,
      'y'
    ).state;
    expect(next.ys).toEqual([Y1, T]);
    expect(next.trigger).toEqual({ mode: 'timer', dtS: 1 });
    expect(next.fire).toBeUndefined();
  });

  it('X to Y empties the X', () => {
    const next = movePv(state({ x: X, ys: [Y1] }), 'x', X, 'y').state;
    expect(next.x).toBe('');
    expect(next.ys).toEqual([Y1, X]);
  });

  it('refuses only when Y is full', () => {
    const before = state({ x: X, ys: fullYs(), trigger: { mode: 'pv', pv: T } });
    expect(moveRefusal(before, 'x', X, 'y')).toBe(`Y is full (${MAX_Y}/${MAX_Y})`);
    expect(moveRefusal(before, 'trig', T, 'y')).toBe(`Y is full (${MAX_Y}/${MAX_Y})`);
    const r = movePv(before, 'x', X, 'y');
    expect(r.refusal).toBe(`Y is full (${MAX_Y}/${MAX_Y})`);
    expect(r.state).toBe(before);
    // Moves into the single-slot roles never refuse, even with Y full.
    expect(moveRefusal(before, 'y', fullYs()[0], 'x')).toBeUndefined();
    expect(moveRefusal(before, 'y', fullYs()[0], 'trig')).toBeUndefined();
    expect(moveRefusal(before, 'x', X, 'trig')).toBeUndefined();
  });

  it('a Y-to-X swap with Y full keeps every PV', () => {
    const ys = fullYs();
    const next = movePv(state({ x: X, ys }), 'y', ys[3], 'x').state;
    expect(next.x).toBe(ys[3]);
    expect(next.ys).toHaveLength(MAX_Y);
    expect(next.ys[3]).toBe(X);
  });

  it('carries the label: Y label becomes the X title and back', () => {
    const toX = movePv(
      state({ x: X, ys: [Y1], labels: { [Y1]: 'Beam', [X]: 'Pos' } }),
      'y',
      Y1,
      'x'
    ).state;
    expect(toX.x).toBe(Y1);
    expect(toX.labels).toEqual({ [Y1]: 'Beam', [X]: 'Pos' });
    const back = movePv(toX, 'x', Y1, 'y').state;
    expect(back.labels[Y1]).toBe('Beam');
  });

  it('drops colour, visibility and markers when the PV leaves Y', () => {
    const next = movePv(
      state({
        ys: [Y1, Y2],
        colors: { [Y1]: '#f00', [Y2]: '#0f0' },
        hidden: { [Y1]: true },
        markers: { [Y1]: { size: 9 } },
      }),
      'y',
      Y1,
      'x'
    ).state;
    expect(next.colors).toEqual({ [Y2]: '#0f0' });
    expect(next.hidden).toEqual({});
    expect(next.markers).toEqual({});
  });

  it('a label does not survive on the Trigger', () => {
    const next = movePv(state({ ys: [Y1], labels: { [Y1]: 'Beam' } }), 'y', Y1, 'trig').state;
    expect(next.labels).toEqual({});
  });

  it('moving to the same role, or a PV not in the source role, changes nothing', () => {
    const before = state({ x: X, ys: [Y1] });
    expect(movePv(before, 'y', Y1, 'y').state).toBe(before);
    expect(movePv(before, 'y', Y2, 'x').state).toBe(before);
    expect(moveRefusal(before, 'y', Y2, 'x')).toBeUndefined();
  });
});

describe('per-PV records', () => {
  it('setLabel pins and unpins a Y label and the X title', () => {
    let s = state({ x: X, ys: [Y1] });
    s = setLabel(s, Y1, 'Beam');
    s = setLabel(s, X, 'Pos');
    expect(s.labels).toEqual({ [X]: 'Pos', [Y1]: 'Beam' });
    s = setLabel(s, Y1, undefined);
    expect(s.labels).toEqual({ [X]: 'Pos' });
  });

  it('setLabel on the Trigger writes nothing', () => {
    expect(setLabel(state({ trigger: { mode: 'pv', pv: T } }), T, 'trig').labels).toEqual({});
  });

  it('setColor pins and resets a Y colour', () => {
    let s = setColor(state({ ys: [Y1] }), Y1, '#123456');
    expect(s.colors).toEqual({ [Y1]: '#123456' });
    s = setColor(s, Y1, undefined);
    expect(s.colors).toEqual({});
  });

  it('setHidden toggles a Y', () => {
    let s = setHidden(state({ ys: [Y1] }), Y1, true);
    expect(s.hidden).toEqual({ [Y1]: true });
    s = setHidden(s, Y1, false);
    expect(s.hidden).toEqual({});
  });

  it('setMarker merges fields and drops the record when empty', () => {
    let s = setMarker(state({ ys: [Y1] }), Y1, { shape: 'diamond' });
    s = setMarker(s, Y1, { size: 99 });
    expect(s.markers).toEqual({ [Y1]: { shape: 'diamond', size: 40 } });
    s = setMarker(s, Y1, undefined);
    expect(s.markers).toEqual({});
  });
});

describe('metric writers', () => {
  const ids = (s: CorrelationState) => s.metrics.map((m) => m.id);
  const custom = (id: string, label = id): Metric => ({
    id,
    label,
    expr: 'mean(y)',
    unit: '',
    on: true,
    strip: false,
  });

  it('setMetrics replaces the list through the normalizer', () => {
    const s = setMetrics(state(), [
      custom('c2'),
      custom('c2', 'dup'),
      defaultMetrics(CORRELATION_METRICS)[3],
    ]);
    expect(ids(s)).toEqual(['c2', 'r']);
    expect(s.metrics[0].label).toBe('c2');
  });

  it('addMetric appends an on custom named after the custom count', () => {
    const r = addMetric(
      setMetrics(state(), [defaultMetrics(CORRELATION_METRICS)[0], custom('c1')])
    );
    expect(r.refusal).toBeUndefined();
    expect(r.id).toBe('c2');
    expect(r.state.metrics[2]).toEqual({
      id: 'c2',
      label: 'Metric 2',
      expr: '',
      unit: '',
      on: true,
      strip: false,
    });
  });

  it('addMetric takes label, expression and unit from init', () => {
    const r = addMetric(state(), { label: 'Ratio', expr: 'mean(y) / mean(x)', unit: 'y/x' });
    expect(r.id).toBe('c1');
    expect(r.state.metrics.at(-1)).toMatchObject({
      id: 'c1',
      label: 'Ratio',
      expr: 'mean(y) / mean(x)',
      unit: 'y/x',
    });
  });

  it(`addMetric refuses a full list (${MAX_METRICS})`, () => {
    let s = state();
    while (s.metrics.length < MAX_METRICS) s = addMetric(s).state;
    const r = addMetric(s);
    expect(r.refusal).toBe(metricsFullMessage());
    expect(metricsFullMessage()).toBe(`Metrics are full (${MAX_METRICS}/${MAX_METRICS})`);
    expect(r.state).toBe(s);
    expect(r.id).toBeUndefined();
  });

  it('never reuses a live id after a remove: the next id is max + 1', () => {
    let s = setMetrics(state(), []);
    s = addMetric(s).state;
    s = addMetric(s).state;
    s = addMetric(s).state;
    expect(ids(s)).toEqual(['c1', 'c2', 'c3']);
    s = removeMetric(s, 'c2');
    expect(addMetric(s).id).toBe('c4');
    s = removeMetric(s, 'c3');
    expect(addMetric(s).id).toBe('c2');
  });

  it('removeMetric of an unknown id changes nothing', () => {
    const s = state();
    expect(removeMetric(s, 'c9')).toBe(s);
    expect(ids(removeMetric(s, 'mean'))).not.toContain('mean');
  });

  it('patchMetric changes a custom and leaves an unknown id alone', () => {
    let s = addMetric(state()).state;
    s = patchMetric(s, 'c1', { label: 'Spread', expr: 'std(y)', unit: 'y', strip: true });
    expect(s.metrics.at(-1)).toEqual({
      id: 'c1',
      label: 'Spread',
      expr: 'std(y)',
      unit: 'y',
      on: true,
      strip: true,
    });
    expect(patchMetric(s, 'c9', { on: false })).toBe(s);
  });

  it("patchMetric keeps a preset's on/strip and drops its label, expr and unit", () => {
    const s = patchMetric(state(), 'r', {
      on: false,
      strip: true,
      label: 'x',
      expr: 'n',
      unit: 'y',
    });
    expect(s.metrics.find((m) => m.id === 'r')).toEqual({
      id: 'r',
      label: 'r',
      expr: 'corr(x, y)',
      unit: '',
      on: false,
      strip: true,
    });
  });

  it('moveMetric swaps one place and is a no-op at the ends', () => {
    const s = setMetrics(state(), defaultMetrics(CORRELATION_METRICS).slice(0, 3));
    expect(ids(moveMetric(s, 'mean', -1))).toEqual(['mean', 'n', 'std']);
    expect(ids(moveMetric(s, 'mean', 1))).toEqual(['n', 'std', 'mean']);
    expect(moveMetric(s, 'n', -1)).toBe(s);
    expect(moveMetric(s, 'std', 1)).toBe(s);
    expect(moveMetric(s, 'c1', 1)).toBe(s);
  });

  it('resetMetrics restores the default list', () => {
    const s = addMetric(setMetrics(state(), [])).state;
    expect(resetMetrics(s).metrics).toEqual(defaultMetrics(CORRELATION_METRICS));
  });
});

describe('drawings', () => {
  const line = (id: string, over: Partial<Annotation> = {}): Annotation => ({
    id,
    kind: 'hline',
    points: [{ t: 0, v: 1 }],
    axisId: Y1,
    color: '#123456',
    width: 1.5,
    text: '',
    ...over,
  });
  const FIELDS = Object.keys(state()) as (keyof CorrelationState)[];
  const rich = () =>
    state({
      x: X,
      ys: [Y1, Y2],
      labels: { [Y1]: 'one' },
      colors: { [Y2]: '#ff0000' },
      hidden: { [Y2]: true },
      markers: { [Y1]: { size: 9 } },
      trigger: { mode: 'pv', pv: T },
      fire: 'rising',
      xScale: { log: true },
      drawings: [line('a'), line('b', { axisId: Y2 })],
    });

  it("a drawing commit keeps every other field's reference", () => {
    const s = rich();
    const commits: CorrelationState[] = [
      addDrawing(s, line('c')),
      patchDrawing(s, 'a', { color: '#abcdef' }),
      removeDrawing(s, 'b'),
    ];
    for (const next of commits) {
      expect(next.drawings).not.toBe(s.drawings);
      for (const key of FIELDS) {
        if (key !== 'drawings') expect(next[key], key).toBe(s[key]);
      }
      expect(next.fire).toBe(s.fire);
      expect(next.xScale).toBe(s.xScale);
    }
    // An unchanged element keeps its reference too.
    const patched = patchDrawing(s, 'a', { color: '#abcdef' });
    expect(patched.drawings[1]).toBe(s.drawings[1]);
    expect(patched.drawings[0]).toMatchObject({ id: 'a', color: '#abcdef' });
  });

  it("a settings edit keeps drawings' reference", () => {
    const s = rich();
    const edits: CorrelationState[] = [
      setLabel(s, Y2, 'two'),
      setColor(s, Y1, '#00ff00'),
      setHidden(s, Y1, true),
      setMarker(s, Y2, { shape: 'diamond' }),
      setFire(s, 'falling'),
      setTimer(s),
      removePv(s, 'y', Y2),
      addPv(s, 'y', Y3).state,
      apply(s, (v) => ({ ...v, n: 50, view: 'density' })),
    ];
    for (const next of edits) {
      expect(next).not.toEqual(s);
      expect(next.drawings).toBe(s.drawings);
    }
  });

  it('removing a Y keeps its drawings', () => {
    const s = removePv(rich(), 'y', Y2);
    expect(s.ys).toEqual([Y1]);
    expect(s.drawings.map((a) => a.axisId)).toEqual([Y1, Y2]);
  });

  it('adds a drawing at the end, and refuses a kind the catalog lacks', () => {
    const s = rich();
    expect(addDrawing(s, line('c')).drawings.map((a) => a.id)).toEqual(['a', 'b', 'c']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(addDrawing(s, line('d', { kind: 'trange' })).drawings).toBe(s.drawings);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('patch merges fields, removes a key given as undefined, and keeps the id', () => {
    const s = state({ drawings: [line('a', { traceId: Y1, dash: true })] });
    const next = patchDrawing(s, 'a', { traceId: undefined, text: 'floor' });
    expect(next.drawings[0]).toEqual({
      id: 'a',
      kind: 'hline',
      points: [{ t: 0, v: 1 }],
      axisId: Y1,
      color: '#123456',
      width: 1.5,
      text: 'floor',
      dash: true,
    });
  });

  it('an unknown id or a no-op patch returns the state itself', () => {
    const s = rich();
    expect(patchDrawing(s, 'zz', { text: 'x' })).toBe(s);
    expect(patchDrawing(s, 'a', { color: '#123456', traceId: undefined })).toBe(s);
    expect(removeDrawing(s, 'zz')).toBe(s);
  });
});

describe('apply: references against the state before the edit', () => {
  it('a rebuilt but equal drawings list keeps the previous one', () => {
    const s = state({
      drawings: [
        {
          id: 'a',
          kind: 'hline',
          points: [{ t: 0, v: 1 }],
          axisId: Y1,
          color: '#123456',
          width: 1.5,
          text: '',
        },
      ],
    });
    const next = apply(s, (v) => ({ ...v, drawings: v.drawings.map((a) => ({ ...a })), n: 7 }));
    expect(next.drawings).toBe(s.drawings);
    expect(next.n).toBe(7);
  });

  it('a rebuilt but equal record keeps the previous one', () => {
    const s = state({ x: X, ys: [Y1], labels: { [Y1]: 'one' } });
    const next = apply(s, (v) => ({ ...v, labels: { ...v.labels }, ys: [...v.ys] }));
    expect(next.labels).toBe(s.labels);
    expect(next.ys).toBe(s.ys);
  });
});
