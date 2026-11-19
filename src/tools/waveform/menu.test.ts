import { describe, expect, it, vi } from 'vitest';
import { defaultWaveformState, type WaveformState } from './query';
import type { WaveformModel } from './model';
import type { WaveformFrames } from './WaveformController';
import {
  waveformMenuWriters,
  waveformPointMenu,
  waveformSignalOf,
  type WaveformMenuInput,
} from './menu';

const A = 'SIM:MAG:CURRENT:WAVEFORM';
const B = 'PROBE:WF';

function input(over: Partial<WaveformMenuInput> = {}): WaveformMenuInput {
  let state: WaveformState = { ...defaultWaveformState(), pvs: [A, B] };
  const row = (pv: string) => ({
    pv,
    status: 'ok',
    chip: null,
    length: 3,
    egu: 'mm',
    hidden: false,
    drawable: true,
  });
  const model = {
    unit: 'mm',
    live: [row(A), row(B)],
    reference: null,
    x: null,
    xAxis: { mode: 'index', label: 'Element', length: null },
  } as unknown as WaveformModel;
  const frames = {
    live: {
      [A]: { frame: new Float64Array([1, 2, 3]) },
      [B]: { frame: new Float64Array([4, 5, 6]) },
    },
    reference: null,
    x: null,
    time: Date.UTC(2026, 9, 22, 18, 42, 7),
  } as unknown as WaveformFrames;
  return {
    state,
    model,
    frames,
    update: (fn) => {
      state = fn(state);
      (input as unknown as { last: WaveformState }).last = state;
    },
    takeSnapshot: vi.fn(() => true),
    snapshotDisabled: false,
    held: null,
    setHeld: vi.fn(),
    chart: () => null,
    background: '#fff',
    drawingsHidden: false,
    ...over,
  };
}

const sig = (pv: string) => ({ id: `live:${pv}`, pv });

describe('waveform writers', () => {
  it('a PV row is a signal; the snapshot and rolling rows are not', () => {
    expect(waveformSignalOf(`live:${A}`)).toEqual({ id: `live:${A}`, pv: A });
    expect(waveformSignalOf('snapshot')).toBeNull();
    expect(waveformSignalOf('rolling')).toBeNull();
  });

  it('Copy this shot copies the row’s array; at a point every drawn curve as columns', () => {
    const w = waveformMenuWriters(input());
    expect(w.copyShot!(sig(A))).toMatchObject({
      label: 'Copy this shot (3 values)',
      text: '1\n2\n3',
    });
    expect(w.copyShot!(null)?.text).toBe(`${A}\t${B}\n1\t4\n2\t5\n3\t6`);
  });

  it('Use as reference moves a Live PV to Reference', () => {
    let next: WaveformState | null = null;
    const w = waveformMenuWriters(input({ update: (fn) => (next = fn(input().state)) }));
    w.useAsReference!(sig(B))!.run();
    expect(next!.reference).toEqual({ kind: 'pv', pv: B });
    expect(next!.pvs).toEqual([A]);
  });

  it('Take snapshot runs the snapshot and carries its disabled reason', () => {
    const take = vi.fn(() => true);
    const w = waveformMenuWriters(input({ takeSnapshot: take, snapshotDisabled: 'No data' }));
    const offer = w.snapshotReference!()!;
    expect(offer.disabled).toBe('No data');
    offer.run();
    expect(take).toHaveBeenCalled();
  });

  it('Freeze holds a copy of the drawn frames; held, it offers Release', () => {
    const setHeld = vi.fn();
    waveformMenuWriters(input({ setHeld })).freezeShot!()!.run();
    const held = setHeld.mock.calls[0][0];
    expect(Array.from(held.live[A])).toEqual([1, 2, 3]);
    const release = waveformMenuWriters(input({ held, setHeld })).freezeShot!()!;
    expect(release.label).toBe('Release frozen shot');
  });

  it('the point reading names the element, the value and the PV', () => {
    const { model, state } = input();
    const p = {
      at: { localX: 0, localY: 0, clientX: 0, clientY: 0 },
      hit: { t: 107, v: 1, axisId: 'y', traceId: A },
      t: 107,
      v: 1,
    };
    const menu = waveformPointMenu(p, state, model);
    expect(menu.reading?.header).toBe(`element 107 · 1.000 mm · ${A}`);
    expect(menu.signals).toEqual([{ id: `live:${A}`, pv: A }]);
  });
});
