import { defaultMetrics } from '../../statistics/model';
import { WAVEFORM_METRICS } from './metrics';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_TOOLS, makeCatalog, WAVEFORM_CATALOG } from '../../annotations/catalog';
import type { DrawingTool } from '../../annotations/catalog/types';
import type { Annotation } from '../../annotations/model';
import {
  DEFAULT_DEC,
  defaultWaveformState,
  MAX_LIVE,
  MAX_PERSIST,
  MAX_QUERY_BYTES,
  normalizeWaveformState,
  parseWaveformQuery,
  serializeWaveformQuery,
  serializeWaveformQueryWithShed,
  type WaveformState,
} from './query';

const A = 'SIM:WF:X';
const B = 'SIM:WF:Y';
const C = 'SIM:COR:WF';
const R = 'SIM:WF:GOLDEN';
const S = 'SIM:WF:S';

function state(over: Partial<WaveformState> = {}): WaveformState {
  return { ...defaultWaveformState(), ...over };
}

function silenceWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseWaveformQuery', () => {
  it('opens the defaults from an empty query without a warning', () => {
    const warn = silenceWarn();
    expect(parseWaveformQuery('')).toEqual(defaultWaveformState());
    expect(parseWaveformQuery('?')).toEqual(defaultWaveformState());
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads repeated pv= keys in order, deduplicated, capped at 8', () => {
    const warn = silenceWarn();
    const pvs = Array.from({ length: 10 }, (_, i) => `WF:${i}`);
    const q = [A, A, ...pvs].map((p) => `pv=${p}`).join('&');
    const s = parseWaveformQuery(q);
    expect(s.pvs).toEqual([A, ...pvs.slice(0, MAX_LIVE - 1)]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads ref as a PV reference and xs as the X source', () => {
    const s = parseWaveformQuery(`pv=${A}&ref=${R}&xs=${S}`);
    expect(s.reference).toEqual({ kind: 'pv', pv: R });
    expect(s.xs).toBe(S);
  });

  it('keeps a PV in at most one section: live wins over reference and X source', () => {
    const s = parseWaveformQuery(`pv=${A}&ref=${A}&xs=${A}`);
    expect(s.pvs).toEqual([A]);
    expect(s.reference).toBeNull();
    expect(s.xs).toBe('');
    const t = parseWaveformQuery(`pv=${A}&ref=${R}&xs=${R}`);
    expect(t.reference).toEqual({ kind: 'pv', pv: R });
    expect(t.xs).toBe('');
  });

  it('ignores delta without a reference', () => {
    expect(parseWaveformQuery(`pv=${A}&delta=1`).delta).toBe(false);
    expect(parseWaveformQuery(`pv=${A}&ref=${R}&delta=1`).delta).toBe(true);
  });

  it('accepts persistence 1..16 only and average 1..64', () => {
    const warn = silenceWarn();
    expect(parseWaveformQuery('persist=16').persist).toBe(16);
    expect(parseWaveformQuery('persist=17').persist).toBe(1);
    expect(parseWaveformQuery('persist=0').persist).toBe(1);
    expect(parseWaveformQuery('avg=64').avg).toBe(64);
    expect(parseWaveformQuery('avg=65').avg).toBe(1);
    expect(parseWaveformQuery('avg=2.5').avg).toBe(1);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it('reads element ranges with either side open, refusing first > last', () => {
    const warn = silenceWarn();
    expect(parseWaveformQuery('elems=10:20').elems).toEqual({ first: 10, last: 20 });
    expect(parseWaveformQuery('elems=10:').elems).toEqual({ first: 10 });
    expect(parseWaveformQuery('elems=:20').elems).toEqual({ last: 20 });
    expect(parseWaveformQuery('elems=:').elems).toBeNull();
    expect(parseWaveformQuery('elems=20:10').elems).toBeNull();
    expect(parseWaveformQuery('elems=a:b').elems).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('reads decimation 0 or 256..100000 and an update cap of 1..10 Hz', () => {
    const warn = silenceWarn();
    expect(parseWaveformQuery('dec=0').dec).toBe(0);
    expect(parseWaveformQuery('dec=1000').dec).toBe(1000);
    expect(parseWaveformQuery('dec=100').dec).toBe(DEFAULT_DEC);
    expect(parseWaveformQuery('hz=2').hz).toBe(2);
    expect(parseWaveformQuery('hz=11').hz).toBe(10);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('warns once per parse naming every invalid key', () => {
    const warn = silenceWarn();
    parseWaveformQuery('persist=x&avg=y&hz=z&draw=nope&legend=maybe');
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0][0]);
    for (const key of ['persist', 'avg', 'hz', 'draw', 'legend']) expect(text).toContain(key);
  });

  it('ignores unknown keys and page keys', () => {
    const warn = silenceWarn();
    expect(parseWaveformQuery('theme=dark&embedded=true&foo=1')).toEqual(defaultWaveformState());
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects a query over 4 KB as a whole', () => {
    const warn = silenceWarn();
    const s = parseWaveformQuery(`pv=${A}&xl=${'x'.repeat(MAX_QUERY_BYTES)}`);
    expect(s).toEqual(defaultWaveformState());
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads plot= traces positionally: live entries, then one for the reference PV', () => {
    const plot = JSON.stringify({
      v: 1,
      traces: [{ color: '#ff0000' }, { displayName: 'Y' }, { lineWidth: 3 }],
    });
    const s = parseWaveformQuery(`pv=${A}&pv=${B}&ref=${R}&plot=${encodeURIComponent(plot)}`);
    expect(s.styles).toEqual({
      [A]: { color: '#ff0000' },
      [B]: { label: 'Y' },
      [R]: { width: 3 },
    });
  });

  it('reads and writes Trace’s dash-dot patterns and widths up to 20 in plot=', () => {
    const plot = JSON.stringify({
      v: 1,
      traces: [
        { lineStyle: 'dashDot', lineWidth: 15 },
        { lineStyle: 'dashDotDot', lineWidth: 99 },
      ],
    });
    const s = parseWaveformQuery(`pv=${A}&pv=${B}&plot=${encodeURIComponent(plot)}`);
    expect(s.styles).toEqual({
      [A]: { lineStyle: 'dashDot', width: 15 },
      [B]: { lineStyle: 'dashDotDot', width: 20 },
    });
    expect(parseWaveformQuery(serializeWaveformQuery(s)).styles).toEqual(s.styles);
  });

  it('drops a malformed plot= with one warning and keeps the PVs', () => {
    const warn = silenceWarn();
    const s = parseWaveformQuery(`pv=${A}&plot=%7Bnot-json`);
    expect(s.pvs).toEqual([A]);
    expect(s.styles).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops invalid style fields', () => {
    silenceWarn();
    const plot = JSON.stringify({
      traces: [
        { lineType: 'zigzag', lineWidth: -1, lineStyle: 'wavy', color: 7, displayName: 'ok' },
      ],
    });
    const s = parseWaveformQuery(`pv=${A}&plot=${encodeURIComponent(plot)}`);
    expect(s.styles).toEqual({ [A]: { label: 'ok' } });
  });

  it.each(['red;background:url(x)', 'expression(alert(1))', 'url(x)', 'red'])(
    'gives a curve its automatic colour for the unsafe colour %s',
    (color) => {
      silenceWarn();
      const plot = JSON.stringify({ traces: [{ color, displayName: 'ok' }] });
      const s = parseWaveformQuery(`pv=${A}&plot=${encodeURIComponent(plot)}`);
      expect(s.styles).toEqual({ [A]: { label: 'ok' } });
    }
  );

  it.each(['#abc', 'rgb(1,2,3)', 'rgba(1, 2, 3, 0.5)'])('keeps the colour literal %s', (color) => {
    const plot = JSON.stringify({ traces: [{ color }] });
    const s = parseWaveformQuery(`pv=${A}&plot=${encodeURIComponent(plot)}`);
    expect(s.styles).toEqual({ [A]: { color } });
  });

  it('reads hide= for live and reference curves only', () => {
    const s = parseWaveformQuery(`pv=${A}&pv=${B}&ref=${R}&hide=${B}&hide=${R}&hide=${C}`);
    expect(s.hidden).toEqual({ [B]: true, [R]: true });
  });
});

describe('serializeWaveformQuery', () => {
  it('writes nothing for the default state', () => {
    expect(serializeWaveformQuery(defaultWaveformState())).toBe('');
  });

  it('writes live PVs as repeated pv= keys with ":" left readable', () => {
    expect(serializeWaveformQuery(state({ pvs: [A, B] }))).toBe(`pv=${A}&pv=${B}`);
  });

  it('writes delta=1 only together with ref=', () => {
    const withPv = state({ pvs: [A], reference: { kind: 'pv', pv: R }, delta: true });
    expect(serializeWaveformQuery(withPv)).toBe(`pv=${A}&ref=${R}&delta=1`);
    const snap = state({
      pvs: [A],
      reference: { kind: 'snapshot', frames: { [A]: new Float64Array([1, 2]) }, time: 1 },
      delta: true,
    });
    expect(serializeWaveformQuery(snap)).toBe(`pv=${A}`);
  });

  it('never serializes a snapshot or its style', () => {
    const snap = state({
      pvs: [A],
      reference: {
        kind: 'snapshot',
        frames: { [A]: new Float64Array(500).fill(1.25) },
        time: 1_700_000_000_000,
        style: { color: '#123456', label: 'golden' },
      },
    });
    const q = serializeWaveformQuery(snap);
    expect(q).toBe(`pv=${A}`);
    expect(q).not.toContain('1.25');
    expect(q).not.toContain('golden');
  });

  it('writes a colour iff its record exists', () => {
    const q = serializeWaveformQuery(state({ pvs: [A, B], styles: { [B]: { color: '#00ff00' } } }));
    const plot = JSON.parse(new URLSearchParams(q).get('plot') as string);
    expect(plot.traces).toEqual([{}, { color: '#00ff00' }]);
    expect(serializeWaveformQuery(state({ pvs: [A, B], styles: { [A]: {} } }))).not.toContain(
      'plot='
    );
  });

  it('trims trailing empty trace entries and places the reference after the live ones', () => {
    const q = serializeWaveformQuery(
      state({ pvs: [A, B], reference: { kind: 'pv', pv: R }, styles: { [R]: { width: 2 } } })
    );
    const plot = JSON.parse(new URLSearchParams(q).get('plot') as string);
    expect(plot.traces).toEqual([{}, {}, { lineWidth: 2 }]);
  });

  it('prunes styles and hidden of PVs not in Live or Reference', () => {
    const q = serializeWaveformQuery(
      state({ pvs: [A], xs: S, styles: { [S]: { color: '#000000' } }, hidden: { [S]: true } })
    );
    expect(q).toBe(`pv=${A}&xs=${S}`);
  });

  it('writes roll= for a rolling reference, delta=1 with it, and spread= off its default', () => {
    const rolling = normalizeWaveformState(
      state({ pvs: [A], reference: { kind: 'rolling', seconds: 90 }, delta: true, spread: 2 })
    );
    const query = serializeWaveformQuery(rolling);
    expect(query).toContain('roll=90');
    expect(query).toContain('delta=1');
    expect(query).toContain('spread=2');
    expect(query).not.toContain('ref=');
    expect(parseWaveformQuery(query)).toEqual(rolling);
    // The default band (±1σ) and a snapshot's σ are not written.
    expect(serializeWaveformQuery(state({ pvs: [A], spread: 1 }))).toBe(`pv=${A}`);
    const warn = silenceWarn();
    expect(parseWaveformQuery('pv=A&roll=0').reference).toBeNull();
    expect(parseWaveformQuery('pv=A&spread=7').spread).toBe(1);
    expect(warn).toHaveBeenCalled();
    // One reference: roll wins over ref, and the dropped ref is reported.
    warn.mockClear();
    expect(parseWaveformQuery(`pv=${A}&ref=${R}&roll=30`).reference).toEqual({
      kind: 'rolling',
      seconds: 30,
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('normalizes a frozen snapshot: σ kept only for a frame of its length, the window clamped', () => {
    const s = normalizeWaveformState(
      state({
        pvs: [A, B],
        reference: {
          kind: 'snapshot',
          frames: { [A]: new Float64Array(4), [B]: new Float64Array(4) },
          spread: {
            [A]: new Float64Array(4),
            [B]: new Float64Array(3),
            'WF:Z': new Float64Array(4),
          },
          time: 1,
          rolling: 99_999,
        },
      })
    );
    const ref = s.reference;
    expect(ref?.kind === 'snapshot' ? Object.keys(ref.spread!) : null).toEqual([A]);
    expect(ref?.kind === 'snapshot' ? ref.rolling : null).toBe(3600);
  });

  it('round-trips through parse', () => {
    const s = normalizeWaveformState(
      state({
        pvs: [A, B],
        reference: { kind: 'pv', pv: R },
        xs: S,
        delta: true,
        persist: 4,
        stats: true,
        dist: true,
        styles: { [A]: { color: '#abcdef', lineType: 'step' } },
      })
    );
    const query = serializeWaveformQuery(s);
    expect(query).toContain('stats=1');
    expect(query).toContain('dist=1');
    expect(parseWaveformQuery(query)).toEqual(s);
  });

  it('over 4 KB sheds labels first, then the whole plot, then trailing live PVs; never ref or xs', () => {
    const warn = silenceWarn();
    const long = (n: number) => `SIM:${'W'.repeat(n - 1)}`;
    // Eight long Live PVs fit only once their 80-character labels are shed.
    const longPvs = Array.from({ length: 8 }, (_, i) => `${long(360)}:${i}`);
    const big = state({
      pvs: longPvs,
      styles: Object.fromEntries(
        longPvs.map((p) => [p, { label: 'L'.repeat(80), color: '#ff0000' }])
      ),
      xs: S,
      xLabel: 'X'.repeat(80),
      reference: { kind: 'pv', pv: R },
    });
    expect(serializeWaveformQuery({ ...big, styles: {}, xLabel: undefined }).length).toBeLessThan(
      MAX_QUERY_BYTES
    );
    const q = serializeWaveformQuery(big);
    expect(new TextEncoder().encode(q).length).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    const params = new URLSearchParams(q);
    expect(params.get('ref')).toBe(R);
    expect(params.get('xs')).toBe(S);
    expect(params.getAll('pv').length).toBe(8);
    const plot = JSON.parse(params.get('plot') as string);
    expect(plot.traces.every((t: Record<string, unknown>) => t.displayName === undefined)).toBe(
      true
    );
    expect(plot.traces[0].color).toBe('#ff0000');
    expect(params.get('xl')).toBeNull();
    expect(warn).toHaveBeenCalled();

    const huge = Array.from({ length: 8 }, (_, i) => `${long(600)}:${i}`);
    const q2 = serializeWaveformQuery(
      state({ pvs: huge, xs: S, reference: { kind: 'pv', pv: R }, hidden: { [huge[7]]: true } })
    );
    const p2 = new URLSearchParams(q2);
    expect(new TextEncoder().encode(q2).length).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    expect(p2.getAll('pv')).toEqual(huge.slice(0, p2.getAll('pv').length));
    expect(p2.getAll('pv').length).toBeLessThan(8);
    expect(p2.getAll('hide')).toEqual([]);
    expect(p2.get('ref')).toBe(R);
    expect(p2.get('xs')).toBe(S);
  });
});

describe('statistics metrics (m=)', () => {
  it('writes m= tokens only off the default, all of them, and reads them back', () => {
    const base = normalizeWaveformState({ ...defaultWaveformState(), pvs: [A] });
    expect(serializeWaveformQuery(base)).not.toContain('m=');
    const metrics = defaultMetrics(WAVEFORM_METRICS).map((m) =>
      m.id === 'rms' ? { ...m, strip: true } : m
    );
    metrics.push({
      id: 'c1',
      label: 'noise',
      expr: 'std(y-mean(y))',
      unit: 'y',
      on: true,
      strip: false,
    });
    const q = serializeWaveformQuery({ ...base, metrics });
    expect(q).toContain('m=n&m=mean&m=std&m=~rms&m=p2p&m=-min');
    expect(q).toContain('m=noise%3Dstd(y-mean(y))%3Dy');
    expect(parseWaveformQuery(q).metrics).toEqual(metrics);
  });

  it('drops a bad token with one warning and keeps the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = parseWaveformQuery(`pv=${A}&m=mean&m=bogus&m=~n`);
    expect(s.metrics.map((m) => [m.id, m.strip])).toEqual([
      ['mean', false],
      ['n', true],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('m');
    warn.mockRestore();
  });
});

describe('normalizeWaveformState', () => {
  it('is idempotent', () => {
    const s = state({
      pvs: [` ${A} `, A, B],
      reference: { kind: 'pv', pv: B },
      xs: A,
      styles: { [A]: { label: 'a' }, [C]: { color: '#000' } },
      hidden: { [B]: true, [C]: true },
      persist: 99,
    });
    const once = normalizeWaveformState(s);
    expect(normalizeWaveformState(once)).toEqual(once);
    expect(once.pvs).toEqual([A, B]);
    expect(once.reference).toBeNull();
    expect(once.xs).toBe('');
    expect(once.styles).toEqual({ [A]: { label: 'a' } });
    expect(once.hidden).toEqual({ [B]: true });
    expect(once.persist).toBe(MAX_PERSIST);
  });

  it('keeps the reference PV style and hidden flag; keeps a snapshot as-is', () => {
    const frames = { [A]: new Float64Array([1]) };
    const s = normalizeWaveformState(
      state({
        pvs: [A],
        reference: { kind: 'snapshot', frames, time: 5, style: { color: '#111111' } },
        delta: true,
      })
    );
    expect(s.reference).toEqual({ kind: 'snapshot', frames, time: 5, style: { color: '#111111' } });
    expect(s.reference?.kind === 'snapshot' && s.reference.frames).toBe(frames);
    expect(s.delta).toBe(true);
  });

  it('clears delta when there is no reference and drops xLabel without an X source', () => {
    const s = normalizeWaveformState(state({ pvs: [A], delta: true, xLabel: 'pos' }));
    expect(s.delta).toBe(false);
    expect(s.xLabel).toBeUndefined();
  });
});

// ------------------------------------------------------------ drawings

const bytes = (q: string) => new TextEncoder().encode(q).length;

function drawing(i: number, extra: Partial<Annotation> = {}): Annotation {
  return {
    id: `annotation-${i}`,
    kind: 'hline',
    points: [{ t: 0, v: i + 0.5 }],
    axisId: 'y',
    color: '#123456',
    width: 1.5,
    text: '',
    ...extra,
  };
}

// The drawings without their ids (regenerated when a link is read).
const noIds = (list: readonly Annotation[]) => list.map(({ id: _id, ...rest }) => (void _id, rest));

function annOf(query: string): { r: string[]; b: unknown[]; d: unknown[][] } | null {
  const ann = new URLSearchParams(query).get('ann');
  return ann === null ? null : JSON.parse(ann);
}

describe('drawings in the link (ann=)', () => {
  it('writes no ann= without drawings, and the default state still writes nothing', () => {
    expect(serializeWaveformQuery(defaultWaveformState())).toBe('');
    expect(serializeWaveformQuery(state({ pvs: [A] }))).toBe(`pv=${A}`);
  });

  it("round-trips drawings: axis reference 'y', magnet traces by curve PV, xRef/Δ bindings", () => {
    const list = [
      drawing(0, { text: 'floor' }),
      drawing(1, {
        kind: 'note',
        points: [{ t: 3.25, v: 2 }],
        traceId: B,
        text: 'kick',
        xRef: `src:${S}`,
        delta: true,
      }),
      drawing(2, { kind: 'vline', points: [{ t: 17, v: 0 }], xRef: 'index' }),
    ];
    const s = state({
      pvs: [A, B],
      reference: { kind: 'pv', pv: R },
      delta: true,
      xs: S,
      drawings: list,
    });
    const q = serializeWaveformQuery(s);
    expect(q.endsWith(`ann=${new URLSearchParams(q).get('ann')}`) || q.includes('&ann=')).toBe(
      true
    );
    const value = annOf(q)!;
    expect(value.r).toEqual(['y', B]);
    expect(value.b).toEqual([{ x: `src:${S}`, d: 1 }, { x: 'index' }]);
    const back = parseWaveformQuery(q);
    expect(noIds(back.drawings)).toEqual(noIds(list));
    expect(back.drawings.every((a) => a.axisId === 'y')).toBe(true);
  });

  it('keeps draw= as the Reference drawing style, apart from the drawings', () => {
    const s = state({
      pvs: [A],
      reference: { kind: 'pv', pv: R },
      drawAs: 'band',
      drawings: [drawing(0)],
    });
    const q = serializeWaveformQuery(s);
    expect(new URLSearchParams(q).get('draw')).toBe('band');
    const back = parseWaveformQuery(q);
    expect(back.drawAs).toBe('band');
    expect(back.drawings).toHaveLength(1);
  });

  it('drops a drawing whose axis reference is not y, with one warning', () => {
    const warn = silenceWarn();
    const ann = JSON.stringify({
      r: ['y', 'TEST:OTHER'],
      b: [],
      d: [
        [0, [1], 0, null],
        [0, [2], 1, null],
      ],
    });
    const back = parseWaveformQuery(`pv=${A}&ann=${encodeURIComponent(ann)}`);
    expect(back.drawings.map((a) => a.points[0].v)).toEqual([1]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('snapshot + Δ: the Δ drawing is not written and is counted as dropped', () => {
    const s = state({
      pvs: [A],
      reference: { kind: 'snapshot', frames: { [A]: new Float64Array([1, 2]) }, time: 1 },
      delta: true,
      drawings: [drawing(0, { delta: true, xRef: 'index' })],
    });
    const { query, shed } = serializeWaveformQueryWithShed(s);
    expect(query).not.toContain('ann=');
    expect(query).toBe(`pv=${A}`);
    expect(shed).toEqual({ dropped: 1, trimmed: 0 });
    // Against a PV reference the same drawing is written.
    const byPv = serializeWaveformQueryWithShed({ ...s, reference: { kind: 'pv', pv: R } });
    expect(byPv.query).toContain('ann=');
    expect(byPv.shed).toEqual({ dropped: 0, trimmed: 0 });
  });

  it('page keys: a link shed to fit with the page keys reloads with its drawings', () => {
    const warn = silenceWarn();
    const pageKeys = 'theme=dark&embedded=true';
    const reserve = bytes(pageKeys) + 1;
    const long = (i: number) => `SIM:${'P'.repeat(299)}:${i}`;
    const pvs = Array.from({ length: 8 }, (_, i) => long(i));
    const list = Array.from({ length: 64 }, (_, i) =>
      drawing(i, { kind: 'note', points: [{ t: i, v: i }], traceId: pvs[i % 8], text: `n${i}` })
    );
    const s = state({ pvs, xs: S, reference: { kind: 'pv', pv: R }, drawings: list });
    const { query, shed } = serializeWaveformQueryWithShed(s, { reserve });
    expect(annOf(query)).not.toBeNull();
    expect(shed.dropped).toBeGreaterThan(0);
    const link = `${pageKeys}&${query}`;
    expect(bytes(link)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    // Drawings go before any Live PV: every PV, ref and xs are still there.
    const params = new URLSearchParams(query);
    expect(params.getAll('pv')).toEqual(pvs);
    expect(params.get('ref')).toBe(R);
    expect(params.get('xs')).toBe(S);

    warn.mockClear();
    const back = parseWaveformQuery(`?${link}`);
    expect(warn).not.toHaveBeenCalled();
    expect(back.pvs).toEqual(pvs);
    expect(back.drawings).toHaveLength(list.length - shed.dropped);
    // Their note text was emptied to make room; everything else is kept.
    expect(shed.trimmed).toBe(back.drawings.length);
    const noText = (l: readonly Annotation[]) => noIds(l).map((a) => ({ ...a, text: '' }));
    expect(noText(back.drawings)).toEqual(noText(list.slice(0, back.drawings.length)));
  });

  it('sheds labels and the plot before any drawing, and trims notes before dropping', () => {
    const warn = silenceWarn();
    const long = (i: number) => `SIM:${'Q'.repeat(379)}:${i}`;
    const pvs = Array.from({ length: 8 }, (_, i) => long(i));
    const list = Array.from({ length: 3 }, (_, i) =>
      drawing(i, { kind: 'note', points: [{ t: i, v: i }], text: 'x'.repeat(400) })
    );
    const s = state({
      pvs,
      styles: Object.fromEntries(pvs.map((p) => [p, { label: 'L'.repeat(80), color: '#ff0000' }])),
      drawings: list,
    });
    const { query, shed } = serializeWaveformQueryWithShed(s, { reserve: 30 });
    expect(bytes(query) + 30).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    const params = new URLSearchParams(query);
    expect(params.get('plot')).toBeNull();
    expect(params.getAll('pv')).toEqual(pvs);
    expect(shed).toEqual({ dropped: 0, trimmed: 3 });
    const back = parseWaveformQuery(query);
    expect(back.drawings).toHaveLength(3);
    expect(back.drawings.every((a) => [...a.text].length <= 25)).toBe(true);
    // The state's own text is never trimmed.
    expect(s.drawings[0].text).toHaveLength(400);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('an over-budget incoming link is retried without ann= before falling back to defaults', () => {
    const warn = silenceWarn();
    const ann = encodeURIComponent(
      JSON.stringify({ r: ['y'], b: [], d: [[0, [1], 0, null, '', 'z'.repeat(5000)]] })
    );
    const q = `pv=${A}&persist=4&ann=${ann}&draw=band`;
    expect(bytes(q)).toBeGreaterThan(MAX_QUERY_BYTES);
    const back = parseWaveformQuery(q);
    expect(back.pvs).toEqual([A]);
    expect(back.persist).toBe(4);
    expect(back.drawAs).toBe('band');
    expect(back.drawings).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    // Still over without ann=: the defaults open, as before drawings.
    const huge = `pv=${'W'.repeat(5000)}&ann=${ann}`;
    expect(parseWaveformQuery(huge)).toEqual(defaultWaveformState());
  });

  it("a test catalog's tool round-trips; a catalog without it drops it", () => {
    const PIN: DrawingTool = {
      ...BUILTIN_TOOLS.find((t) => t.kind === 'note')!,
      kind: 'pin',
      code: 901,
      label: { long: 'Pin marker', short: 'Pin' },
      key: undefined,
      menuAdd: undefined,
    };
    const catalog = makeCatalog([...WAVEFORM_CATALOG.tools, PIN]);
    const pin = drawing(0, { kind: 'pin', points: [{ t: 4, v: 5 }], text: 'here', traceId: A });
    const s = normalizeWaveformState(state({ pvs: [A], drawings: [pin] }), catalog);
    expect(s.drawings).toEqual([pin]);
    const q = serializeWaveformQuery(s, { catalog });
    expect(annOf(q)!.d[0][0]).toBe(901);
    const back = parseWaveformQuery(q, { catalog });
    expect(noIds(back.drawings)).toEqual(noIds([pin]));

    const warn = silenceWarn();
    expect(parseWaveformQuery(q).drawings).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe('normalizeWaveformState preserves references', () => {
  it('returns a canonical state as is', () => {
    const s = normalizeWaveformState(
      state({ pvs: [A, B], styles: { [A]: { color: '#000000' } }, drawings: [drawing(0)] })
    );
    expect(normalizeWaveformState(s)).toBe(s);
    const d = defaultWaveformState();
    expect(normalizeWaveformState(d)).toBe(d);
  });

  it('a settings change keeps drawings and every untouched field by reference', () => {
    const s = normalizeWaveformState(
      state({ pvs: [A], hidden: { [A]: true }, drawings: [drawing(0), drawing(1)] })
    );
    const next = normalizeWaveformState({ ...s, persist: 4 });
    expect(next).not.toBe(s);
    expect(next.persist).toBe(4);
    for (const key of ['pvs', 'drawings', 'hidden', 'styles', 'metrics'] as const) {
      expect(next[key], key).toBe(s[key]);
    }
  });

  it('a drawing change keeps the unchanged drawings and every other field by reference', () => {
    const s = normalizeWaveformState(state({ pvs: [A], drawings: [drawing(0), drawing(1)] }));
    const moved = { ...s.drawings[1], points: [{ t: 0, v: 9 }] };
    const next = normalizeWaveformState({ ...s, drawings: [s.drawings[0], moved] });
    expect(next.drawings[0]).toBe(s.drawings[0]);
    expect(next.drawings[1]).toBe(moved);
    for (const key of ['pvs', 'reference', 'metrics', 'hidden', 'styles'] as const) {
      expect(next[key], key).toBe(s[key]);
    }
  });

  it('drops a drawing the catalog does not know, keeping the rest', () => {
    const warn = silenceWarn();
    const s = normalizeWaveformState(
      state({ drawings: [drawing(0), drawing(1, { kind: 'trange' }), drawing(2)] })
    );
    expect(s.drawings.map((a) => a.id)).toEqual(['annotation-0', 'annotation-2']);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
