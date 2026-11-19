import { describe, expect, it } from 'vitest';
import { defaultCorrelationState, type CorrelationState } from './query';
import type { FrameLike } from './stats';
import { correlationMenuWriters, correlationSignalOf, type CorrelationMenuInput } from './menu';
import type { PvModel } from '../shared/pvTracker';

function input(over: Partial<CorrelationMenuInput> = {}): CorrelationMenuInput {
  const state: CorrelationState = {
    ...defaultCorrelationState(),
    x: 'PROBE:X',
    ys: ['PROBE:Y1', 'PROBE:Y2'],
  };
  const shown = {
    columnPvs: { x: 'PROBE:X', y1: 'PROBE:Y1', y2: 'PROBE:Y2' },
    table: { tsNs: [1, 2, 3, 4], columns: { x: [0, 1, 2, 3], y1: [1, 3, 5, 7], y2: [0, 0, 0, 0] } },
  } as unknown as FrameLike;
  return {
    state,
    shown,
    pvs: { x: null, ys: [], trig: null } as unknown as PvModel,
    unitsOf: () => '',
    update: () => {},
    chart: () => null,
    background: '#fff',
    drawingsHidden: false,
    ...over,
  };
}

const y1 = { id: 'y:PROBE:Y1', pv: 'PROBE:Y1' };

describe('correlation writers', () => {
  it('rows name their PV', () => {
    expect(correlationSignalOf('x:PROBE:X')).toEqual({ id: 'x:PROBE:X', pv: 'PROBE:X' });
  });

  it('Copy fit copies the Y’s slope, offset and R² while the fit is on', () => {
    const w = correlationMenuWriters(input());
    expect(w.copyFit!(y1)?.text).toBe(
      'PROBE:Y1 vs PROBE:X: slope 2.000, offset 1.000, R² 1.000, n 4'
    );
    const off = correlationMenuWriters(input({ state: { ...input().state, fit: false } }));
    expect(off.copyFit!(y1)).toBeNull();
  });

  it('Use as X swaps a Y with the X; the X row has no Use as X', () => {
    let next: CorrelationState | null = null;
    const w = correlationMenuWriters(input({ update: (fn) => (next = fn(input().state)) }));
    const offer = w.useAsX!(y1)!;
    expect(offer.label).toBe('Use as X (swap with PROBE:X)');
    offer.run();
    expect(next!.x).toBe('PROBE:Y1');
    expect(next!.ys).toEqual(['PROBE:X', 'PROBE:Y2']);
    expect(w.useAsX!({ id: 'x:PROBE:X', pv: 'PROBE:X' })).toBeNull();
  });
});
