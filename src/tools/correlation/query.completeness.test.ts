// The Correlation completeness test: every
// setting at a non-default value survives serialize -> parse, and eight Ys
// with long labels keep all eight Ys under 4 KB. Drawing ids are session-only
// (the `ann=` decoder issues fresh ones), so drawings compare without them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../annotations/model';
import {
  defaultCorrelationState,
  MAX_LABEL_LENGTH,
  MAX_QUERY_BYTES,
  MAX_Y,
  normalizeCorrelationState,
  parseCorrelationQuery,
  serializeCorrelationQuery,
  type CorrelationState,
} from './query';
import { autoYColor } from '../shared/colors';

const X = 'SIM:DIAG:BPM:01:POSITION:X';
const T = 'SIM:TIMING:TRIGGER';
const ys = Array.from({ length: 3 }, (_, i) => `SIM:DIAG:BPM:0${i + 2}:POSITION:X`);

// Every field of the state, each off its default.
function everything(): CorrelationState {
  return normalizeCorrelationState({
    x: X,
    ys,
    trigger: { mode: 'pv', pv: T },
    n: 250,
    lookback: '2h',
    view: 'density',
    axes: 'split',
    dy: ys[1],
    labels: { [X]: 'Horizontal & position', [ys[0]]: 'BPM 2 = first', [ys[2]]: '' },
    colors: { [ys[0]]: '#ff8800', [ys[2]]: 'rgb(1, 2, 3)' },
    hidden: { [ys[1]]: true, [ys[2]]: true },
    markers: {
      [ys[0]]: { shape: 'diamond', size: 12, opacity: 0.25 },
      [ys[1]]: { opacity: 0.5 },
      [ys[2]]: { shape: 'roundRect', size: 1 },
    },
    fit: false,
    readout: true,
    dist: true,
    legend: false,
    grid: false,
    crosshair: true,
    fade: true,
    tooltip: false,
    drag: 'pan',
    fire: 'falling',
    xScale: { auto: false, min: -2.5, max: 1e-3, log: true },
    yScale: { auto: false, min: 10, max: 2e21 },
    metrics: [
      { id: 'r', label: 'r', expr: 'corr(x, y)', unit: '', on: true, strip: true },
      { id: 'c1', label: 'Spread & %', expr: 'std(y) / mean(y)', unit: '', on: true, strip: false },
      { id: 'mean', label: 'mean', expr: 'mean(y)', unit: 'y', on: false, strip: true },
      { id: 'c2', label: 'Gain', expr: 'slope(x, y) * 1e3', unit: 'y/x', on: false, strip: false },
    ],
    drawings: [
      {
        id: 'annotation-1',
        kind: 'trend',
        points: [
          { t: -1.25, v: 0.5 },
          { t: 2.5, v: 3 },
        ],
        axisId: ys[0],
        traceId: ys[0],
        color: '#112233',
        width: 2,
        text: 'slope & fit',
        extend: 'right',
        xRef: X,
      },
      {
        id: 'annotation-2',
        kind: 'note',
        points: [{ t: 0.75, v: -4 }],
        // A Y no longer in `ys` keeps its drawing.
        axisId: 'SIM:DIAG:BPM:99:POSITION:X',
        color: '#445566',
        width: 1.5,
        text: 'removed Y',
        locked: true,
        xRef: X,
      },
    ],
  });
}

const noIds = (s: CorrelationState): CorrelationState => ({
  ...s,
  drawings: s.drawings.map(({ id: _id, ...rest }) => (void _id, rest) as Annotation),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Correlation completeness', () => {
  it('the fixture sets every setting of the state off its default', () => {
    const full = everything();
    const defaults = defaultCorrelationState() as unknown as Record<string, unknown>;
    const optional = ['fire', 'xScale', 'yScale'];
    expect(full.drawings).toHaveLength(2);
    expect(Object.keys(full).sort()).toEqual([...Object.keys(defaults), ...optional].sort());
    for (const [key, value] of Object.entries(full)) {
      expect(value, key).not.toEqual(defaults[key]);
    }
  });

  it('every setting at a non-default value round-trips: serialize -> parse -> same value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const full = everything();
    const back = noIds(parseCorrelationQuery(serializeCorrelationQuery(full)));
    const want = noIds(full);
    for (const key of Object.keys(want) as (keyof CorrelationState)[]) {
      expect(back[key], key).toEqual(want[key]);
    }
    expect(back).toEqual(want);
    expect(warn).not.toHaveBeenCalled();
  });

  it('round-trips the other trigger edge, a Timer period, and Y on X', () => {
    const cases: CorrelationState[] = [
      { ...everything(), fire: 'rising' },
      normalizeCorrelationState({ ...everything(), trigger: { mode: 'timer', dtS: 0.5 } }),
      normalizeCorrelationState({
        ...everything(),
        ys: [ys[0], X],
        labels: { [X]: 'shared label' },
        colors: { [X]: '#010203' },
      }),
    ];
    for (const s of cases) {
      expect(noIds(parseCorrelationQuery(serializeCorrelationQuery(s)))).toEqual(noIds(s));
    }
  });

  it('an explicitly picked positional colour round-trips as a record (its dot stays on)', () => {
    const s = normalizeCorrelationState({
      ...defaultCorrelationState(),
      x: X,
      ys,
      colors: { [ys[1]]: autoYColor(1) },
    });
    const q = serializeCorrelationQuery(s);
    expect(q).toContain('c2=');
    expect(parseCorrelationQuery(q).colors).toEqual({ [ys[1]]: autoYColor(1) });
  });

  it('a query written from a canonical state reads back to the same query', () => {
    const q = serializeCorrelationQuery(everything());
    expect(serializeCorrelationQuery(parseCorrelationQuery(q))).toBe(q);
  });

  it('eight Ys with long labels keep all eight Ys under 4 KB', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const eight = Array.from(
      { length: MAX_Y },
      (_, i) => `SIM:C${String(i + 1).padStart(2, '0')}:DIAG:BPM:${i + 1}:POSITION:HORIZONTAL:MM`
    );
    // Labels at the 80-character cap, of characters that percent-encode to 9 bytes.
    const long = (i: number) => `${i}${'€'.repeat(MAX_LABEL_LENGTH - 1)}`;
    const s = normalizeCorrelationState({
      ...defaultCorrelationState(),
      x: X,
      ys: eight,
      labels: Object.fromEntries([X, ...eight].map((pv, i) => [pv, long(i)])),
      colors: Object.fromEntries(eight.map((pv, i) => [pv, autoYColor(i)])),
      markers: Object.fromEntries(eight.map((pv) => [pv, { shape: 'triangle' as const, size: 7 }])),
      hidden: { [eight[7]]: true },
    });
    const q = serializeCorrelationQuery(s);
    expect(new TextEncoder().encode(q).length).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    const back = parseCorrelationQuery(q);
    expect(back.ys).toEqual(eight);
    expect(back.x).toBe(X);
    // Labels went first, so the colours, markers and hide survived.
    expect(back.colors).toEqual(s.colors);
    expect(back.markers).toEqual(s.markers);
    expect(back.hidden).toEqual(s.hidden);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
