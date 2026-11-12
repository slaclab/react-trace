// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { parseCorrelationQuery } from './query';
import { useCorrelationPvs } from './pvs';
import { moleSearch } from '../../pvSearch';
import { DOWN, ENUM, FakeHare, SCALAR, STRING, WAVEFORM } from '../shared/fakeHare.test-util';
import {
  CORRELATION_KINDS,
  METADATA_TIMEOUT_MS,
  PvTracker,
  WAVEFORM_KINDS,
  kindMessage,
  type PvRoles,
} from '../shared/pvTracker';
import { formulaEngineServiceOptions, hareServiceOptions } from '../shared/canopyServices';
import { canopyConnection } from '../../api/connection';

const X = 'SIM:HCM01:SP';
const Y1 = 'SIM:BPM01:X';
const Y2 = 'SIM:BPM02:X';
const Y3 = 'SIM:BPM03:X';
const T = 'SIM:TIMING:TRIG';

let hare: FakeHare;
let tracker: PvTracker;

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function roles(ys: string[], x = X, trig = ''): PvRoles {
  return { x, ys, trig };
}

function status(pv: string): string | undefined {
  return tracker.getModel().ys.find((i) => i.pv === pv)?.status;
}

beforeEach(() => {
  vi.useFakeTimers();
  hare = new FakeHare();
  tracker = new PvTracker(hare, CORRELATION_KINDS);
});

afterEach(() => {
  tracker.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('kind rule', () => {
  it('refuses a waveform Y from the state but keeps it in its role', async () => {
    tracker.setRoles(roles([Y1, Y2]));
    hare.initial([
      [Y1, 'mm', SCALAR],
      [Y2, 'mm', WAVEFORM],
    ]);
    await flush();
    const y2 = tracker.getModel().ys[1];
    expect(y2).toMatchObject({ pv: Y2, status: 'refused-kind', kind: 'waveform' });
    expect(y2.message).toMatch(/waveform/);
    expect(status(Y1)).toBe('ok');
  });

  it('accepts enum PVs (plotted by index)', async () => {
    tracker.setRoles(roles([Y1]));
    hare.initial([[Y1, '', ENUM]]);
    await flush();
    expect(status(Y1)).toBe('ok');
  });

  it('a typed waveform is refused inline with reason `waveform` and released', async () => {
    const result = tracker.probe(Y1, 'y');
    hare.initial([[Y1, '', WAVEFORM]]);
    await expect(result).resolves.toEqual({
      ok: false,
      message: `${Y1} is a waveform PV; only scalar and enum PVs can be plotted.`,
      reason: 'waveform',
    });
    expect(hare.subscribed()).toEqual([]);
  });

  it('a waveform Y from the state carries reason `waveform` on its info', async () => {
    tracker.setRoles(roles([Y1]));
    hare.initial([[Y1, '', WAVEFORM]]);
    await flush();
    expect(tracker.getModel().ys[0]).toMatchObject({ status: 'refused-kind', reason: 'waveform' });
  });

  it('a typed string PV is refused with the unchanged message and no reason', async () => {
    const result = tracker.probe(Y1, 'y');
    hare.initial([[Y1, '', STRING]]);
    await expect(result).resolves.toEqual({
      ok: false,
      message: `${Y1} is a string PV; only scalar and enum PVs can be plotted.`,
    });
  });

  it('the default rule is the correlation rule', () => {
    expect(CORRELATION_KINDS).toEqual(['scalar', 'enum']);
    expect(kindMessage(Y1, 'waveform', CORRELATION_KINDS)).toBe(
      `${Y1} is a waveform PV; only scalar and enum PVs can be plotted.`
    );
  });

  it('kind is read only from connected snapshots', async () => {
    tracker.setRoles(roles([Y1]));
    hare.initial([[Y1, '', { connected: false, valueKind: 'waveform' }]]);
    await flush();
    expect(status(Y1)).toBe('pending');
    act(() => {
      vi.advanceTimersByTime(METADATA_TIMEOUT_MS);
    });
    expect(status(Y1)).toBe('unverified');
  });

  it('an unverified PV is refused later when its kind proves non-numeric', async () => {
    tracker.setRoles(roles([Y1]));
    vi.advanceTimersByTime(METADATA_TIMEOUT_MS);
    expect(status(Y1)).toBe('unverified');
    hare.initial([[Y1, '', STRING]]);
    await flush();
    expect(status(Y1)).toBe('refused-kind');
    expect(tracker.getModel().ys.map((i) => i.pv)).toEqual([Y1]);
  });

  it('the trigger PV follows the kind rule; X too', async () => {
    tracker.setRoles(roles([Y1], X, T));
    hare.initial([
      [T, '', STRING],
      [X, '', WAVEFORM],
      [Y1, 'mm', SCALAR],
    ]);
    await flush();
    expect(tracker.getModel().trig?.status).toBe('refused-kind');
    expect(tracker.getModel().x?.status).toBe('refused-kind');
  });

  it('a probe with no metadata in 3 s resolves as unverified', async () => {
    const result = tracker.probe(Y1, 'y');
    vi.advanceTimersByTime(METADATA_TIMEOUT_MS);
    await expect(result).resolves.toMatchObject({ ok: true, info: { status: 'unverified' } });
    expect(hare.subscribed()).toEqual([Y1]);
    tracker.setRoles(roles([Y1], ''));
    expect(hare.log).toEqual([`+${Y1}`]);
  });
});

describe('waveform kind rule', () => {
  let wave: PvTracker;

  beforeEach(() => {
    wave = new PvTracker(hare, WAVEFORM_KINDS);
  });

  afterEach(() => {
    wave.dispose();
  });

  it('accepts a typed waveform PV', async () => {
    const result = wave.probe(Y1, 'y');
    hare.initial([[Y1, 'V', WAVEFORM]]);
    await expect(result).resolves.toMatchObject({
      ok: true,
      info: { pv: Y1, status: 'ok', kind: 'waveform', units: 'V' },
    });
  });

  it('refuses a typed scalar PV with a reason of its own and releases it', async () => {
    const result = wave.probe(Y1, 'y');
    hare.initial([[Y1, 'mm', SCALAR]]);
    await expect(result).resolves.toEqual({
      ok: false,
      message: `${Y1} is a scalar PV; only waveform PVs can be plotted.`,
      reason: 'scalar',
    });
    expect(hare.subscribed()).toEqual([]);
  });

  it('refuses an enum PV with reason `scalar`; a string PV with none', async () => {
    const e = wave.probe(Y1, 'y');
    hare.initial([[Y1, '', ENUM]]);
    await expect(e).resolves.toMatchObject({ ok: false, reason: 'scalar' });
    const s = wave.probe(Y2, 'y');
    hare.initial([[Y2, '', STRING]]);
    const refused = await s;
    expect(refused.ok).toBe(false);
    expect(refused).not.toHaveProperty('reason');
  });

  it('state roles follow the waveform rule; the unit rule is unchanged', async () => {
    wave.setRoles(roles([Y1, Y2, Y3], ''));
    hare.initial([
      [Y1, 'mm', WAVEFORM],
      [Y2, 'A', WAVEFORM],
      [Y3, 'V', SCALAR],
    ]);
    await flush();
    const model = wave.getModel();
    expect(model.axisUnit).toBe('mm');
    expect(model.ys.map((i) => i.status)).toEqual(['ok', 'refused-unit', 'refused-kind']);
    expect(model.ys[2]).toMatchObject({ kind: 'scalar', reason: 'scalar' });
  });
});

describe('unit rule', () => {
  it('decides only once every Y has metadata or timed out', async () => {
    tracker.setRoles(roles([Y1, Y2]));
    hare.initial([[Y2, 'A', SCALAR]]);
    await flush();
    expect(tracker.getModel().decided).toBe(false);
    expect(tracker.getModel().axisUnit).toBeNull();
    expect(status(Y2)).toBe('ok');
    hare.initial([[Y1, 'mm', SCALAR]]);
    await flush();
    expect(tracker.getModel()).toMatchObject({ decided: true, axisUnit: 'mm' });
    expect(status(Y2)).toBe('refused-unit');
    expect(tracker.getModel().ys[1].message).toBe(
      `${Y2} is in A; Y axis is mm. Open a new correlation tab (+) for it.`
    );
  });

  it('reversed metadata arrival order gives the same decision', async () => {
    for (const order of [
      [Y1, Y2],
      [Y2, Y1],
    ]) {
      const h = new FakeHare();
      const t = new PvTracker(h, CORRELATION_KINDS);
      t.setRoles(roles([Y1, Y2]));
      const units: Record<string, string> = { [Y1]: 'mm', [Y2]: 'A' };
      for (const pv of order) {
        h.initial([[pv, units[pv], SCALAR]]);
        await flush();
      }
      expect(t.getModel().axisUnit).toBe('mm');
      expect(t.getModel().ys.map((i) => i.status)).toEqual(['ok', 'refused-unit']);
      t.dispose();
    }
  });

  it('a PV disconnected at add that later connects with another unit is refused (second initial)', async () => {
    tracker.setRoles(roles([Y1, Y2]));
    hare.initial([
      [Y1, 'mm', SCALAR],
      [Y2, null, DOWN],
    ]);
    vi.advanceTimersByTime(METADATA_TIMEOUT_MS);
    await flush();
    expect(tracker.getModel()).toMatchObject({ decided: true, axisUnit: 'mm' });
    expect(status(Y2)).toBe('unverified');
    // The broker re-describes on first connect and pushes an initial with meta.
    hare.initial([[Y2, 'A', SCALAR]]);
    await flush();
    expect(status(Y2)).toBe('refused-unit');
    expect(tracker.getModel().axisUnit).toBe('mm');
  });

  it('a late unit never moves the frozen axis', async () => {
    tracker.setRoles(roles([Y1, Y2]));
    hare.initial([
      [Y1, null, DOWN],
      [Y2, 'mm', SCALAR],
    ]);
    vi.advanceTimersByTime(METADATA_TIMEOUT_MS);
    await flush();
    expect(tracker.getModel().axisUnit).toBe('mm');
    // Y1 comes first in Y order but arrives late: it is refused, mm stays.
    hare.initial([[Y1, 'A', SCALAR]]);
    await flush();
    expect(tracker.getModel().axisUnit).toBe('mm');
    expect(tracker.getModel().ys.map((i) => i.status)).toEqual(['refused-unit', 'ok']);
  });

  it('all Ys disconnected at load, then one frame with mm and A: axis mm, A refused (Y order)', async () => {
    tracker.setRoles(roles([Y1, Y2]));
    hare.initial([
      [Y1, null, DOWN],
      [Y2, null, DOWN],
    ]);
    vi.advanceTimersByTime(METADATA_TIMEOUT_MS);
    await flush();
    expect(tracker.getModel()).toMatchObject({ decided: true, axisUnit: null });
    // The frame lists the A PV first; Y order still wins.
    hare.initial([
      [Y2, 'A', SCALAR],
      [Y1, 'mm', SCALAR],
    ]);
    await flush();
    expect(tracker.getModel().axisUnit).toBe('mm');
    expect(tracker.getModel().ys.map((i) => i.status)).toEqual(['ok', 'refused-unit']);
  });

  it('empty or unknown units never refuse', async () => {
    tracker.setRoles(roles([Y1, Y2, Y3]));
    hare.initial([
      [Y1, '', SCALAR],
      [Y2, 'mm', SCALAR],
      [Y3, null, SCALAR],
    ]);
    await flush();
    expect(tracker.getModel().axisUnit).toBe('mm');
    expect(tracker.getModel().ys.map((i) => i.status)).toEqual(['ok', 'ok', 'ok']);
  });

  it('a kind-refused Y never sets the axis', async () => {
    tracker.setRoles(roles([Y1, Y2]));
    hare.initial([
      [Y1, 'V', WAVEFORM],
      [Y2, 'mm', SCALAR],
    ]);
    await flush();
    expect(tracker.getModel().axisUnit).toBe('mm');
    expect(tracker.getModel().ys.map((i) => i.status)).toEqual(['refused-kind', 'ok']);
  });

  it('unfreezes when the last Y carrying the unit is removed and re-runs over the rest', async () => {
    tracker.setRoles(roles([Y1, Y2, Y3]));
    hare.initial([
      [Y1, 'mm', SCALAR],
      [Y2, 'A', SCALAR],
      [Y3, 'A', SCALAR],
    ]);
    await flush();
    expect(tracker.getModel().ys.map((i) => i.status)).toEqual([
      'ok',
      'refused-unit',
      'refused-unit',
    ]);
    tracker.setRoles(roles([Y2, Y3]));
    expect(tracker.getModel().axisUnit).toBe('A');
    expect(tracker.getModel().ys.map((i) => i.status)).toEqual(['ok', 'ok']);
  });

  it('a typed Y in another unit than the frozen axis is refused inline; a matching one is accepted', async () => {
    tracker.setRoles(roles([Y1]));
    hare.initial([[Y1, 'mm', SCALAR]]);
    await flush();
    const refused = tracker.probe(Y2, 'y');
    hare.initial([[Y2, 'A', SCALAR]]);
    await expect(refused).resolves.toEqual({
      ok: false,
      message: `${Y2} is in A; Y axis is mm. Open a new correlation tab (+) for it.`,
    });
    expect(hare.subscribed()).not.toContain(Y2);
    const accepted = tracker.probe(Y3, 'y');
    hare.initial([[Y3, 'mm', SCALAR]]);
    await expect(accepted).resolves.toMatchObject({ ok: true });
    // A typed X is never unit-checked.
    const x = tracker.probe(Y2, 'x');
    hare.initial([[Y2, 'A', SCALAR]]);
    await expect(x).resolves.toMatchObject({ ok: true });
  });
});

describe('listeners', () => {
  it('one listener per PV, released when it leaves its role', () => {
    tracker.setRoles(roles([Y1, X], X, T));
    expect(hare.subscribed()).toEqual([X, Y1, T].sort());
    tracker.setRoles(roles([Y1], X));
    expect(hare.subscribed()).toEqual([X, Y1].sort());
    expect(hare.listenerCount()).toBe(2);
  });

  it('are kept through hidden-long and released on unmount', async () => {
    window.history.replaceState(null, '', '/x/y/trace/correlation.html?embedded=true');
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    // themeStore (imported by the bridge) reads localStorage at import time;
    // some Node builds shadow jsdom's with an unusable one.
    if (!window.localStorage) {
      const store = new Map<string, string>();
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => store.set(k, v),
          removeItem: (k: string) => store.delete(k),
          clear: () => store.clear(),
        },
      });
    }
    const { installBridge, getSnapshot: bridgeSnapshot } = await import('../../embed/bridge');
    const uninstall = installBridge();
    const state = parseCorrelationQuery(`x=${X}&y=${Y1}&y=${Y2}&trig=${T}`);
    const hook = renderHook(() => useCorrelationPvs(hare, state));
    expect(hare.subscribed()).toEqual([X, Y1, Y2, T].sort());
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          origin: window.location.origin,
          data: { type: 'canopy:trace-visibility', visible: false },
        })
      );
    });
    expect(bridgeSnapshot().visible).toBe(false);
    act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000);
    });
    expect(hare.listenerCount()).toBe(4);
    hook.unmount();
    expect(hare.listenerCount()).toBe(0);
    uninstall();
    window.history.replaceState(null, '', '/');
  });
});

describe('endpoints under a prefixed base href', () => {
  let base: HTMLBaseElement;

  beforeEach(() => {
    base = document.createElement('base');
    base.href = `${window.location.origin}/panel/canopy/trace/correlation.html`;
    document.head.appendChild(base);
  });

  afterEach(() => {
    base.remove();
  });

  it('Hare and Formula Engine WebSockets live beside trace/', () => {
    const host = window.location.host;
    expect(hareServiceOptions()).toMatchObject({
      url: `ws://${host}/panel/canopy/hare/v1/ws/pvs`,
      terminalCloseCodes: [],
    });
    expect(formulaEngineServiceOptions()).toMatchObject({
      baseUrl: '/panel/canopy',
      wsUrl: `ws://${host}/panel/canopy/formula-engine/v1/ws/formulas`,
      terminalCloseCodes: [],
    });
  });

  it('Mole search goes to <prefix>/mole/v1/search, not the origin root', async () => {
    expect(canopyConnection.baseUrl).toBe('/panel/canopy');
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ archiver: 'a', pattern: 'SIM:BPM', pvs: [Y1, Y2] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(moleSearch()('SIM:BPM')).resolves.toEqual([Y1, Y2]);
      const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]), window.location.href);
      expect(url.origin).toBe(window.location.origin);
      expect(url.pathname).toBe('/panel/canopy/mole/v1/search');
      // Mole fullmatches, so a plain fragment is wrapped as Trace does.
      expect(url.searchParams.get('pattern')).toBe('.*SIM:BPM.*');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
