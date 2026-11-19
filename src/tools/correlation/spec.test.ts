import { describe, expect, it } from 'vitest';
import resultEmptyRaw from './__fixtures__/table-result-empty.json?raw';
import resultTriggerRaw from './__fixtures__/table-result-trigger.json?raw';
import maxPointsAbsentRaw from './__fixtures__/table-spec-max-points-absent.json?raw';
import reject0Raw from './__fixtures__/table-spec-reject-max-points-0.json?raw';
import reject10001Raw from './__fixtures__/table-spec-reject-max-points-10001.json?raw';
import rejectEdgeOnGridRaw from './__fixtures__/table-spec-reject-edge-on-grid.json?raw';
import timerRaw from './__fixtures__/table-spec-timer.json?raw';
import triggerPlottedRaw from './__fixtures__/table-spec-trigger-plotted.json?raw';
import triggerFallingRaw from './__fixtures__/table-spec-trigger-falling.json?raw';
import triggerRisingRaw from './__fixtures__/table-spec-trigger-rising.json?raw';
import triggerRaw from './__fixtures__/table-spec-trigger.json?raw';
import xEqualsYRaw from './__fixtures__/table-spec-x-equals-y.json?raw';
import { buildTableSpec, type TableSpec } from './spec';
import { defaultCorrelationState, parseCorrelationQuery, type CorrelationState } from './query';
import type { PvInfo, PvModel, PvStatus } from '../shared/pvTracker';

// sha256 of canopy's hand-written table contract fixtures
// (tests/canopy/fox/test_table_contract.py FIXTURE_SHA256). These
// files are byte copies; a change upstream is a contract change.
const FIXTURE_SHA256: Record<string, [string, string]> = {
  'result-empty.json': [
    resultEmptyRaw,
    '218b2f06c6f86f91b6fc2fe1ad5c264ad7f5c26c488feaad7cb19d5adbcb6149',
  ],
  'result-trigger.json': [
    resultTriggerRaw,
    'db5eae12cac8c9176544b3b6f0abc838a35826dcfd729016e01268a030be6c27',
  ],
  'spec-max-points-absent.json': [
    maxPointsAbsentRaw,
    'ededfd70cdb9d34c2b96db79babfdbd18d35dabda2cb51c4f13736c0b0f8a26b',
  ],
  'spec-reject-max-points-0.json': [
    reject0Raw,
    '726dc8abdc71806c5e97645e5b5771534e6094dd5a6ae9efd9180e0aa214566b',
  ],
  'spec-reject-max-points-10001.json': [
    reject10001Raw,
    'd80a26c31964b81fc53c5cd84acff848ff3e71d11b31b46ebebf9f3182d15977',
  ],
  // Trigger-edge fixtures (Fire on), copied byte for byte with the
  // SDK slice that types FormulaSpec.triggerEdge.
  'spec-reject-edge-on-grid.json': [
    rejectEdgeOnGridRaw,
    '35ec841bdff3d6d0b0c2bd058c2f5a939faf1600e919f7f3b50bb3bf2e1cdc51',
  ],
  'spec-trigger-rising.json': [
    triggerRisingRaw,
    'e98a02139fa363b96456bef437331b55491785bc0cc72d55bb93b4f6a12a959a',
  ],
  'spec-trigger-falling.json': [
    triggerFallingRaw,
    'a8d14d97a170238ca51ffedb4ad2dba2df074d94c81d645b70e39b5b03828c35',
  ],
  'spec-timer.json': [timerRaw, 'fc289736da0a01a13a1770c2d3ebf202a0c6d584d6430ef12068cecbd703b6cb'],
  'spec-trigger-plotted.json': [
    triggerPlottedRaw,
    'b3623eeca40147e1962bb5a803310463931eee48cf41371eede0cbe3a35b2dd3',
  ],
  'spec-trigger.json': [
    triggerRaw,
    '6139acb178013631174b975be3136db85e934de17ca8bc9540047b08dbf183fb',
  ],
  'spec-x-equals-y.json': [
    xEqualsYRaw,
    'f002685eb32970e0a2ae86ebaec08ccddea4ed77f77b9058b90309759a12ddf2',
  ],
};

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface SubscribeFixture {
  type: 'subscribe';
  t0Ns: number;
  spec: Record<string, unknown> & {
    bindings: Record<string, string>;
    columns: Record<string, string>;
    trigger?: string;
  };
}

function fixture(raw: string): SubscribeFixture {
  return JSON.parse(raw) as SubscribeFixture;
}

// The subscribe frame as the fixtures write it: 2-space JSON, one newline.
function frameBytes(table: TableSpec): string {
  return `${JSON.stringify({ type: 'subscribe', t0Ns: table.t0Ns, spec: table.spec }, null, 2)}\n`;
}

function frame(table: TableSpec): SubscribeFixture {
  return JSON.parse(
    JSON.stringify({ type: 'subscribe', t0Ns: table.t0Ns, spec: table.spec })
  ) as SubscribeFixture;
}

// Binding tokens are names only: rename them b0, b1, ... in order of first
// use (columns in key order, then the trigger) so two specs that bind the same
// PVs the same way compare equal.
function canonical(f: SubscribeFixture): SubscribeFixture {
  const names = new Map<string, string>();
  const rename = (token: string): string => {
    if (!names.has(token)) names.set(token, `b${names.size}`);
    return names.get(token) as string;
  };
  const columns: Record<string, string> = {};
  for (const [name, expr] of Object.entries(f.spec.columns)) {
    columns[name] = expr.replace(/\{(\w+)\}/g, (_, t: string) => `{${rename(t)}}`);
  }
  const trigger = f.spec.trigger === undefined ? undefined : rename(f.spec.trigger);
  const bindings: Record<string, string> = {};
  for (const [token, pv] of Object.entries(f.spec.bindings)) bindings[rename(token)] = pv;
  const spec = { ...f.spec, bindings, columns };
  if (trigger !== undefined) spec.trigger = trigger;
  return { ...f, spec };
}

function info(pv: string, status: PvStatus = 'ok'): PvInfo {
  return { pv, status, units: '' };
}

function modelFor(
  state: CorrelationState,
  statuses: Record<string, PvStatus> = {},
  decided = true
): PvModel {
  const trig = state.trigger.mode === 'pv' ? state.trigger.pv : '';
  return {
    x: state.x === '' ? null : info(state.x, statuses[state.x]),
    ys: state.ys.map((y) => info(y, statuses[y])),
    trig: trig === '' ? null : info(trig, statuses[trig]),
    axisUnit: null,
    decided,
  };
}

function ready(state: CorrelationState, model = modelFor(state)): TableSpec {
  const result = buildTableSpec(state, model);
  if (result.kind !== 'ready') throw new Error(`expected a spec, got ${result.kind}`);
  return result.table;
}

function stateOf(query: string): CorrelationState {
  return parseCorrelationQuery(query);
}

describe('contract fixture copies', () => {
  it.each(Object.keys(FIXTURE_SHA256))('%s matches canopy’s recorded sha256', async (name) => {
    const [raw, digest] = FIXTURE_SHA256[name];
    expect(await sha256(raw)).toBe(digest);
  });
});

describe('buildTableSpec against the contract fixtures', () => {
  it('Timer mode, one Y: spec-timer.json', () => {
    const state = stateOf('x=SR01C:HCM1:SP&y=SR01C:BPM1:X&dt=1&n=500&lookback=10m');
    expect(frame(ready(state))).toEqual(fixture(timerRaw));
  });

  it('Timer 0.1 s, 24 h, default N: spec-max-points-absent.json with N = 1000', () => {
    const state = stateOf('x=SR01C:HCM1:SP&y=SR01C:BPM1:X&dt=0.1&lookback=24h');
    const expected = fixture(maxPointsAbsentRaw);
    // The fixture leaves maxPoints out (server default 1000); the client
    // always sends its N.
    expected.spec.maxPoints = 1000;
    expect(frame(ready(state))).toEqual(expected);
  });

  it('trigger PV = X reuses the X binding: spec-trigger-plotted.json', () => {
    const state = stateOf('x=SR01C:HCM1:SP&y=SR01C:BPM1:X&trig=SR01C:HCM1:SP&n=200&lookback=10m');
    expect(frame(ready(state))).toEqual(fixture(triggerPlottedRaw));
  });

  it('Y = X = trigger binds one PV once: spec-x-equals-y.json', () => {
    const state = stateOf('x=SR01C:BPM1:X&y=SR01C:BPM1:X&trig=SR01C:BPM1:X&lookback=1m');
    const built = frame(ready(state));
    expect(Object.keys(built.spec.bindings)).toHaveLength(1);
    expect(built.spec.columns.x).toBe(built.spec.columns.y);
    expect(canonical(built)).toEqual(canonical(fixture(xEqualsYRaw)));
  });

  it('two Ys and a separate trigger: spec-trigger.json (bare columns)', () => {
    const state = stateOf(
      'x=SR01C:HCM1:SP&y=SR01C:BPM1:X&y=SR01C:BPM2:X&trig=SR:TRIGGER:COUNT&lookback=1h'
    );
    const expected = fixture(triggerRaw);
    // The fixture scales y2 (`{y2} * 1000`) to exercise server-side column
    // expressions; the correlation UI only ever sends bare bindings.
    expected.spec.columns.y2 = '{y2}';
    expect(frame(ready(state))).toEqual(expected);
  });

  it('the bindings of spec-trigger.json are the inputs of result-trigger.json', () => {
    const state = stateOf(
      'x=SR01C:HCM1:SP&y=SR01C:BPM1:X&y=SR01C:BPM2:X&trig=SR:TRIGGER:COUNT&lookback=1h'
    );
    const table = ready(state);
    const result = JSON.parse(resultTriggerRaw) as {
      data: { table: { inputs: Record<string, unknown>; columns: Record<string, unknown> } };
    };
    expect(Object.keys(table.bindingPvs).sort()).toEqual(
      Object.keys(result.data.table.inputs).sort()
    );
    expect(Object.keys(table.columnPvs).sort()).toEqual(
      Object.keys(result.data.table.columns).sort()
    );
  });

  it('never sends N outside the reject fixtures’ range', () => {
    for (const raw of [reject0Raw, reject10001Raw]) {
      const n = (fixture(raw).spec.maxPoints as number).toString();
      const state = stateOf(`x=A&y=B&n=${n}`);
      expect(ready(state).spec.maxPoints).toBe(1000);
    }
    expect(ready(stateOf('x=A&y=B&n=10000')).spec.maxPoints).toBe(10_000);
  });
});

describe('Fire on (triggerEdge) against the contract fixtures', () => {
  const TRIGGER = 'x=SR01C:HCM1:SP&y=SR01C:BPM1:X&y=SR01C:BPM2:X&trig=SR:TRIGGER:COUNT&lookback=1h';

  it('Every update is byte for byte the spec it was before Fire on', () => {
    const state = stateOf('x=SR01C:HCM1:SP&y=SR01C:BPM1:X&trig=SR01C:HCM1:SP&n=200&lookback=10m');
    expect(state.fire).toBeUndefined();
    const table = ready(state);
    expect('triggerEdge' in table.spec).toBe(false);
    expect(frameBytes(table)).toBe(triggerPlottedRaw);
  });

  it('Rising: spec-trigger-rising.json, triggerEdge right after trigger', () => {
    const state = stateOf(`${TRIGGER}&fire=rising`);
    expect(state.fire).toBe('rising');
    const table = ready(state);
    // Same patch as spec-trigger.json: the fixture scales y2, the UI sends
    // bare bindings. Everything else, key order included, is the fixture's.
    const expected = triggerRisingRaw.replace('"{y2} * 1000"', '"{y2}"');
    expect(frameBytes(table)).toBe(expected);
    expect(table.spec.triggerEdge).toBe('rising');
  });

  it('Falling: spec-trigger-falling.json', () => {
    const table = ready(stateOf(`${TRIGGER}&fire=falling`));
    expect(frameBytes(table)).toBe(triggerFallingRaw.replace('"{y2} * 1000"', '"{y2}"'));
  });

  it('a Rising or Falling edit changes the subscription key', () => {
    const every = ready(stateOf(TRIGGER)).key;
    const rising = ready(stateOf(`${TRIGGER}&fire=rising`)).key;
    const falling = ready(stateOf(`${TRIGGER}&fire=falling`)).key;
    expect(new Set([every, rising, falling]).size).toBe(3);
  });

  it('is absent in Timer mode, where the server rejects it (spec-reject-edge-on-grid.json)', () => {
    expect(fixture(rejectEdgeOnGridRaw).spec.index).toBe('grid');
    expect(fixture(rejectEdgeOnGridRaw).spec.triggerEdge).toBeDefined();
    const fromQuery = stateOf('x=SR01C:HCM1:SP&y=SR01C:BPM1:X&dt=1&n=500&lookback=10m&fire=rising');
    expect(fromQuery.fire).toBeUndefined();
    const timer = stateOf('x=SR01C:HCM1:SP&y=SR01C:BPM1:X&dt=1&n=500&lookback=10m');
    // Even a state that slipped a fire past the normalizer builds no edge.
    const table = ready({ ...timer, fire: 'rising' });
    expect(table.spec.index).toBe('grid');
    expect('triggerEdge' in table.spec).toBe(false);
    expect(frameBytes(table)).toBe(frameBytes(ready(timer)));
    expect(frame(table)).toEqual(fixture(timerRaw));
  });
});

describe('buildTableSpec', () => {
  it('maps columns to PVs in colour order and leaves refused Ys out', () => {
    const state = stateOf('x=X&y=Y1&y=Y2&y=Y3');
    const table = ready(state, modelFor(state, { Y2: 'refused-unit' }));
    expect(table.columnPvs).toEqual({ x: 'X', y1: 'Y1', y2: 'Y3' });
    expect(table.spec.columns).toEqual({ x: '{x}', y1: '{y1}', y2: '{y2}' });
    expect(table.bindingPvs).toEqual({ x: 'X', y1: 'Y1', y2: 'Y3' });
  });

  it('plots unverified PVs', () => {
    const state = stateOf('x=X&y=Y1');
    const table = ready(state, modelFor(state, { X: 'unverified', Y1: 'unverified' }));
    expect(table.columnPvs).toEqual({ x: 'X', y: 'Y1' });
  });

  it('is none for a blank instance, an X-only tab and a Y-only tab', () => {
    for (const query of ['', 'x=X', 'y=Y1']) {
      const state = stateOf(query);
      expect(buildTableSpec(state, modelFor(state)).kind).toBe('none');
    }
    const blank = defaultCorrelationState();
    expect(buildTableSpec(blank, modelFor(blank)).kind).toBe('none');
  });

  it('is none when every Y is refused, or X or the trigger is refused', () => {
    const state = stateOf('x=X&y=Y1&y=Y2&trig=T');
    const cases: Array<Record<string, PvStatus>> = [
      { Y1: 'refused-kind', Y2: 'refused-unit' },
      { X: 'refused-kind' },
      { T: 'refused-kind' },
    ];
    for (const statuses of cases) {
      expect(buildTableSpec(state, modelFor(state, statuses)).kind).toBe('none');
    }
  });

  it('is undecided before the decision point or while the model lags the state', () => {
    const state = stateOf('x=X&y=Y1&trig=T');
    expect(buildTableSpec(state, modelFor(state, {}, false)).kind).toBe('undecided');
    expect(buildTableSpec(state, modelFor(state, { X: 'pending' })).kind).toBe('undecided');
    expect(buildTableSpec(state, modelFor(state, { T: 'pending' })).kind).toBe('undecided');
    const older = stateOf('x=X&y=Y0&trig=T');
    expect(buildTableSpec(state, modelFor(older)).kind).toBe('undecided');
  });

  it('keys equal for equal subscriptions and differ on any spec edit', () => {
    const a = ready(stateOf('x=X&y=Y1&dt=1'));
    const view = ready(stateOf('x=X&y=Y1&dt=1&view=density&dy=Y1'));
    expect(view.key).toBe(a.key);
    for (const query of ['x=X&y=Y1&dt=2', 'x=X&y=Y1&n=5', 'x=X&y=Y1&lookback=2h', 'x=X&y=Y2']) {
      expect(ready(stateOf(query)).key).not.toBe(a.key);
    }
  });
});
