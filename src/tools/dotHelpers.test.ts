import { describe, expect, it } from 'vitest';
import type { DotProps, Target, ToolContext } from '../workbench/types';
import { optionalPath, recordKey, stampedValue } from './dotHelpers';

interface Trace {
  id: string;
  pv: string;
  width?: number;
  colour: string;
  slot: number;
}
interface State {
  traces: Trace[];
  ranges?: Record<string, { min: number; max: number }>;
}
type Model = { palette: string[] };

const PALETTE = ['#111111', '#222222', '#333333'];

function harness(initial: State, target: Target) {
  let state = initial;
  let updates = 0;
  const ctx = (): ToolContext<State, Model> => ({
    state,
    model: { palette: PALETTE },
    update(fn) {
      updates += 1;
      state = fn(state);
    },
    selection: null,
    target,
    capabilities: { elog: false },
    ui: {},
  });
  return { ctx, state: () => state, updates: () => updates };
}

const item = (id: string): Target => ({ level: 'item', kind: 'trace', id });
const traceOf = (state: State, id: string) => state.traces.find((t) => t.id === id)!;
const patch = (state: State, id: string, p: Partial<Trace>): State => ({
  ...state,
  traces: state.traces.map((t) => (t.id === id ? { ...t, ...p } : t)),
});

const base = (): State => ({
  traces: [
    { id: 'a', pv: 'PV:A', colour: PALETTE[0], slot: 0 },
    { id: 'b', pv: 'PV:B', width: 3, colour: PALETTE[1], slot: 1 },
  ],
});

describe('optionalPath', () => {
  const dot = optionalPath<State, Model>({
    get: (ctx) => traceOf(ctx.state, ctx.target.id).width,
    set: (state, target, value) => patch(state, target.id, { width: value }),
  });

  it('is pinned iff a value is present', () => {
    expect(dot.modified(harness(base(), item('a')).ctx())).toBe(false);
    expect(dot.modified(harness(base(), item('b')).ctx())).toBe(true);
  });

  it('treats a falsy present value as pinned', () => {
    const h = harness(patch(base(), 'a', { width: 0 }), item('a'));
    expect(dot.modified(h.ctx())).toBe(true);
  });

  it('reset writes undefined at the target and clears the dot', () => {
    const h = harness(base(), item('b'));
    dot.reset(h.ctx());
    expect(h.updates()).toBe(1);
    expect(traceOf(h.state(), 'b').width).toBeUndefined();
    expect('width' in traceOf(h.state(), 'b')).toBe(true);
    expect(traceOf(h.state(), 'a')).toEqual(base().traces[0]);
    expect(dot.modified(h.ctx())).toBe(false);
  });

  it('satisfies DotProps', () => {
    const props: DotProps<State, Model, object> = dot;
    expect(typeof props.modified).toBe('function');
  });
});

describe('recordKey', () => {
  const dot = recordKey<State, Model, object, Record<string, { min: number; max: number }>>({
    record: (state) => state.ranges,
    key: (ctx) => ctx.state.traces.find((t) => t.id === ctx.target.id)?.pv,
    write: (state, ranges) => ({ ...state, ranges }),
  });
  const withRanges = (): State => ({
    ...base(),
    ranges: { 'PV:B': { min: 0, max: 1 }, 'PV:C': { min: 2, max: 3 } },
  });

  it('is pinned iff a per-PV record exists', () => {
    expect(dot.modified(harness(withRanges(), item('a')).ctx())).toBe(false);
    expect(dot.modified(harness(withRanges(), item('b')).ctx())).toBe(true);
  });

  it('is not pinned with no record at all or no key', () => {
    expect(dot.modified(harness(base(), item('b')).ctx())).toBe(false);
    expect(dot.modified(harness(withRanges(), item('missing')).ctx())).toBe(false);
  });

  it('does not count an inherited key as a record', () => {
    const h = harness({ ...base(), ranges: {} }, item('a'));
    const ctx = h.ctx();
    expect(
      recordKey<State, Model>({
        record: (s) => s.ranges,
        key: () => 'toString',
        write: (s) => s,
      }).modified(ctx)
    ).toBe(false);
  });

  it('reset deletes only this key and does not mutate the old state', () => {
    const before = withRanges();
    const h = harness(before, item('b'));
    dot.reset(h.ctx());
    expect(h.state().ranges).toEqual({ 'PV:C': { min: 2, max: 3 } });
    expect(Object.hasOwn(h.state().ranges!, 'PV:B')).toBe(false);
    expect(before.ranges).toHaveProperty('PV:B');
    expect(dot.modified(h.ctx())).toBe(false);
  });

  it('reset with no entry leaves the state untouched', () => {
    const before = withRanges();
    const h = harness(before, item('a'));
    dot.reset(h.ctx());
    expect(h.state()).toBe(before);
  });
});

describe('stampedValue', () => {
  const autoColour = (ctx: ToolContext<State, Model>) =>
    ctx.model.palette[traceOf(ctx.state, ctx.target.id).slot % ctx.model.palette.length];
  const dot = stampedValue<State, Model, string>({
    get: (ctx) => traceOf(ctx.state, ctx.target.id).colour,
    isAutomatic: (value, ctx) => value === autoColour(ctx),
    automatic: autoColour,
    set: (state, target, colour) => patch(state, target.id, { colour }),
  });

  it('is not pinned when the value is the slot automatic value', () => {
    expect(dot.modified(harness(base(), item('a')).ctx())).toBe(false);
    expect(dot.modified(harness(base(), item('b')).ctx())).toBe(false);
  });

  it('is pinned for a value no rule produces', () => {
    const h = harness(patch(base(), 'a', { colour: '#abcdef' }), item('a'));
    expect(dot.modified(h.ctx())).toBe(true);
  });

  it("is pinned when the value equals a different slot's automatic value", () => {
    // b sits in slot 1 but carries slot 0's colour: still a user choice.
    const h = harness(patch(base(), 'b', { colour: PALETTE[0] }), item('b'));
    expect(dot.modified(h.ctx())).toBe(true);
    dot.reset(h.ctx());
    expect(traceOf(h.state(), 'b').colour).toBe(PALETTE[1]);
    expect(traceOf(h.state(), 'a').colour).toBe(PALETTE[0]);
    expect(dot.modified(h.ctx())).toBe(false);
  });

  it('defers to the tool predicate when it accepts several values', () => {
    const lenient = stampedValue<State, Model, string>({
      get: (ctx) => traceOf(ctx.state, ctx.target.id).colour,
      isAutomatic: (value, ctx) => ctx.model.palette.includes(value),
      automatic: autoColour,
      set: (state, target, colour) => patch(state, target.id, { colour }),
    });
    const h = harness(patch(base(), 'b', { colour: PALETTE[0] }), item('b'));
    expect(lenient.modified(h.ctx())).toBe(false);
  });

  it('reset writes the automatic value at the target captured at reset time', () => {
    const h = harness(patch(base(), 'a', { colour: '#abcdef', slot: 2 }), item('a'));
    dot.reset(h.ctx());
    expect(h.updates()).toBe(1);
    expect(traceOf(h.state(), 'a').colour).toBe(PALETTE[2]);
  });
});
