// WaveformController: listeners gated on
// page wanted && curve Visible, two-rate ingest/publish, hz, page visibility,
// Pause, the forced publish on a reference change, full-range pre-Δ frames,
// snapshot capture, and `model` emitted only on change.

import { describe, expect, it } from 'vitest';
import { FakeHare, type FakeValue } from '../shared/fakeHare.test-util';
import { setHidden, setSnapshot, setVisible } from './edit';
import { NOT_IN_SNAPSHOT } from './model';
import { defaultWaveformState, type WaveformState } from './query';
import { WAVEFORM_META_TIMEOUT_MS, WaveformController } from './WaveformController';

function wf(...values: Array<number | null>): FakeValue {
  return { connected: true, valueKind: 'waveform', value: values as number[] };
}

const DOWN_WF: FakeValue = { connected: false, valueKind: 'waveform', value: [] };

function state(patch: Partial<WaveformState> = {}): WaveformState {
  return { ...defaultWaveformState(), ...patch };
}

interface Harness {
  hare: FakeHare;
  ctl: WaveformController;
  clock: { t: number };
  /** Pending animation-frame callbacks. */
  frames: Array<{ id: number; cb: () => void }>;
  timers: Array<{ cb: () => void; ms: number; live: boolean }>;
  /** Run the pending animation frames (at the current clock). */
  flush(): void;
  publishes(): number;
  modelEmits(): number;
}

function harness(opts: { visible?: boolean; wanted?: boolean } = {}): Harness {
  const hare = new FakeHare();
  const clock = { t: 1000 };
  const frames: Harness['frames'] = [];
  const timers: Harness['timers'] = [];
  let nextId = 1;
  const ctl = new WaveformController({
    service: hare,
    now: () => clock.t,
    requestFrame: (cb) => {
      const id = nextId++;
      frames.push({ id, cb });
      return id;
    },
    cancelFrame: (id) => {
      const i = frames.findIndex((f) => f.id === id);
      if (i >= 0) frames.splice(i, 1);
    },
    setTimer: (cb, ms) => {
      const timer = { cb, ms, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (h) => {
      (h as { live: boolean }).live = false;
    },
    ...opts,
  });
  let published = 0;
  let modelled = 0;
  ctl.subscribeFrames(() => published++);
  ctl.subscribeModel(() => modelled++);
  return {
    hare,
    ctl,
    clock,
    frames,
    timers,
    flush() {
      const run = frames.splice(0);
      for (const f of run) f.cb();
    },
    publishes: () => published,
    modelEmits: () => modelled,
  };
}

/** Meta for `pvs` (units 'V') and one frame each. */
function initial(h: Harness, pvs: string[], value: FakeValue = wf(1, 2, 3)): void {
  h.hare.initial(pvs.map((pv) => [pv, 'V', value] as [string, string, FakeValue]));
}

describe('listeners: page wanted && curve Visible', () => {
  it('holds one listener per role PV: live, reference PV and X source', () => {
    const h = harness();
    h.ctl.setState(state({ pvs: ['A', 'B'], reference: { kind: 'pv', pv: 'R' }, xs: 'X' }));
    expect(h.hare.subscribed()).toEqual(['A', 'B', 'R', 'X']);
    expect(h.hare.listenerCount()).toBe(4);
  });

  it('a hidden curve has no listener; hiding releases it and showing starts a fresh ring', () => {
    const h = harness();
    let s = state({ pvs: ['A', 'B'] });
    h.ctl.setState(s);
    initial(h, ['A', 'B']);
    h.flush();
    expect(h.ctl.getFrames().live.A).toBeDefined();

    h.clock.t = 2000;
    s = setHidden(s, 'A', true);
    h.ctl.setState(s);
    expect(h.hare.subscribed()).toEqual(['B']);
    expect(h.hare.log).toContain('-A');

    // A hidden reference PV is released too.
    const withRef = setHidden(state({ pvs: ['B'], reference: { kind: 'pv', pv: 'R' } }), 'R', true);
    h.ctl.setState(withRef);
    expect(h.hare.subscribed()).toEqual(['B']);

    h.clock.t = 3000;
    s = setVisible(s, 'A', true);
    h.ctl.setState(s);
    expect(h.hare.subscribed()).toEqual(['A', 'B']);
    h.hare.diff([['A', wf(4, 5, 6)]]);
    h.flush();
    // The fresh ring holds only the frame after the show.
    expect(Array.from(h.ctl.getFrames().live.A!.frame)).toEqual([4, 5, 6]);
  });

  it('a curve shown after a snapshot has no entry in Δ ("not in snapshot")', () => {
    const h = harness();
    let s = state({ pvs: ['A', 'B'] });
    h.ctl.setState(s);
    initial(h, ['A', 'B']);
    h.flush();

    h.clock.t = 2000;
    const snap = h.ctl.captureSnapshot()!;
    expect(Object.keys(snap.frames).sort()).toEqual(['A', 'B']);
    s = setSnapshot(s, snap);
    s = { ...s, delta: true };
    h.ctl.setState(s);
    expect(h.ctl.getModel().live.map((r) => r.drawable)).toEqual([true, true]);

    h.clock.t = 3000;
    s = setHidden(s, 'A', true);
    h.ctl.setState(s);
    h.clock.t = 4000;
    s = setHidden(s, 'A', false);
    h.ctl.setState(s);
    h.hare.diff([['A', wf(7, 8, 9)]]);
    const a = h.ctl.getModel().live.find((r) => r.pv === 'A')!;
    expect(a.drawable).toBe(false);
    expect(a.chip).toBe(NOT_IN_SNAPSHOT);
    expect(h.ctl.getModel().live.find((r) => r.pv === 'B')!.drawable).toBe(true);
  });

  it('the page not wanted releases every listener; wanted again listens afresh', () => {
    const h = harness();
    h.ctl.setState(state({ pvs: ['A'], reference: { kind: 'pv', pv: 'R' }, xs: 'X' }));
    h.ctl.setPageWanted(false);
    expect(h.hare.listenerCount()).toBe(0);
    h.ctl.setPageWanted(true);
    expect(h.hare.subscribed()).toEqual(['A', 'R', 'X']);
  });

  it('a page created unwanted listens to nothing', () => {
    const h = harness({ wanted: false });
    h.ctl.setState(state({ pvs: ['A'] }));
    expect(h.hare.listenerCount()).toBe(0);
  });

  it('a reconnect resets the ring; a disconnect is never ingested', () => {
    const h = harness();
    h.ctl.setState(state({ pvs: ['A'], persist: 4 }));
    initial(h, ['A']);
    h.hare.diff([['A', wf(2, 2, 2)]]);
    h.flush();
    expect(h.ctl.getFrames().live.A!.trails).toHaveLength(1);

    h.hare.diff([['A', DOWN_WF]]);
    expect(h.ctl.getModel().live[0].chip).toBe('disconnected');
    h.clock.t = 5000;
    h.hare.diff([['A', wf(9, 9, 9)]]);
    h.flush();
    expect(h.ctl.getFrames().live.A!.trails).toEqual([]);
    expect(Array.from(h.ctl.getFrames().live.A!.frame)).toEqual([9, 9, 9]);
  });

  it('dispose releases every listener and the pending animation frame', () => {
    const h = harness();
    h.ctl.setState(state({ pvs: ['A', 'B'] }));
    initial(h, ['A', 'B']);
    expect(h.frames).toHaveLength(1);
    h.ctl.dispose();
    expect(h.hare.listenerCount()).toBe(0);
    expect(h.frames).toHaveLength(0);
  });
});

describe('publish: at most once per animation frame, only on new data', () => {
  it('coalesces many frames into one publish of the newest', () => {
    const h = harness();
    h.ctl.setState(state({ pvs: ['A'] }));
    initial(h, ['A'], wf(1));
    h.hare.diff([['A', wf(2)]]);
    h.hare.diff([['A', wf(3)]]);
    expect(h.publishes()).toBe(0);
    expect(h.frames).toHaveLength(1);
    h.flush();
    expect(h.publishes()).toBe(1);
    expect(Array.from(h.ctl.getFrames().live.A!.frame)).toEqual([3]);
    expect(h.ctl.getFrames().time).toBe(1000);
  });

  it('requests no animation frame and publishes nothing without a new frame', () => {
    const h = harness();
    h.ctl.setState(state({ pvs: ['A'] }));
    expect(h.frames).toHaveLength(0);
    initial(h, ['A']);
    h.flush();
    expect(h.publishes()).toBe(1);
    expect(h.frames).toHaveLength(0);
    h.flush();
    expect(h.publishes()).toBe(1);
  });

  it('hz only lengthens the interval; the ring keeps every frame meanwhile', () => {
    const h = harness();
    h.ctl.setState(state({ pvs: ['A'], hz: 2, persist: 3 }));
    initial(h, ['A'], wf(1));
    h.flush();
    expect(h.publishes()).toBe(1);

    h.clock.t = 1100;
    h.hare.diff([['A', wf(2)]]);
    h.flush();
    expect(h.publishes()).toBe(0 + 1);
    // Still waiting on animation frames, not a timer.
    expect(h.frames).toHaveLength(1);
    expect(h.timers.filter((t) => t.live && t.ms !== WAVEFORM_META_TIMEOUT_MS)).toHaveLength(0);

    h.clock.t = 1300;
    h.hare.diff([['A', wf(3)]]);
    h.flush();
    expect(h.publishes()).toBe(1);

    h.clock.t = 1500;
    h.flush();
    expect(h.publishes()).toBe(2);
    const out = h.ctl.getFrames().live.A!;
    expect(Array.from(out.frame)).toEqual([3]);
    expect(out.trails!.map((f) => f[0])).toEqual([1, 2]);
  });

  it('hz at Hare cadence (10) is no cap: every animation frame with new data publishes', () => {
    const h = harness();
    h.ctl.setState(state({ pvs: ['A'] }));
    initial(h, ['A'], wf(1));
    h.flush();
    h.clock.t = 1016;
    h.hare.diff([['A', wf(2)]]);
    h.flush();
    expect(h.publishes()).toBe(2);
  });

  it('hidden: keeps ingesting with no publish; show publishes once at once; no timer', () => {
    const h = harness({ visible: false });
    h.ctl.setState(state({ pvs: ['A'], persist: 4 }));
    initial(h, ['A'], wf(1));
    h.hare.diff([['A', wf(2)]]);
    h.hare.diff([['A', wf(3)]]);
    h.flush();
    expect(h.frames).toHaveLength(0);
    expect(h.publishes()).toBe(0);
    expect(h.timers.filter((t) => t.ms !== WAVEFORM_META_TIMEOUT_MS)).toHaveLength(0);

    h.ctl.setVisible(true);
    expect(h.publishes()).toBe(1);
    const out = h.ctl.getFrames().live.A!;
    expect(Array.from(out.frame)).toEqual([3]);
    expect(out.trails!.map((f) => f[0])).toEqual([1, 2]);
    h.flush();
    expect(h.publishes()).toBe(1);

    // Going hidden again cancels a pending publish.
    h.hare.diff([['A', wf(4)]]);
    expect(h.frames).toHaveLength(1);
    h.ctl.setVisible(false);
    expect(h.frames).toHaveLength(0);
    h.flush();
    expect(h.publishes()).toBe(1);
  });

  it('Pause freezes the published frames; resuming publishes the newest', () => {
    const h = harness();
    h.ctl.setState(state({ pvs: ['A'] }));
    initial(h, ['A'], wf(1));
    h.flush();
    h.ctl.setPaused(true);
    h.hare.diff([['A', wf(2)]]);
    h.flush();
    expect(h.publishes()).toBe(1);
    expect(Array.from(h.ctl.getFrames().live.A!.frame)).toEqual([1]);
    h.ctl.setPaused(false);
    h.flush();
    expect(h.publishes()).toBe(2);
    expect(Array.from(h.ctl.getFrames().live.A!.frame)).toEqual([2]);
  });
});

describe('a reference change forces one publish past hz and Pause', () => {
  it('bypasses the hz interval', () => {
    const h = harness();
    let s = state({ pvs: ['A'], hz: 1 });
    h.ctl.setState(s);
    initial(h, ['A'], wf(1));
    h.flush();
    expect(h.publishes()).toBe(1);
    h.clock.t = 1050;
    s = setSnapshot(s, h.ctl.captureSnapshot()!);
    h.ctl.setState(s);
    expect(h.publishes()).toBe(2);
  });

  it('while paused the live frames stay frozen, so Δ against the snapshot re-zeroes', () => {
    const h = harness();
    let s = state({ pvs: ['A'] });
    h.ctl.setState(s);
    initial(h, ['A'], wf(1, 2));
    h.flush();
    h.ctl.setPaused(true);
    h.hare.diff([['A', wf(5, 5)]]);
    const frozen = h.ctl.getFrames().live.A!.frame;

    h.clock.t = 1200;
    const snap = h.ctl.captureSnapshot()!;
    expect(snap.frames.A).toBe(frozen);
    s = { ...setSnapshot(s, snap), delta: true };
    h.ctl.setState(s);
    expect(h.publishes()).toBe(2);
    expect(h.ctl.getFrames().live.A!.frame).toBe(frozen);
    expect(h.ctl.getModel().live[0].drawable).toBe(true);
  });

  it('a new reference PV forces a publish; a style-only edit of the same PV does not', () => {
    const h = harness();
    let s = state({ pvs: ['A'] });
    h.ctl.setState(s);
    initial(h, ['A']);
    h.flush();
    s = { ...s, reference: { kind: 'pv', pv: 'R' } };
    h.ctl.setState(s);
    expect(h.publishes()).toBe(2);
    h.ctl.setState({ ...s, reference: { kind: 'pv', pv: 'R' }, legend: false });
    expect(h.publishes()).toBe(2);
  });

  it('while hidden the forced publish waits for the show', () => {
    const h = harness({ visible: false });
    let s = state({ pvs: ['A'] });
    h.ctl.setState(s);
    s = { ...s, reference: { kind: 'pv', pv: 'R' } };
    h.ctl.setState(s);
    expect(h.publishes()).toBe(0);
    h.ctl.setVisible(true);
    expect(h.publishes()).toBe(1);
  });
});

describe('frames are published and snapshotted at full range, pre-Δ', () => {
  it('ignores element range, Δ and decimation; nulls become NaN; the ring array by identity', () => {
    const h = harness();
    h.ctl.setState(
      state({
        pvs: ['A'],
        reference: { kind: 'pv', pv: 'R' },
        delta: true,
        elems: { first: 1, last: 2 },
        dec: 256,
      })
    );
    h.hare.initial([
      ['A', 'V', wf(10, null, 30, 40)],
      ['R', 'V', wf(1, 1, 1, 1)],
    ]);
    h.flush();
    const out = h.ctl.getFrames();
    const a = out.live.A!.frame;
    expect(a.length).toBe(4);
    expect(a[0]).toBe(10);
    expect(Number.isNaN(a[1])).toBe(true);
    expect(a[3]).toBe(40);
    expect(Array.from(out.reference!)).toEqual([1, 1, 1, 1]);
    // The same stored array is published again with no new frame of A.
    h.hare.diff([['R', wf(2, 2, 2, 2)]]);
    h.flush();
    expect(h.ctl.getFrames().live.A!.frame).toBe(a);
  });

  it('publishes the X source frame and the ring mean when averaging', () => {
    const h = harness();
    h.ctl.setState(state({ pvs: ['A'], xs: 'X', avg: 2 }));
    h.hare.initial([
      ['A', 'V', wf(2, 4)],
      ['X', 'mm', wf(0, 1)],
    ]);
    h.hare.diff([['A', wf(4, null)]]);
    h.flush();
    const out = h.ctl.getFrames();
    expect(Array.from(out.live.A!.frame)).toEqual([3, 4]);
    expect(Array.from(out.x!)).toEqual([0, 1]);
    expect(out.live.A!.trails).toBeUndefined();
  });
});

describe('captureSnapshot', () => {
  it('takes every visible drawable live curve, by its last published frame', () => {
    const h = harness();
    // C is in another unit (kept, not drawn); D is hidden; E has no frame.
    const s = setHidden(state({ pvs: ['A', 'B', 'C', 'D', 'E'] }), 'D', true);
    h.ctl.setState(s);
    h.hare.initial([
      ['A', 'V', wf(1, 2)],
      ['B', 'V', wf(3, 4)],
      ['C', 'mA', wf(5, 6)],
      ['E', 'V', DOWN_WF],
    ]);
    // D, hidden, has no listener and so no metadata: the unit waits for the timeout.
    h.timers.find((t) => t.live && t.ms === WAVEFORM_META_TIMEOUT_MS)!.cb();
    h.flush();
    const published = h.ctl.getFrames();
    // A frame newer than the last publish is not what the canvas shows.
    h.hare.diff([['A', wf(9, 9)]]);
    h.clock.t = 1234;
    const snap = h.ctl.captureSnapshot()!;
    expect(Object.keys(snap.frames).sort()).toEqual(['A', 'B']);
    expect(snap.frames.A).toBe(published.live.A!.frame);
    expect(snap.frames.B).toBe(published.live.B!.frame);
    expect(snap.time).toBe(1234);
  });

  it('copies an averaged frame so later publishes cannot change the snapshot', () => {
    const h = harness();
    h.ctl.setState(state({ pvs: ['A'], avg: 2 }));
    initial(h, ['A'], wf(2, 2));
    h.flush();
    const snap = h.ctl.captureSnapshot()!;
    expect(Array.from(snap.frames.A)).toEqual([2, 2]);
    h.hare.diff([['A', wf(4, 4)]]);
    h.flush();
    expect(Array.from(h.ctl.getFrames().live.A!.frame)).toEqual([3, 3]);
    expect(Array.from(snap.frames.A)).toEqual([2, 2]);
  });

  it('re-taking includes a curve missing from the earlier snapshot', () => {
    const h = harness();
    let s = state({ pvs: ['A'] });
    h.ctl.setState(s);
    initial(h, ['A']);
    h.flush();
    s = { ...setSnapshot(s, h.ctl.captureSnapshot()!), delta: true };
    h.ctl.setState(s);
    h.clock.t = 2000;
    s = { ...s, pvs: ['A', 'B'] };
    h.ctl.setState(s);
    initial(h, ['B']);
    h.flush();
    expect(h.ctl.getModel().live[1].chip).toBe(NOT_IN_SNAPSHOT);
    h.clock.t = 3000;
    expect(Object.keys(h.ctl.captureSnapshot()!.frames).sort()).toEqual(['A', 'B']);
  });

  it('is null when nothing has been published', () => {
    const h = harness();
    h.ctl.setState(state({ pvs: ['A'] }));
    expect(h.ctl.captureSnapshot()).toBeNull();
  });

  it('reads the snapshot from state only: the published frames never carry it', () => {
    const h = harness();
    let s = state({ pvs: ['A'] });
    h.ctl.setState(s);
    initial(h, ['A']);
    h.flush();
    s = setSnapshot(s, h.ctl.captureSnapshot()!);
    h.ctl.setState(s);
    expect(h.ctl.getFrames().reference).toBeNull();
  });
});

describe('rolling reference', () => {
  const rolling = (seconds = 60) =>
    state({ pvs: ['A'], persist: 4, reference: { kind: 'rolling', seconds } });

  it('publishes each live curve’s window mean and σ, seeded from the ring, moving with the clock', () => {
    const h = harness();
    h.ctl.setState(state({ pvs: ['A'], persist: 4 }));
    initial(h, ['A'], wf(1, 10));
    h.clock.t = 2000;
    h.hare.diff([['A', wf(3, 10)]]);
    h.flush();
    expect(h.ctl.getFrames().rolling).toBeUndefined();
    // Turning the rolling reference on seeds the window with the ring's two frames.
    h.ctl.setState(rolling());
    const seeded = h.ctl.getFrames().rolling!.A!;
    expect(Array.from(seeded.mean)).toEqual([2, 10]);
    expect(seeded.std[0]).toBeCloseTo(Math.SQRT2, 12);
    expect(seeded.frames).toBe(2);
    expect(h.ctl.getModel().reference).toMatchObject({ kind: 'rolling', status: 'ok' });
    // A minute later the seed frames have left the window.
    h.clock.t = 70_000;
    h.hare.diff([['A', wf(5, 5)]]);
    h.flush();
    const later = h.ctl.getFrames().rolling!.A!;
    expect(Array.from(later.mean)).toEqual([5, 5]);
    expect(later.frames).toBe(1);
    expect(h.ctl.getModel().reference).toMatchObject({ status: 'pending', chip: 'collecting' });
  });

  it('a changed window forces one publish; clearing the reference drops the windows', () => {
    const h = harness();
    h.ctl.setState(rolling(60));
    initial(h, ['A'], wf(1, 1));
    h.flush();
    const before = h.publishes();
    h.ctl.setState(rolling(30));
    expect(h.publishes()).toBe(before + 1);
    h.ctl.setState(state({ pvs: ['A'] }));
    expect(h.ctl.getFrames().rolling).toBeUndefined();
  });

  it('a reconnect restarts the window; captureSnapshot freezes mean and σ with the window', () => {
    const h = harness();
    h.ctl.setState(rolling(60));
    initial(h, ['A'], wf(2, 4));
    h.clock.t = 1500;
    h.hare.diff([['A', wf(4, 4)]]);
    h.flush();
    h.clock.t = 1600;
    const snap = h.ctl.captureSnapshot()!;
    expect(Array.from(snap.frames.A)).toEqual([3, 4]);
    expect(Array.from(snap.spread!.A)).toEqual([Math.SQRT2, 0]);
    expect(snap.rolling).toBe(60);
    expect(snap.time).toBe(1600);
    // The copies do not follow the window.
    h.clock.t = 2000;
    h.hare.diff([['A', DOWN_WF]]);
    h.hare.diff([['A', wf(9, 9)]]);
    h.flush();
    expect(Array.from(snap.frames.A)).toEqual([3, 4]);
    expect(Array.from(h.ctl.getFrames().rolling!.A!.mean)).toEqual([9, 9]);
    expect(h.ctl.getFrames().rolling!.A!.frames).toBe(1);
  });
});

describe('model: emitted only on change', () => {
  it('a stream of same-shaped frames emits the model once, the frames per publish', () => {
    const h = harness();
    h.ctl.setState(state({ pvs: ['A'] }));
    initial(h, ['A'], wf(1, 2, 3));
    h.flush();
    const model = h.ctl.getModel();
    const emits = h.modelEmits();
    for (let i = 0; i < 50; i++) {
      h.clock.t += 100;
      h.hare.diff([['A', wf(i, i, i)]]);
      h.flush();
    }
    expect(h.publishes()).toBe(51);
    expect(h.modelEmits()).toBe(emits);
    expect(h.ctl.getModel()).toBe(model);
    expect(model.live[0]).toMatchObject({ pv: 'A', drawable: true, length: 3, egu: 'V' });
    expect(model.unit).toBe('V');
  });

  it('a length change re-emits the model', () => {
    const h = harness();
    h.ctl.setState(state({ pvs: ['A'] }));
    initial(h, ['A'], wf(1, 2, 3));
    const emits = h.modelEmits();
    h.hare.diff([['A', wf(1, 2)]]);
    expect(h.modelEmits()).toBe(emits + 1);
    expect(h.ctl.getModel().live[0].length).toBe(2);
  });

  it('decides the unit once metadata arrives, or at the metadata timeout', () => {
    const h = harness();
    h.ctl.setState(state({ pvs: ['A', 'B'] }));
    // Only A's metadata arrives (B is subscribed but silent).
    h.hare.initial([['A', 'V', wf(1)]]);
    expect(h.ctl.getModel().unitDecided).toBe(false);
    const timer = h.timers.find((t) => t.live && t.ms === WAVEFORM_META_TIMEOUT_MS)!;
    expect(timer).toBeDefined();
    timer.cb();
    expect(h.ctl.getModel().unitDecided).toBe(true);
    expect(h.ctl.getModel().unit).toBe('V');
  });
});
